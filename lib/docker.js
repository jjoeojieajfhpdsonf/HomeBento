"use strict";
// Docker Engine API over the unix socket (no dependencies): list, start/stop/restart,
// logs and stats of containers, and suggestions for services that aren't on the dashboard yet.
const fs = require("node:fs");
const { request } = require("./util");
const { UserError } = require("./errors");
const { guessIcon, guessKind, niceName } = require("./kinds");

class Docker {
	constructor(socketPath) {
		this.socket = socketPath || process.env.DOCKER_SOCKET || "/var/run/docker.sock";
		this.available = fs.existsSync(this.socket) ? null : false; // null = not tried yet
	}

	async api(method, apiPath, { timeout = 15000, raw = false, body } = {}) {
		const r = await request(`http://docker${apiPath}`, { method, socketPath: this.socket, timeout, body, headers: body ? { "Content-Type": "application/json" } : {}, maxBytes: 20_000_000 });
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

	async list() {
		const rows = await this.api("GET", "/containers/json?all=1");
		return rows.map((c) => ({
			id: c.Id,
			name: (c.Names[0] || "").replace(/^\//, ""),
			image: c.Image,
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
	async suggestions(services, host) {
		const used = new Set(services.map((s) => s.container).filter(Boolean));
		const out = [];
		for (const c of await this.list()) {
			if (used.has(c.name) || c.labels["service-dashboard.ignore"] === "true") continue;
			const lab = (k) => c.labels[`service-dashboard.${k}`] || c.labels[`homepage.${k}`];
			let port = c.ports[0] && c.ports[0].public;
			// host network: no port mappings, but the image usually declares its port
			if (!port && c.network === "host") {
				const info = await this.api("GET", `/containers/${c.id}/json`).catch(() => null);
				const exposed = info && info.Config && info.Config.ExposedPorts ? Object.keys(info.Config.ExposedPorts) : [];
				const p = exposed.map((x) => parseInt(x, 10)).find((x) => x && !isNaN(x));
				port = p || null;
			}
			const base = baseName(c);
			const icon = lab("icon") ? String(lab("icon")).replace(/\.(svg|png)$/, "") : guessIcon(base);
			out.push({
				container: c.name,
				image: c.image,
				state: c.state,
				name: lab("name") || niceName(guessIcon(base)),
				url: lab("href") || urlFor(host, port),
				icon,
				kind: guessKind(c.name, c.image)
			});
		}
		return out.sort((a, b) => (b.url ? 1 : 0) - (a.url ? 1 : 0) || a.name.localeCompare(b.name));
	}
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
const NOT_HTTP = new Set([22, 53, 1883, 3306, 5432, 6379, 8883, 11211, 27017, 5672, 9092]);
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

module.exports = { Docker, demux, baseName, urlFor };
