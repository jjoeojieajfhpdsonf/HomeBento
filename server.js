"use strict";
// HomeBento – a dependency-free dashboard for the services at home:
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
const { Tailscale, targetFor } = require("./lib/tailscale");
const { Releases, parseRepo, runningVersion, sameVersion } = require("./lib/releases");
const widgets = require("./lib/widgets");
const apiwidget = require("./lib/apiwidget");
const markets = require("./lib/markets");
const holidays = require("./lib/holidays");
const importers = require("./lib/importers");
const { Alerts } = require("./lib/alerts");
const os = require("node:os");
const { KINDS } = require("./lib/kinds");
const { UserError } = require("./lib/errors");

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
const host = new Host({ dataDir: DATA_DIR });
const integrations = new Integrations(store);
const auth = new Auth(process.env.PASSWORD, DATA_DIR);
const tailscale = new Tailscale();
const releases = new Releases(DATA_DIR);
// status changes go to the alerts (messages to the channels in the settings)
const monitor = new Monitor({ store, docker, dataDir: DATA_DIR, interval: CHECK_SECONDS, onChange: (ev, s) => alerts.onChange(ev, s) });
const alerts = new Alerts({ store, monitor, host, envUrl: NOTIFY_URL });

// A copy of the configuration every day (data/backups, the last 14 days).
const BACKUPS = path.join(DATA_DIR, "backups");
function backup(reason = "daily") {
	fs.mkdirSync(BACKUPS, { recursive: true });
	const name = `config-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}-${reason}.json`;
	fs.writeFileSync(path.join(BACKUPS, name), JSON.stringify(store.exportConfig(false), null, "\t"));
	const files = fs.readdirSync(BACKUPS).filter((f) => /^config-.*\.json$/.test(f)).sort();
	for (const f of files.slice(0, Math.max(0, files.length - 20))) fs.rmSync(path.join(BACKUPS, f), { force: true });
	return name;
}
function dailyBackup() {
	const today = new Date().toISOString().slice(0, 10);
	const have = fs.existsSync(BACKUPS) && fs.readdirSync(BACKUPS).some((f) => f.startsWith(`config-${today}`));
	if (!have) backup("daily");
}

// Sonarr, Radarr and Prowlarr keep their API key in /config/config.xml: read it from the
// linked container, so nobody has to copy it by hand.
async function autoKeys(s) {
	const k = KINDS[s.kind];
	if (!k || !k.arr || !s.container || store.secretsOf(s.id).apiKey || docker.available === false) return false;
	const key = await docker.arrApiKey(s.container).catch(() => null);
	if (!key) return false;
	store.setSecret(s.id, "apiKey", key);
	integrations.forget(s.id);
	return true;
}

const hostOf = (req) => String(req.headers.host || "localhost").replace(/:\d+$/, "");

// Is this service running on this machine? (only then can Tailscale Serve forward to it)
function isLocal(s, req, dnsName) {
	let host;
	try {
		host = new URL(s.url).hostname;
	} catch {
		return false;
	}
	const mine = new Set(["localhost", "127.0.0.1", "::1", hostOf(req), dnsName]);
	for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) mine.add(a.address);
	return mine.has(host);
}

// Tailscale state for the web app: the machine's name, all entries, and which service has which address.
async function tailscaleInfo(req) {
	if (!tailscale.available) return { available: false };
	try {
		const { status, list } = await tailscale.mappings();
		const links = {};
		const local = {};
		for (const s of store.config.services) {
			if (!s.url || !isLocal(s, req, status.dnsName)) continue;
			local[s.id] = true;
			const { port } = targetFor(s.url);
			const m = list.find((x) => x.path === "/" && x.proxy && proxyPort(x.proxy) === port);
			if (m) links[s.id] = m.url;
		}
		return { available: true, ...status, mappings: list, links, local };
	} catch (err) {
		return { available: true, error: err.message };
	}
}
function proxyPort(proxy) {
	try {
		const u = new URL(proxy.replace(/^https\+insecure:/, "https:"));
		return ["127.0.0.1", "localhost", "0.0.0.0", "[::1]"].includes(u.hostname) ? Number(u.port) || (u.protocol === "https:" ? 443 : 80) : null;
	} catch {
		return /^\d+$/.test(proxy) ? Number(proxy) : null;
	}
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

route("GET", "/api/state", async (body, p, query, req) => ({
	tailscale: await tailscaleInfo(req),
	version: VERSION,
	config: store.public(),
	kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, tile: v.tile, fields: v.fields.map(({ key, label, help, secret }) => ({ key, label, help, secret: !!secret })) }])),
	docker: docker.available !== false,
	host: host.name,
	auth: auth.enabled,
	notify: alerts.channels().length > 0,
	checkSeconds: CHECK_SECONDS,
	// the addresses of this machine: services on it can be opened under whatever address HomeBento was opened with
	selfHosts: selfHosts(),
	cantons: holidays.CANTONS
}));

function selfHosts() {
	const out = new Set(["localhost", "127.0.0.1", "::1", os.hostname()]);
	for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) if (!a.internal || a.address === "127.0.0.1") out.add(a.address);
	return [...out];
}

// Everything a board needs to show right now (polled every few seconds by the web app).
route("GET", "/api/live", async (body, p, query, req) => {
	const cfg = store.config;
	const board = cfg.boards.find((b) => b.id === query.get("board")) || cfg.boards[0];
	const types = new Set(board.tiles.map((t) => t.type));
	const status = {};
	for (const s of cfg.services) status[s.id] = monitor.summary(s.id);
	// services whose content is shown: their own tile, content tiles (calendar = all Sonarr/Radarr),
	// and in the combined layout every service (the list shows their figures)
	const wanted = new Set(board.tiles.filter((t) => t.service).map((t) => t.service));
	if (cfg.layout === "combined") for (const s of cfg.services) wanted.add(s.id);
	if (types.has("calendar")) for (const s of cfg.services) if (s.kind === "sonarr" || s.kind === "radarr") wanted.add(s.id);
	// a content tile without its own service shows the first matching one
	// the mirror tile shows MagicMirror and restarts it through the manager
	if (types.has("mirror")) for (const s of cfg.services) if (s.kind === "magicmirror" || s.kind === "mmmanager") wanted.add(s.id);
	if (types.has("energy")) for (const s of cfg.services) if (s.kind === "solar") wanted.add(s.id);
	for (const t of board.tiles) if (!t.service && ["jellyfin", "recent", "downloads", "solar", "mystrom"].includes(t.type)) for (const s of cfg.services) if (s.kind && KINDS[s.kind].tile === (t.type === "recent" ? "jellyfin" : t.type)) wanted.add(s.id);
	const data = {};
	await Promise.all(
		cfg.services.filter((s) => wanted.has(s.id) && s.kind).map(async (s) => {
			const d = await integrations.data(s);
			if (d) data[s.id] = d;
		})
	);
	// 24 h per service: uptime tile, and the history in the service list
	const hours = {};
	for (const s of cfg.services) hours[s.id] = monitor.hours(s.id, 24);
	// containers at a glance, and the last status changes
	let containers = null;
	if (types.has("docker") && monitor.containers) {
		const list = monitor.containers;
		containers = {
			running: list.filter((c) => c.state === "running").length,
			stopped: list.filter((c) => c.state !== "running").length,
			stoppedNames: list.filter((c) => c.state !== "running").map((c) => c.name).slice(0, 6),
			top: list.filter((c) => monitor.stats.has(c.name)).map((c) => ({ name: c.name, ...monitor.stats.get(c.name) })).sort((a, b) => (b.memory || 0) - (a.memory || 0)).slice(0, 8)
		};
	}
	const events = types.has("events") ? monitor.events.slice(-30).reverse() : null;
	const ts = types.has("tailscale") ? await tailscaleInfo(req) : null;
	// newest releases of the repositories subscribed in release tiles
	let rel = null;
	const repos = [...new Set(board.tiles.filter((t) => t.type === "releases").flatMap((t) => t.repos || []))];
	if (repos.length) {
		rel = Object.fromEntries((await Promise.all(repos.map((r) => releases.get(r)))).map((r) => [r.repo, r]));
		// which service a repository belongs to (name and icon in the tile)
		for (const x of releases.suggest(cfg.services, monitor.containers)) {
			if (!rel[x.repo]) continue;
			rel[x.repo].service = x.service;
			// compare with what the container runs
			const s = cfg.services.find((y) => y.id === x.service);
			const c = s && s.container && (monitor.containers || []).find((y) => y.name === s.container);
			const running = runningVersion(c);
			if (running) {
				rel[x.repo].running = running;
				rel[x.repo].current = sameVersion(running, rel[x.repo].latest && rel[x.repo].latest.tag);
			}
		}
	}
	// general tiles: weather, disks, network, calendars, news
	const extra = {};
	if (types.has("weather")) {
		const place = await location();
		extra.weather = {};
		for (const t of board.tiles.filter((x) => x.type === "weather")) {
			const p = t.place || place;
			extra.weather[t.id] = p ? { place: p, ...(await widgets.weather(p.lat, p.lon)) } : { error: "no-place" };
		}
	}
	if (types.has("disks")) extra.disks = host.disks();
	if (types.has("network")) extra.net = host.history.slice(-180).map((p) => [p[0], p[4], p[5]]);
	if (types.has("ical")) {
		extra.ical = {};
		await Promise.all(board.tiles.filter((x) => x.type === "ical" && (x.calendars || []).length).map(async (t) => (extra.ical[t.id] = await widgets.calendars(t.calendars))));
	}
	if (types.has("rss")) {
		extra.rss = {};
		await Promise.all(board.tiles.filter((x) => x.type === "rss" && (x.feeds || []).length).map(async (t) => (extra.rss[t.id] = await widgets.feeds(t.feeds))));
	}
	// own API tiles, markets, holidays
	const lang = query.get("lang") === "de" ? "de" : "en";
	if (types.has("api")) {
		extra.api = {};
		await Promise.all(board.tiles.filter((t) => t.type === "api" && t.api && t.api.url).map(async (t) => (extra.api[t.id] = await apiwidget.fetchApi({ ...t.api, key: t.id, lang }, store.secretsOf(`tile:${t.id}`)))));
	}
	if (types.has("markets")) {
		extra.markets = {};
		await Promise.all(
			board.tiles.filter((t) => t.type === "markets").map(async (t) => {
				const [q, f, c] = await Promise.all([
					(t.symbols || []).length ? markets.quotes(t.symbols).catch((err) => [{ error: err.message }]) : [],
					(t.fx || []).length ? markets.fx(t.base || "CHF", t.fx).catch((err) => [{ error: err.message }]) : [],
					(t.crypto || []).length ? markets.crypto(t.crypto, (t.base || "CHF").toLowerCase()).catch((err) => [{ error: err.message }]) : []
				]);
				extra.markets[t.id] = { quotes: q, fx: f, crypto: c };
			})
		);
	}
	if (types.has("holidays")) extra.holidays = Object.fromEntries(board.tiles.filter((t) => t.type === "holidays").map((t) => [t.id, holidays.next(t.canton || "ZH", new Date(), 8)]));
	return { at: Date.now(), status, data, hours, host: types.has("host") || types.has("status") ? host.stats() : null, containers, events, tailscale: ts, releases: rel, alerts: alerts.list(), ...extra };
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
	// container values from the regular sampling: instant, no waiting for Docker
	if (s.container) {
		const c = (monitor.containers || []).find((x) => x.name === s.container);
		const st = monitor.stats.get(s.container) || {};
		out.container = c ? { state: c.state, status: c.status, image: c.image, cpu: st.cpu ?? null, memory: st.memory ?? null } : { error: docker.available === false ? "Docker is not connected" : `Container "${s.container}" not found` };
		// a newer release than the container runs? (GitHub, cached like the Updates tile)
		const sug = releases.suggest([s], monitor.containers)[0];
		const running = runningVersion(c);
		if (sug && running) {
			const r = await releases.get(sug.repo).catch(() => null);
			if (r && r.latest) out.release = { repo: sug.repo, latest: r.latest, running, current: sameVersion(running, r.latest.tag) };
		}
	}
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
	await autoKeys(s);
	monitor.check(s).catch(() => {});
	return { service: store.public().services.find((x) => x.id === s.id) };
});

route("POST", "/api/services/:id", async (body, p) => {
	const s = store.saveService(body, p.id);
	integrations.forget(s.id);
	await autoKeys(s);
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

route("GET", "/api/media/:id/:ref", async (body, p) => {
	const s = store.service(p.id);
	const jf = store.config.services.find((x) => x.kind === "jellyfin" && store.secretsOf(x.id).apiKey);
	return integrations.media(s, p.ref, jf);
});

route("POST", "/api/services/:id/action", async (body, p) => {
	const s = store.service(p.id);
	const what = String(body.what || "");
	if (s.container && ["start", "stop", "restart"].includes(what)) {
		const c = await docker.action(s.container, what);
		monitor.note(s, "action", { start: "Started", stop: "Stopped", restart: "Restarted" }[what]);
		// look again in a moment, when the service had time to come up
		setTimeout(() => monitor.check(s).catch(() => {}), what === "stop" ? 500 : 6000);
		return { container: { state: c.state, status: c.status } };
	}
	const r = await integrations.action(s, what, body);
	if (what === "restart") monitor.note(s, "action", "Restarted");
	setTimeout(() => monitor.check(s).catch(() => {}), 8000);
	return r;
});

route("GET", "/api/services/:id/logs", async (body, p, query) => {
	const s = store.service(p.id);
	if (!s.container) throw new UserError("No container linked");
	return { text: await docker.logs(s.container, Number(query.get("tail")) || 300) };
});

// "Check now": status and the integration's data, both fresh
route("POST", "/api/services/:id/check", async (body, p) => {
	const s = store.service(p.id);
	integrations.forget(s.id);
	const [, d] = await Promise.all([monitor.check(s), s.kind ? integrations.data(s) : null]);
	return { ...monitor.summary(s.id), data: d };
});

route("GET", "/api/discover", async (body, p, query, req) => {
	if (docker.available === false) return { docker: false, items: [] };
	return { docker: true, items: await docker.suggestions(store.config.services, hostOf(req)) };
});

// "Set up automatically": every running container with a web page becomes a service, with
// logins read where possible, and the board gets the matching tiles.
const NOT_SERVICES = /homarr|homepage|dashy|heimdall|homedash|organizr|flame|watchtower|portainer.agent/i;
route("POST", "/api/setup", async (body, p, query, req) => {
	if (docker.available === false) throw new UserError("Docker is not connected");
	const items = (await docker.suggestions(store.config.services, hostOf(req))).filter((i) => i.state === "running" && i.url && !NOT_SERVICES.test(`${i.container} ${i.image}`));
	const created = items.map((it) => store.saveService({ name: it.name, url: it.url, icon: it.icon, kind: it.kind, container: it.container, insecure: it.url.startsWith("https:") }));
	await Promise.all(created.map(autoKeys));
	const b = store.config.boards.find((x) => x.id === body.board) || store.config.boards[0];
	const tiles = b.tiles.slice();
	const has = (type) => tiles.some((t) => t.type === type);
	for (const type of ["status", "host"]) if (!has(type)) tiles.push({ type, w: 2, h: type === "host" ? 2 : 1 });
	for (const s of created) {
		const k = s.kind && KINDS[s.kind];
		if (k && k.tile && k.tile !== "calendar" && !tiles.some((t) => t.type === k.tile)) tiles.push({ type: k.tile, service: s.id, ...{ jellyfin: { w: 3, h: 3 }, downloads: { w: 3, h: 1 }, solar: { w: 2, h: 2 } }[k.tile] });
	}
	if (!has("calendar") && store.config.services.some((s) => s.kind === "sonarr" || s.kind === "radarr")) tiles.push({ type: "calendar", w: 3, h: 2 });
	for (const s of created) tiles.push({ type: "service", service: s.id, w: 1, h: 1 });
	if (!has("uptime")) tiles.push({ type: "uptime", w: 2, h: 2 });
	store.setTiles(b.id, tiles);
	for (const s of created) monitor.check(s).catch(() => {});
	return { added: created.length, names: created.map((s) => s.name) };
});

route("GET", "/api/containers", async () => {
	if (docker.available === false) return { docker: false, items: [] };
	return { docker: true, items: (await docker.list()).map((c) => ({ name: c.name, image: c.image, state: c.state })) };
});

route("GET", "/api/tailscale", (body, p, query, req) => tailscaleInfo(req));

// Make a service reachable in the tailnet (or not), on the same port as at home.
route("POST", "/api/services/:id/tailscale", async (body, p, query, req) => {
	const s = store.service(p.id);
	if (!tailscale.available) throw new UserError("Tailscale is not connected (mount /var/run/tailscale/tailscaled.sock)");
	const st = await tailscale.status();
	if (!isLocal(s, req, st.dnsName)) throw new UserError("Only services on this server can be shared through its Tailscale");
	const { port, target } = targetFor(s.url);
	const tsPort = Number(body.port) || (port === 80 ? 8080 : port);
	monitor.note(s, "tailscale", body.enable ? `Shared on port ${tsPort}` : "No longer shared");
	if (body.enable) {
		// moving to another port: the old entry of this service goes away
		const { list } = await tailscale.mappings();
		for (const m of list.filter((x) => x.path === "/" && x.proxy && proxyPort(x.proxy) === port && x.port !== tsPort)) await tailscale.remove(m.port);
		await tailscale.add(tsPort, target);
	} else {
		const { list } = await tailscale.mappings();
		for (const m of list.filter((x) => x.path === "/" && x.proxy && proxyPort(x.proxy) === port)) await tailscale.remove(m.port);
	}
	return tailscaleInfo(req);
});

route("POST", "/api/tailscale/remove", async (body, p, query, req) => {
	if (!tailscale.available) throw new UserError("Tailscale is not connected");
	await tailscale.remove(body.port);
	return tailscaleInfo(req);
});

// repositories for the services (image label or well-known projects) and release notes
route("GET", "/api/releases/suggest", () => ({ items: releases.suggest(store.config.services, monitor.containers) }));
route("GET", "/api/releases/notes", (body, p, query) => {
	const repo = parseRepo(query.get("repo"));
	if (!repo) throw new UserError("Invalid repository");
	return releases.notes(repo, String(query.get("tag") || ""));
});
route("GET", "/api/releases/check", async (body, p, query) => {
	const repo = parseRepo(query.get("repo"));
	if (!repo) throw new UserError("Please enter owner/repository or a GitHub link");
	const r = await releases.get(repo);
	if (r.error) throw new UserError(r.error);
	return r;
});

route("GET", "/api/host/history", () => ({ points: host.history }));

// Container updates run in the background; the web app follows their log.
const updateJobs = new Map();
route("POST", "/api/services/:id/update", (body, p) => {
	const s = store.service(p.id);
	if (!s.container) throw new UserError("No container linked");
	if (/homebento/i.test(s.container)) throw new UserError("HomeBento can't replace its own container – update it with git pull and docker compose");
	const running = [...updateJobs.values()].find((j) => j.sid === s.id && j.state === "running");
	if (running) return { job: running.id };
	const job = { id: `${Date.now().toString(36)}`, sid: s.id, name: s.name, state: "running", log: [], started: Date.now() };
	alerts.hush(s.id, 15 * 60000);
	updateJobs.set(job.id, job);
	const log = (line) => job.log.push(`${new Date().toLocaleTimeString("de-CH")} ${line}`);
	const healthy = s.url ? async () => (await monitor.probe(s)).status !== "down" : null;
	docker
		.update(s.container, { log, healthy })
		.then((r) => {
			job.state = "done";
			job.updated = r.updated;
			job.pinned = r.pinned;
			monitor.note(s, "action", r.updated ? "Updated" : "Already newest");
			integrations.forget(s.id);
			monitor.check(s).catch(() => {});
		})
		.catch((err) => {
			job.state = "failed";
			job.error = err.message;
			log(err.message);
			monitor.note(s, "action", "Update failed");
		});
	return { job: job.id };
});
route("GET", "/api/updates/:id", (body, p) => {
	const j = updateJobs.get(p.id);
	if (!j) throw new UserError("Unknown update");
	return j;
});

route("POST", "/api/boards", (body) => ({ board: store.addBoard(body.name) }));
route("POST", "/api/boards/order", (body) => store.orderBoards(body.ids));
route("POST", "/api/boards/:id", (body, p) => store.renameBoard(p.id, body.name));
route("POST", "/api/boards/:id/delete", (body, p) => store.removeBoard(p.id));
route("POST", "/api/boards/:id/tiles", (body, p) => ({ board: store.setTiles(p.id, body.tiles) }));
// The place for the weather, set in the settings (a weather tile can have its own).
const location = async () => store.config.location || null;

// ---------- alerts ----------

route("GET", "/api/alerts", () => alerts.view());
route("POST", "/api/alerts", (body) => {
	store.setAlerts(body);
	// passwords and tokens of the channels: "" removes, missing keeps
	for (const [cid, sec] of Object.entries(body.secrets && typeof body.secrets === "object" ? body.secrets : {})) if ((store.config.alerts.channels || []).some((c) => c.id === cid)) store.mergeSecrets(`channel:${cid}`, sec);
	return alerts.view();
});
route("POST", "/api/alerts/test", async (body) => {
	if (!body.channel || !body.channel.type) throw new UserError("Channel missing");
	try {
		return await alerts.test(body.channel, body.secrets);
	} catch (err) {
		throw new UserError(err.message);
	}
});
route("POST", "/api/services/:id/mute", (body, p) => {
	const until = body.minutes ? Date.now() + Number(body.minutes) * 60000 : null;
	const s = store.muteService(p.id, until);
	if (until) monitor.note(s, "action", "Muted");
	return { mutedUntil: s.mutedUntil || null };
});

// ---------- own API tiles ----------

// A tile's header values (tokens) stay on the server.
const tileById = (tid) => store.config.boards.flatMap((b) => b.tiles).find((t) => t.id === tid) || null;
route("POST", "/api/tiles/:id/secrets", (body, p) => {
	if (!tileById(p.id)) throw new UserError("Tile not found – save the page first");
	store.mergeSecrets(`tile:${p.id}`, body.secrets);
	return { secrets: Object.fromEntries(Object.keys(store.secretsOf(`tile:${p.id}`)).map((k) => [k, true])) };
});
route("GET", "/api/tiles/:id/secrets", (body, p) => ({ secrets: Object.fromEntries(Object.keys(store.secretsOf(`tile:${p.id}`)).map((k) => [k, true])) }));
// One try with the settings from the form: the answer and the paths in it, to pick from.
route("POST", "/api/api-preview", async (body) => {
	const saved = body.tile ? store.secretsOf(`tile:${body.tile}`) : {};
	const secrets = { ...saved, ...Object.fromEntries(Object.entries(body.secrets || {}).filter(([, v]) => v)) };
	return apiwidget.preview(body.api || {}, secrets);
});

// ---------- configuration: export, import, backups ----------

route("GET", "/api/config/export", (body, p, query) => store.exportConfig(query.get("secrets") === "1"));
route("POST", "/api/config/import", (body) => {
	backup("before-import");
	store.importConfig(body);
	return { ok: true };
});
route("GET", "/api/backups", () => ({ items: fs.existsSync(BACKUPS) ? fs.readdirSync(BACKUPS).filter((f) => /^config-.*\.json$/.test(f)).sort().reverse().map((f) => ({ name: f, size: fs.statSync(path.join(BACKUPS, f)).size })) : [] }));
route("POST", "/api/backups", () => ({ name: backup("manual") }));
route("POST", "/api/backups/:name/restore", (body, p) => {
	if (!/^config-[\w-]+\.json$/.test(p.name)) throw new UserError("Unknown backup");
	const file = path.join(BACKUPS, p.name);
	if (!fs.existsSync(file)) throw new UserError("Unknown backup");
	const data = JSON.parse(fs.readFileSync(file, "utf8"));
	// a backup has no logins: keep the current ones
	backup("before-restore");
	store.importConfig({ ...data, secrets: store.secrets });
	return { ok: true };
});
// From other dashboards (Homepage, Dashy, Homer, Heimdall, browser bookmarks): look first, then take over.
route("POST", "/api/import", (body) => {
	const text = String(body.text || "");
	if (!text.trim()) throw new UserError("The file is empty");
	if (text.length > 2_000_000) throw new UserError("The file is too large");
	let r;
	try {
		r = importers.importConfig(text, String(body.filename || ""));
	} catch (err) {
		throw new UserError(err.message);
	}
	const have = new Set(store.config.services.map((s) => s.url.replace(/\/+$/, "")));
	const groups = r.groups.map((g) => ({ name: g.name, services: g.services.map((x) => ({ ...x, exists: !!(x.url && have.has(x.url.replace(/\/+$/, ""))), secrets: Object.fromEntries(Object.keys(x.secrets || {}).map((k) => [k, true])) })) }));
	if (!body.apply) return { source: r.source, groups, links: r.links, warnings: r.warnings };
	backup("before-import");
	const skip = new Set(Array.isArray(body.skip) ? body.skip : []);
	let added = 0;
	for (const [gi, g] of r.groups.entries()) {
		const tiles = [];
		for (const [si, x] of g.services.entries()) {
			if (skip.has(`${gi}:${si}`) || groups[gi].services[si].exists || !x.name) continue;
			const svc = store.saveService({ name: x.name, url: x.url || "", icon: x.icon || "", kind: x.kind || null, container: x.container || null, secrets: x.secrets || {} });
			tiles.push({ type: "service", service: svc.id, w: 1, h: 1 });
			added++;
		}
		// a page per group (its services in the list / as tiles)
		if (body.pages && tiles.length) {
			const b = store.addBoard(g.name || r.source);
			store.setTiles(b.id, tiles);
		}
	}
	// bookmarks: a links tile per group on the first page
	if (r.links.length) {
		const first = store.config.boards[0];
		const byGroup = new Map();
		for (const l of r.links) byGroup.set(l.group || "", [...(byGroup.get(l.group || "") || []), l]);
		store.setTiles(first.id, [...first.tiles, ...[...byGroup].map(([name, list]) => ({ type: "links", w: 2, h: 2, title: name || undefined, links: list.slice(0, 20).map((l) => ({ name: l.name, url: l.url })) }))]);
	}
	return { added, links: r.links.length };
});

route("GET", "/api/geocode", async (body, p, query) => ({ items: await widgets.geocode(String(query.get("q") || "").slice(0, 80), query.get("lang") === "en" ? "en" : "de") }));
route("GET", "/api/disks", () => ({ items: host.disks() }));

route("POST", "/api/settings", (body) => {
	if (body.location !== undefined) store.setLocation(body.location);
	if (body.title !== undefined) store.setTitle(body.title);
	if (body.layout !== undefined) store.setLayout(body.layout);
});

// ---------- server ----------

process.on("uncaughtException", (err) => console.error("Unexpected error:", err));
process.on("unhandledRejection", (err) => console.error("Unexpected error:", err));
for (const sig of ["SIGTERM", "SIGINT"]) {
	process.on(sig, () => {
		monitor.persist();
		host.persist();
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
	const img = /^\/api\/img\/([a-f0-9]{10})\/([a-f0-9]{32}|(?:movie|series)-\d+)$/i.exec(url.pathname);
	if (img && req.method === "GET") {
		try {
			const r = await integrations.image(store.service(img[1]), img[2]);
			return send(req, res, 200, r.body, r.type, { "Cache-Control": "private, max-age=86400" });
		} catch {
			return send(req, res, 404, "Not found", "text/plain");
		}
	}
	// camera tiles: the image or the MJPEG stream, passed through
	const cam = /^\/api\/camera\/([a-f0-9]{10})$/.exec(url.pathname);
	if (cam && req.method === "GET") return camera(req, res, cam[1]);
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

function camera(req, res, tid) {
	const t = tileById(tid);
	if (!t || t.type !== "camera" || !t.url) return send(req, res, 404, "Not found", "text/plain");
	const sec = store.secretsOf(`tile:${tid}`);
	const u = new URL(t.url);
	const lib = u.protocol === "https:" ? require("node:https") : http;
	const headers = { "User-Agent": "HomeBento" };
	if (sec.user || sec.password) headers.Authorization = `Basic ${Buffer.from(`${sec.user || ""}:${sec.password || ""}`).toString("base64")}`;
	const up = lib.get(u, { headers, rejectUnauthorized: !t.insecure, timeout: 15000 }, (r) => {
		if (r.statusCode !== 200) {
			r.resume();
			return send(req, res, 502, `Camera answered HTTP ${r.statusCode}`, "text/plain");
		}
		res.writeHead(200, { "Content-Type": r.headers["content-type"] || "image/jpeg", "Cache-Control": "no-store" });
		r.pipe(res);
		req.on("close", () => r.destroy());
	});
	up.on("timeout", () => up.destroy(new Error("Timeout")));
	up.on("error", (err) => {
		if (!res.headersSent) send(req, res, 502, `Camera not reachable (${err.message})`, "text/plain");
		else res.end();
	});
}

server.listen(PORT, HOST, () => {
	console.log(`HomeBento ${VERSION} on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
	console.log(`Data in ${DATA_DIR} · Docker: ${docker.available === false ? "not found" : docker.socket} · Tailscale: ${tailscale.available ? tailscale.socket : "not found"} · checks every ${CHECK_SECONDS} s`);
	monitor.start();
	alerts.start();
	dailyBackup();
	setInterval(dailyBackup, 3600000).unref();
	// fill in API keys that can be read from containers (e.g. after an update that added this)
	setTimeout(() => Promise.all(store.config.services.map((s) => autoKeys(s).catch(() => false))).then((r) => r.some(Boolean) && console.log("API keys read from containers")), 2000);
});
