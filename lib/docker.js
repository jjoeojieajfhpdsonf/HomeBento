"use strict";
// Docker Engine API over the unix socket (no dependencies): list, start/stop/restart,
// logs and stats of containers, and suggestions for services that aren't on the dashboard yet.
const fs = require("node:fs");
const http = require("node:http");
const { request } = require("./util");
const { UserError } = require("./errors");
const { guessIcon, guessKind, niceName } = require("./kinds");

class Docker {
	constructor(socketPath) {
		this.socket = socketPath || process.env.DOCKER_SOCKET || "/var/run/docker.sock";
		this.available = fs.existsSync(this.socket) ? null : false; // null = not tried yet
	}

	async api(method, apiPath, { timeout = 15000, raw = false, body, maxBytes = 20_000_000 } = {}) {
		const r = await request(`http://docker${apiPath}`, { method, socketPath: this.socket, timeout, body, headers: body ? { "Content-Type": "application/json" } : {}, maxBytes });
		if (!r.status) {
			this.available = false;
			throw new UserError(`Docker not reachable (${r.error})`);
		}
		this.available = true;
		if (r.status === 304) return null; // already started / stopped
		if (r.status >= 400) {
			let msg = `HTTP ${r.status}`;
			try {
				msg = JSON.parse(r.body.toString("utf8")).message || msg;
			} catch {
				// not JSON
			}
			throw new UserError(`Docker: ${msg}`);
		}
		if (raw) return r.body;
		const text = r.body.toString("utf8");
		return text ? JSON.parse(text) : null;
	}

	// Pulls an image and reports as it goes: Docker sends one JSON line per event and layer. onEvent
	// gets { layers, done, current, total } (bytes over all layers) and the lines worth a log entry.
	pull(repo, tag, onEvent = () => {}) {
		return new Promise((resolve, reject) => {
			const req = http.request({ socketPath: this.socket, path: `/images/create?fromImage=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`, method: "POST", timeout: 20 * 60000 }, (res) => {
				if (res.statusCode >= 400) {
					let b = "";
					res.on("data", (d) => (b += d));
					res.on("end", () => reject(new UserError(`Pull failed: ${(() => { try { return JSON.parse(b).message; } catch { return `HTTP ${res.statusCode}`; } })()}`)));
					return;
				}
				const layers = new Map(); // id → { status, current, total }
				let rest = "";
				let error = null;
				let last = 0;
				const report = (line) => {
					const all = [...layers.values()];
					onEvent({
						layers: all.length,
						done: all.filter((l) => /complete|already exists/i.test(l.status)).length,
						current: all.reduce((a, l) => a + (l.current || 0), 0),
						total: all.reduce((a, l) => a + (l.total || 0), 0)
					}, line);
				};
				res.on("data", (chunk) => {
					const lines = (rest + chunk).split("\n");
					rest = lines.pop();
					for (const l of lines) {
						let e;
						try {
							e = JSON.parse(l);
						} catch {
							continue;
						}
						if (e.error) error = e.error;
						if (e.id && e.progressDetail !== undefined && !/^(Pulling from)/.test(e.status || "")) {
							const was = layers.get(e.id) || {};
							const dl = /^Downloading/.test(e.status);
							layers.set(e.id, { status: e.status, current: dl ? e.progressDetail.current || was.current : /complete|Extracting|Pull complete|already exists/i.test(e.status) ? was.total || was.current || 0 : was.current, total: (dl && e.progressDetail.total) || was.total || 0 });
						}
						// the lines worth logging: the start, the digest, the result
						const note = /^(Pulling from|Digest:|Status:)/.test(e.status || "") ? `${e.status}${e.id && /^Pulling from/.test(e.status) ? ` ${e.id}` : ""}` : null;
						if (note || Date.now() - last > 700) {
							last = Date.now();
							report(note);
						}
					}
				});
				res.on("end", () => {
					report(null);
					if (error) reject(new UserError(`Pull failed: ${error}`));
					else resolve();
				});
				res.on("error", reject);
			});
			req.on("timeout", () => req.destroy(new Error("timeout")));
			req.on("error", (err) => reject(new UserError(`Docker not reachable (${err.message})`)));
			req.end();
		});
	}

	async list() {
		const rows = await this.api("GET", "/containers/json?all=1");
		// the labels of the image each container runs (versions): asked once per image
		this.imageLabels = this.imageLabels || new Map();
		for (const id of new Set(rows.map((c) => c.ImageID).filter((id) => id && !this.imageLabels.has(id)))) {
			const img = await this.api("GET", `/images/${encodeURIComponent(id)}/json`).catch(() => null);
			this.imageLabels.set(id, (img && img.Config && img.Config.Labels) || {});
		}
		return rows.map((c) => ({
			id: c.Id,
			name: (c.Names[0] || "").replace(/^\//, ""),
			image: c.Image,
			imageId: c.ImageID,
			imageLabels: this.imageLabels.get(c.ImageID) || {},
			state: c.State,
			status: c.Status,
			created: c.Created * 1000,
			network: c.HostConfig && c.HostConfig.NetworkMode,
			ports: (c.Ports || []).filter((p) => p.PublicPort && p.Type === "tcp").map((p) => ({ public: p.PublicPort, private: p.PrivatePort })),
			labels: c.Labels || {}
		}));
	}

	async find(name) {
		const c = (await this.list()).find((x) => x.name === name);
		if (!c) throw new UserError(`Container "${name}" not found`);
		return c;
	}

	async action(name, what) {
		if (!["start", "stop", "restart"].includes(what)) throw new UserError("Unknown action");
		const c = await this.find(name);
		await this.api("POST", `/containers/${c.id}/${what}?t=10`, { timeout: 60000 });
		return this.find(name);
	}

	async logs(name, tail = 200) {
		const c = await this.find(name);
		const info = await this.api("GET", `/containers/${c.id}/json`);
		const buf = await this.api("GET", `/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=1&tail=${Math.min(2000, Math.max(10, tail))}`, { raw: true });
		const text = info.Config && info.Config.Tty ? buf.toString("utf8") : demux(buf);
		return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
	}

	// Update a container like Watchtower does: pull its image (same tag), create a copy with the same
	// configuration, swap them, and bring the old one back if the new one doesn't come up.
	// log(line) reports progress; healthy() (optional) is asked once the new container runs.
	// image: another tag of the same image (for a container started without compose, fixed to a version)
	// step(key) says which step runs: pull, swap, start, check, clean; progress(p) the pull's progress.
	async update(name, { log = () => {}, healthy, pull = true, image, step = () => {}, progress = () => {} } = {}) {
		const old = await this.find(name);
		const info = await this.api("GET", `/containers/${old.id}/json`);
		if (image && splitRef(image).repo !== splitRef(info.Config.Image).repo) throw new UserError("Only another version of the same image");
		const ref = image || info.Config.Image;
		if (/@sha256:/.test(ref)) throw new UserError(`The image is pinned to a digest (${ref}) – change it in the compose file`);
		const { repo, tag } = splitRef(ref);
		if (pull) {
			step("pull");
			log(`Pulling ${repo}:${tag} …`);
			const t0 = Date.now();
			let sizes = null;
			await this.pull(repo, tag, (p, line) => {
				sizes = p;
				progress(p);
				if (line) log(line);
			});
			const mb = (b) => `${(b / 1e6).toFixed(b < 1e7 ? 1 : 0)} MB`;
			log(`Downloaded${sizes && sizes.total ? ` ${mb(sizes.total)} in ${sizes.layers} layers` : ""} (${Math.round((Date.now() - t0) / 1000)} s)`);
		}
		const img = await this.api("GET", `/images/${encodeURIComponent(ref)}/json`);
		if (pull && img.Id === info.Image) {
			log("Already the newest image for this tag.");
			return { updated: false, pinned: /^\d/.test(tag) && tag !== "latest" };
		}
		// the same configuration on the new image – but what came from the old image (its labels with
		// the version, its environment, its command …) is left to the new image
		const cfg = { ...info.Config, Image: ref };
		const oldImg = ((await this.api("GET", `/images/${encodeURIComponent(info.Image)}/json`).catch(() => null)) || {}).Config || {};
		const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
		if (cfg.Labels) cfg.Labels = Object.fromEntries(Object.entries(cfg.Labels).filter(([k, v]) => !(oldImg.Labels && oldImg.Labels[k] === v)));
		if (Array.isArray(cfg.Env)) cfg.Env = cfg.Env.filter((e) => !(oldImg.Env || []).includes(e));
		for (const k of ["Cmd", "Entrypoint", "WorkingDir", "User", "ExposedPorts", "Volumes", "StopSignal", "Healthcheck", "Shell", "OnBuild"]) if (k in cfg && same(cfg[k], oldImg[k])) delete cfg[k];
		if (cfg.Hostname && info.Id.startsWith(cfg.Hostname)) delete cfg.Hostname; // generated from the old id
		const netMode = (info.HostConfig && info.HostConfig.NetworkMode) || "default";
		const nets = Object.entries((info.NetworkSettings && info.NetworkSettings.Networks) || {});
		const endpoint = (n) => ({ Aliases: (n.Aliases || []).filter((a) => !info.Id.startsWith(a)), IPAMConfig: n.IPAMConfig || undefined, Links: n.Links || undefined });
		const shared = /^(host|none|container:)/.test(netMode);
		const first = shared ? null : nets.find(([k]) => k === netMode) || nets[0];
		const body = { ...cfg, HostConfig: info.HostConfig, NetworkingConfig: first ? { EndpointsConfig: { [first[0]]: endpoint(first[1]) } } : undefined };
		const backup = `${name}-homebento-old-${Date.now().toString(36)}`;
		step("swap");
		log(`Renaming the running container to ${backup} (kept until the new one runs)`);
		await this.api("POST", `/containers/${old.id}/rename?name=${encodeURIComponent(backup)}`);
		let created = null;
		try {
			created = await this.api("POST", `/containers/create?name=${encodeURIComponent(name)}`, { body });
			if (!shared) for (const [k, n] of nets) if (!first || k !== first[0]) await this.api("POST", `/networks/${encodeURIComponent(k)}/connect`, { body: { Container: created.Id, EndpointConfig: endpoint(n) } });
			log(`New container created from ${ref}`);
			log("Stopping the old container …");
			await this.api("POST", `/containers/${old.id}/stop?t=20`, { timeout: 60000 });
			step("start");
			log("Starting the new container …");
			await this.api("POST", `/containers/${created.Id}/start`, { timeout: 60000 });
			// it has to keep running (and answer, if we can ask)
			step("check");
			log(healthy ? "Waiting until it answers (up to a minute) …" : "Waiting until it keeps running …");
			let ok = false;
			for (let i = 0; i < 30 && !ok; i++) {
				await new Promise((r) => setTimeout(r, 2000));
				const st = await this.api("GET", `/containers/${created.Id}/json`);
				if (!st.State.Running || st.State.Restarting) continue;
				ok = healthy ? await healthy().catch(() => false) : i >= 2;
			}
			if (!ok) throw new UserError("The new container didn't come up within a minute");
			log(healthy ? "It answers." : "It keeps running.");
			step("clean");
			log("Removing the old container");
			await this.api("DELETE", `/containers/${old.id}?v=0&force=1`, { timeout: 60000 });
			log(`Done – ${name} runs ${ref}`);
			return { updated: true };
		} catch (err) {
			log(`Rolling back: ${err.message}`);
			if (created) await this.api("DELETE", `/containers/${created.Id}?force=1`, { timeout: 60000 }).catch(() => {});
			await this.api("POST", `/containers/${old.id}/rename?name=${encodeURIComponent(name)}`).catch(() => {});
			await this.api("POST", `/containers/${old.id}/start`, { timeout: 60000 }).catch(() => {});
			throw new UserError(`Update failed, the old container runs again (${err.message})`);
		}
	}

	// Runs a command in a container and returns its output (stdout and stderr).
	async exec(name, cmd) {
		const c = await this.find(name);
		const ex = await this.api("POST", `/containers/${c.id}/exec`, { body: { AttachStdout: true, AttachStderr: true, Cmd: cmd } });
		const out = await this.api("POST", `/exec/${ex.Id}/start`, { body: { Detach: false, Tty: false }, raw: true, timeout: 10000 });
		return demux(out);
	}

	// The API key of a *arr app (Sonarr, Radarr, Prowlarr …) from its config.xml, or null.
	async arrApiKey(name) {
		const text = await this.exec(name, ["cat", "/config/config.xml"]).catch(() => "");
		const m = /<ApiKey>([A-Za-z0-9]{20,64})<\/ApiKey>/.exec(text);
		return m ? m[1] : null;
	}

	// CPU % and memory of one container (takes about a second: Docker measures over an interval).
	async stats(name) {
		const c = await this.find(name);
		if (c.state !== "running") return { state: c.state, status: c.status, image: c.image };
		const s = await this.api("GET", `/containers/${c.id}/stats?stream=false`, { timeout: 8000 });
		const cpuDelta = s.cpu_stats.cpu_usage.total_usage - (s.precpu_stats.cpu_usage || {}).total_usage;
		const sysDelta = s.cpu_stats.system_cpu_usage - (s.precpu_stats.system_cpu_usage || 0);
		const cpus = s.cpu_stats.online_cpus || (s.cpu_stats.cpu_usage.percpu_usage || []).length || 1;
		const mem = s.memory_stats || {};
		const cache = (mem.stats && (mem.stats.inactive_file ?? mem.stats.total_inactive_file ?? mem.stats.cache)) || 0;
		return {
			state: c.state,
			status: c.status,
			image: c.image,
			cpu: sysDelta > 0 && cpuDelta >= 0 ? Math.round((cpuDelta / sysDelta) * cpus * 1000) / 10 : null,
			memory: mem.usage ? Math.max(0, mem.usage - cache) : null,
			memoryLimit: mem.limit || null
		};
	}

	// Containers that could become services. `host` is how the user reaches this server.
	// The web address is found by trying the ports: a torrent or database port doesn't answer
	// HTTP, and a real web page beats a 404.
	async suggestions(services, host) {
		const used = new Set(services.map((s) => s.container).filter(Boolean));
		const list = (await this.list()).filter((c) => !used.has(c.name) && c.labels["homebento.ignore"] !== "true" && !isSelf(c));
		const out = await Promise.all(
			list.map(async (c) => {
				const lab = (k) => c.labels[`homebento.${k}`] || c.labels[`homepage.${k}`];
				const base = baseName(c);
				const kind = guessKind(c.name, c.image, base);
				let url = lab("href") || "";
				if (!url && c.state === "running") url = await findWebUrl(host, await this.candidatePorts(c));
				let icon = lab("icon") ? String(lab("icon")).replace(/\.(svg|png)$/, "") : guessIcon(base);
				if (!lab("icon") && !(await iconExists(icon))) icon = "";
				return { container: c.name, image: c.image, state: c.state, name: lab("name") || niceName(guessIcon(base), kind), url, icon, kind };
			})
		);
		return out.sort((a, b) => (b.url ? 1 : 0) - (a.url ? 1 : 0) || a.name.localeCompare(b.name));
	}

	async candidatePorts(c) {
		const ports = c.ports.map((p) => p.public);
		if (c.network === "host" || !ports.length) {
			// host network: no mappings; the port is in the environment or declared by the image
			const info = await this.api("GET", `/containers/${c.id}/json`).catch(() => null);
			const cfg = (info && info.Config) || {};
			for (const e of cfg.Env || []) {
				const m = /^(?:WEBUI_PORT|PORT|HTTP_PORT|WEB_PORT|SERVER_PORT)=(\d+)$/.exec(e);
				if (m) ports.push(Number(m[1]));
			}
			for (const x of Object.keys(cfg.ExposedPorts || {})) if (x.endsWith("/tcp")) ports.push(parseInt(x, 10));
		}
		return [...new Set(ports)].filter((p) => p && !NOT_HTTP.has(p)).slice(0, 6);
	}
}

// "lscr.io/linuxserver/sonarr:latest" → { repo: "lscr.io/linuxserver/sonarr", tag: "latest" }
function splitRef(ref) {
	const at = ref.lastIndexOf(":");
	const slash = ref.lastIndexOf("/");
	return at > slash ? { repo: ref.slice(0, at), tag: ref.slice(at + 1) } : { repo: ref, tag: "latest" };
}

// HomeBento itself isn't a suggestion.
const isSelf = (c) => /homebento/i.test(`${c.name} ${c.image}`);

// Tries the ports over HTTP and HTTPS; the best answer wins (2xx/3xx before 401/403 before other errors).
async function findWebUrl(host, ports) {
	const rank = (status) => (!status ? 0 : status < 400 ? 3 : status === 401 || status === 403 ? 2 : 1);
	const tries = ports.flatMap((p, i) => ["http", "https"].map((proto) => ({ p, i, proto })));
	const results = await Promise.all(
		tries.map(async (x) => {
			const url = `${x.proto}://${host}${(x.proto === "http" && x.p === 80) || (x.proto === "https" && x.p === 443) ? "" : `:${x.p}`}`;
			const r = await request(url, { insecure: true, timeout: 2500, maxBytes: 50000 });
			return { ...x, url, score: rank(r.status) };
		})
	);
	const best = results.filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.i - b.i || (a.proto === "http" ? -1 : 1))[0];
	return best ? best.url : "";
}

// Does dashboard-icons have this icon? (cached; without internet we let the browser try)
const iconCache = new Map();
function iconExists(slug) {
	if (!slug) return Promise.resolve(false);
	if (!iconCache.has(slug)) {
		iconCache.set(slug, request(`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${encodeURIComponent(slug)}.svg`, { method: "HEAD", timeout: 4000 }).then((r) => (r.status ? r.status === 200 : true)));
	}
	return iconCache.get(slug);
}

// Name for a suggestion: images from a registry keep theirs ("postgres", "sonarr"); images built
// by docker compose ("myproject-app") use the compose service, or the project if that is generic.
const GENERIC = new Set(["app", "web", "db", "api", "server", "frontend", "backend", "worker", "main", "service", "redis", "cache"]);
function baseName(c) {
	const img = guessIcon(null, c.image);
	const project = c.labels["com.docker.compose.project"];
	const service = c.labels["com.docker.compose.service"];
	if (!project || !service || !img.startsWith(project)) return img;
	return GENERIC.has(service) ? project : service;
}

// Ports that don't speak HTTP (databases, MQTT …): no link for those.
const NOT_HTTP = new Set([22, 53, 1883, 3306, 5432, 6379, 6881, 8883, 11211, 27017, 5672, 9092, 51413]);
function urlFor(host, port) {
	if (!port || NOT_HTTP.has(port)) return "";
	const https = port === 443 || port === 8443 || port === 9443;
	return `${https ? "https" : "http"}://${host}${port === 80 || port === 443 ? "" : `:${port}`}`;
}

// Docker multiplexes stdout and stderr: 8-byte header (stream, 0, 0, 0, size) per frame.
function demux(buf) {
	const framed = (i) => buf[i] <= 2 && buf[i + 1] === 0 && buf[i + 2] === 0 && buf[i + 3] === 0;
	if (buf.length < 8 || !framed(0)) return buf.toString("utf8");
	const parts = [];
	let i = 0;
	while (i + 8 <= buf.length && framed(i)) {
		const size = buf.readUInt32BE(i + 4);
		parts.push(buf.subarray(i + 8, i + 8 + size).toString("utf8"));
		i += 8 + size;
	}
	return i === 0 && buf.length ? buf.toString("utf8") : parts.join("");
}

module.exports = { Docker, demux, baseName, urlFor, splitRef };
