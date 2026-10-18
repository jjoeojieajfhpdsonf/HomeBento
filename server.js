"use strict";
// Service Dashboard – a dependency-free dashboard for the services at home:
// status with history, Docker actions, and tiles that show what each service is doing.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const { Store } = require("./lib/store");
const { Monitor } = require("./lib/monitor");
const { Docker } = require("./lib/docker");
const { Host } = require("./lib/host");
const { Integrations } = require("./lib/integrations");
const { Auth } = require("./lib/auth");
const { KINDS } = require("./lib/kinds");
const { UserError } = require("./lib/errors");
const { request } = require("./lib/util");

const PORT = Number(process.env.PORT) || 8095;
const HOST = process.env.HOST || "0.0.0.0";
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, "data"));
const PUBLIC = path.join(__dirname, "public");
const VERSION = require("./package.json").version;
const CHECK_SECONDS = Math.max(15, Number(process.env.CHECK_SECONDS) || 60);
const NOTIFY_URL = process.env.NOTIFY_URL || ""; // e.g. https://ntfy.sh/my-topic

fs.mkdirSync(DATA_DIR, { recursive: true });
const store = new Store(DATA_DIR);
const docker = new Docker();
const host = new Host();
const integrations = new Integrations(store);
const auth = new Auth(process.env.PASSWORD, DATA_DIR);
const monitor = new Monitor({ store, docker, dataDir: DATA_DIR, interval: CHECK_SECONDS, onChange: notify });

// A message when a service goes down or comes back (ntfy-style: POST text to NOTIFY_URL).
function notify(ev, s) {
	if (!NOTIFY_URL || ev.to === "slow" || ev.from === "slow" || ev.from === "pending") return;
	const text = ev.to === "down" ? `${s.name} is down${ev.detail ? `: ${ev.detail}` : ""}` : `${s.name} is up again`;
	request(NOTIFY_URL, { method: "POST", body: text, headers: { Title: "Service Dashboard", Tags: ev.to === "down" ? "warning" : "white_check_mark" } }).then((r) => {
		if (!r.status || r.status >= 400) console.error(`Notification failed: ${r.error || `HTTP ${r.status}`}`);
	});
}

// ---------- HTTP helpers ----------

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };

function send(req, res, status, body, type = "application/json; charset=utf-8", extra = {}) {
	let data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
	const headers = { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra };
	if (data.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "") && /json|text|javascript|svg|css/.test(type)) {
		data = zlib.gzipSync(data);
		headers["Content-Encoding"] = "gzip";
	}
	headers["Content-Length"] = data.length;
	res.writeHead(status, headers);
	res.end(data);
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on("data", (c) => {
			size += c.length;
			if (size > 1_000_000) {
				reject(new UserError("Request too large"));
				req.destroy();
			} else chunks.push(c);
		});
		req.on("end", () => {
			if (!chunks.length) return resolve({});
			try {
				resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
			} catch {
				reject(new UserError("Invalid JSON"));
			}
		});
		req.on("error", reject);
	});
}

function serveStatic(req, res, pathname) {
	const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
	const file = path.join(PUBLIC, rel);
	if (!file.startsWith(PUBLIC + path.sep)) return send(req, res, 404, "Not found", "text/plain");
	fs.readFile(file, (err, data) => {
		if (err) return send(req, res, 404, "Not found", "text/plain");
		send(req, res, 200, data, TYPES[path.extname(file)] || "application/octet-stream");
	});
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

// ---------- API ----------

route("GET", "/api/state", () => ({
	version: VERSION,
	config: store.public(),
	kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, tile: v.tile, fields: v.fields.map(({ key, label, help, secret }) => ({ key, label, help, secret: !!secret })) }])),
	docker: docker.available !== false,
	host: host.name,
	auth: auth.enabled,
	notify: !!NOTIFY_URL,
	checkSeconds: CHECK_SECONDS
}));

// Everything a board needs to show right now (polled every few seconds by the web app).
route("GET", "/api/live", async (body, p, query) => {
	const cfg = store.config;
	const board = cfg.boards.find((b) => b.id === query.get("board")) || cfg.boards[0];
	const types = new Set(board.tiles.map((t) => t.type));
	const status = {};
	for (const s of cfg.services) status[s.id] = monitor.summary(s.id);
	// services whose content is shown: their own tile, and content tiles (calendar = all Sonarr/Radarr)
	const wanted = new Set(board.tiles.filter((t) => t.service).map((t) => t.service));
	if (types.has("calendar")) for (const s of cfg.services) if (s.kind === "sonarr" || s.kind === "radarr") wanted.add(s.id);
	// a content tile without its own service shows the first matching one
	for (const t of board.tiles) if (!t.service && ["jellyfin", "downloads", "solar"].includes(t.type)) for (const s of cfg.services) if (s.kind && KINDS[s.kind].tile === t.type) wanted.add(s.id);
	const data = {};
	await Promise.all(
		cfg.services.filter((s) => wanted.has(s.id) && s.kind).map(async (s) => {
			const d = await integrations.data(s);
			if (d) data[s.id] = d;
		})
	);
	const hours = {};
	if (types.has("uptime") || types.has("status")) for (const s of cfg.services) hours[s.id] = monitor.hours(s.id, 24);
	return { at: Date.now(), status, data, hours, host: types.has("host") || types.has("status") ? host.stats() : null };
});

route("GET", "/api/services/:id", async (body, p) => {
	const s = store.service(p.id);
	const out = {
		status: monitor.summary(s.id),
		hours: monitor.hours(s.id, 24),
		days: days(s.id, 30),
		uptime: { day: monitor.uptime(s.id, 1), week: monitor.uptime(s.id, 7), month: monitor.uptime(s.id, 30) },
		events: monitor.eventsOf(s.id, 8),
		container: null
	};
	if (s.container && docker.available !== false) out.container = await docker.stats(s.container).catch((err) => ({ error: err.message }));
	return out;
});

function days(sid, n) {
	const out = [];
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const list = monitor.history[sid] || [];
	for (let i = n - 1; i >= 0; i--) {
		const from = today.getTime() - i * 24 * 3600 * 1000;
		const to = from + 24 * 3600 * 1000;
		let c = 0;
		let ok = 0;
		for (const b of list) if (b[0] >= from && b[0] < to) (c += b[1]), (ok += b[2]);
		out.push(c ? ok / c : null);
	}
	return out;
}

route("POST", "/api/services", async (body) => {
	const s = store.saveService(body);
	monitor.check(s).catch(() => {});
	return { service: store.public().services.find((x) => x.id === s.id) };
});

route("POST", "/api/services/:id", async (body, p) => {
	const s = store.saveService(body, p.id);
	integrations.forget(s.id);
	monitor.check(s).catch(() => {});
	return { service: store.public().services.find((x) => x.id === s.id) };
});

route("POST", "/api/services/:id/delete", (body, p) => {
	store.removeService(p.id);
	monitor.forget(p.id);
	integrations.forget(p.id);
});

// Test a service with what is typed in the form (stored logins fill the gaps).
route("POST", "/api/test", async (body) => {
	const url = String(body.url || "").trim();
	if (!/^https?:\/\//.test(url)) throw new UserError("The address must start with http:// or https://");
	const sid = body.id && store.config.services.some((s) => s.id === body.id) ? body.id : `test-${Date.now()}`;
	const stored = body.id ? store.secretsOf(body.id) : {};
	const secrets = { ...stored };
	for (const [k, v] of Object.entries(body.secrets || {})) if (v !== undefined && v !== null) v === "" ? delete secrets[k] : (secrets[k] = String(v));
	return integrations.test({ id: sid, url, kind: KINDS[body.kind] ? body.kind : null, insecure: !!body.insecure }, secrets);
});

route("POST", "/api/services/:id/action", async (body, p) => {
	const s = store.service(p.id);
	const what = String(body.what || "");
	if (s.container && ["start", "stop", "restart"].includes(what)) {
		const c = await docker.action(s.container, what);
		// look again in a moment, when the service had time to come up
		setTimeout(() => monitor.check(s).catch(() => {}), what === "stop" ? 500 : 6000);
		return { container: { state: c.state, status: c.status } };
	}
	const r = await integrations.action(s, what);
	setTimeout(() => monitor.check(s).catch(() => {}), 8000);
	return r;
});

route("GET", "/api/services/:id/logs", async (body, p, query) => {
	const s = store.service(p.id);
	if (!s.container) throw new UserError("No container linked");
	return { text: await docker.logs(s.container, Number(query.get("tail")) || 300) };
});

route("POST", "/api/services/:id/check", async (body, p) => monitor.check(store.service(p.id)).then(() => monitor.summary(p.id)));

route("GET", "/api/discover", async (body, p, query, req) => {
	if (docker.available === false) return { docker: false, items: [] };
	const hostName = String(req.headers.host || "localhost").replace(/:\d+$/, "");
	return { docker: true, items: await docker.suggestions(store.config.services, hostName) };
});

route("GET", "/api/containers", async () => {
	if (docker.available === false) return { docker: false, items: [] };
	return { docker: true, items: (await docker.list()).map((c) => ({ name: c.name, image: c.image, state: c.state })) };
});

route("POST", "/api/boards", (body) => ({ board: store.addBoard(body.name) }));
route("POST", "/api/boards/:id", (body, p) => store.renameBoard(p.id, body.name));
route("POST", "/api/boards/:id/delete", (body, p) => store.removeBoard(p.id));
route("POST", "/api/boards/:id/tiles", (body, p) => ({ board: store.setTiles(p.id, body.tiles) }));
route("POST", "/api/settings", (body) => store.setTitle(body.title));

// ---------- server ----------

process.on("uncaughtException", (err) => console.error("Unexpected error:", err));
process.on("unhandledRejection", (err) => console.error("Unexpected error:", err));
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		monitor.persist();
		process.exit(0);
	});
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://localhost");
	if (!url.pathname.startsWith("/api/")) {
		if (req.method !== "GET" && req.method !== "HEAD") return send(req, res, 405, "Method not allowed", "text/plain");
		return serveStatic(req, res, url.pathname);
	}
	try {
		if (url.pathname === "/api/login" && req.method === "POST") {
			const body = await readBody(req);
			return send(req, res, 200, { ok: true }, undefined, { "Set-Cookie": auth.login(body.password, req.socket.remoteAddress) });
		}
		if (url.pathname === "/api/logout" && req.method === "POST") return send(req, res, 200, { ok: true }, undefined, { "Set-Cookie": auth.logout(req) });
		if (!auth.check(req)) return send(req, res, 401, { error: "Please log in", login: true });
	} catch (err) {
		return send(req, res, err instanceof UserError ? 400 : 500, { error: err.message });
	}
	// Jellyfin posters: binary
	const img = /^\/api\/img\/([a-f0-9]{10})\/([a-f0-9]{32})$/i.exec(url.pathname);
	if (img && req.method === "GET") {
		try {
			const r = await integrations.image(store.service(img[1]), img[2]);
			return send(req, res, 200, r.body, r.type, { "Cache-Control": "private, max-age=86400" });
		} catch {
			return send(req, res, 404, "Not found", "text/plain");
		}
	}
	const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
	if (!r) return send(req, res, 404, { error: "Not found" });
	try {
		const body = req.method === "POST" ? await readBody(req) : {};
		const params = Object.fromEntries(Object.entries(r.re.exec(url.pathname).groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
		const result = await r.handler(body, params, url.searchParams, req);
		send(req, res, 200, result === undefined ? { ok: true } : result);
	} catch (err) {
		const user = err instanceof UserError;
		if (!user) console.error(err);
		send(req, res, user ? 400 : 500, { error: err.message || String(err) });
	}
});

server.listen(PORT, HOST, () => {
	console.log(`Service Dashboard ${VERSION} on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
	console.log(`Data in ${DATA_DIR} · Docker: ${docker.available === false ? "not found" : docker.socket} · checks every ${CHECK_SECONDS} s`);
	monitor.start();
});
