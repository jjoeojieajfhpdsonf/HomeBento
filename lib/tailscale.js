"use strict";
// Tailscale Serve through tailscaled's local API (the unix socket the `tailscale` command uses):
// make a service reachable in the tailnet as https://<machine>.<tailnet>.ts.net:<port>.
// Only the entries HomeBento is asked to change are touched; everything else in the serve
// configuration (e.g. a site on port 443 set up by hand) stays as it is.
const fs = require("node:fs");
const { request } = require("./util");
const { UserError } = require("./errors");

class Tailscale {
	constructor(socketPath) {
		this.socket = socketPath || process.env.TAILSCALE_SOCKET || "/var/run/tailscale/tailscaled.sock";
		this.cache = null;
	}

	get available() {
		try {
			return fs.statSync(this.socket).isSocket();
		} catch {
			return false;
		}
	}

	async api(method, path, { body, headers = {} } = {}) {
		// tailscaled only answers requests addressed to this host name
		const r = await request(`http://local-tailscaled.sock${path}`, { method, socketPath: this.socket, body, headers: { "Sec-Tailscale": "localapi", ...(body ? { "Content-Type": "application/json" } : {}), ...headers }, timeout: 10000 });
		if (!r.status) throw new UserError(`Tailscale not reachable (${r.error})`);
		const text = r.body.toString("utf8");
		if (r.status === 412) throw new UserError("The Tailscale configuration was changed meanwhile – please try again");
		if (r.status === 403) throw new UserError("Tailscale refused the change (HomeBento needs to run as root or as Tailscale operator)");
		if (r.status >= 400) throw new UserError(`Tailscale: ${text.trim() || `HTTP ${r.status}`}`);
		return { status: r.status, headers: r.headers, json: text ? JSON.parse(text) : null };
	}

	// { running, dnsName, tailnet } – the machine's name in the tailnet, without the trailing dot
	async status() {
		const { json } = await this.api("GET", "/localapi/v0/status");
		const self = json.Self || {};
		return {
			running: json.BackendState === "Running",
			state: json.BackendState,
			dnsName: String(self.DNSName || "").replace(/\.$/, ""),
			tailnet: (json.CurrentTailnet && json.CurrentTailnet.Name) || null,
			https: Array.isArray(json.CertDomains) ? json.CertDomains.length > 0 : null
		};
	}

	async config() {
		const r = await this.api("GET", "/localapi/v0/serve-config");
		return { config: r.json || {}, etag: r.headers.etag || null };
	}

	async save(config, etag) {
		await this.api("POST", "/localapi/v0/serve-config", { body: config, headers: etag ? { "If-Match": etag } : {} });
		this.cache = null;
	}

	// All web entries of this machine: [{ port, path, proxy, url, funnel }]
	async mappings() {
		if (this.cache && Date.now() - this.cache.at < 30000) return this.cache.list;
		const [st, { config }] = await Promise.all([this.status(), this.config()]);
		const list = [];
		for (const [hostPort, web] of Object.entries(config.Web || {})) {
			const [host, port] = splitHostPort(hostPort);
			for (const [path, h] of Object.entries((web && web.Handlers) || {})) {
				list.push({ host, port, path, proxy: h.Proxy || null, text: h.Text ? true : undefined, url: `https://${host}${port === 443 ? "" : `:${port}`}${path === "/" ? "" : path}`, funnel: !!(config.AllowFunnel && config.AllowFunnel[hostPort]) });
			}
		}
		const out = { status: st, list: list.sort((a, b) => a.port - b.port) };
		this.cache = { at: Date.now(), list: out };
		return out;
	}

	// Serves `target` (e.g. http://127.0.0.1:8096) at https://<machine>:<port>/ in the tailnet.
	async add(port, target) {
		port = Number(port);
		if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UserError("Invalid port");
		const st = await this.status();
		if (!st.running) throw new UserError(`Tailscale is not running (${st.state})`);
		if (!st.dnsName) throw new UserError("This machine has no Tailscale name (MagicDNS off?)");
		const { config, etag } = await this.config();
		const key = `${st.dnsName}:${port}`;
		const tcp = (config.TCP = config.TCP || {});
		const web = (config.Web = config.Web || {});
		const existing = web[key] && web[key].Handlers && web[key].Handlers["/"];
		if (existing && existing.Proxy !== target) throw new UserError(`Port ${port} is already used in Tailscale for ${existing.Proxy || "something else"}`);
		if (tcp[port] && !tcp[port].HTTPS) throw new UserError(`Port ${port} is already used in Tailscale for a TCP forward`);
		tcp[port] = { ...(tcp[port] || {}), HTTPS: true };
		web[key] = { ...(web[key] || {}), Handlers: { ...((web[key] && web[key].Handlers) || {}), "/": { Proxy: target } } };
		await this.save(config, etag);
		return `https://${st.dnsName}${port === 443 ? "" : `:${port}`}`;
	}

	// Removes the web entry on `port` (and its TCP listener if nothing else uses it).
	async remove(port) {
		port = Number(port);
		const st = await this.status();
		const { config, etag } = await this.config();
		const key = `${st.dnsName}:${port}`;
		if (!config.Web || !config.Web[key]) return false;
		delete config.Web[key];
		if (config.AllowFunnel) delete config.AllowFunnel[key];
		const stillUsed = Object.keys(config.Web).some((k) => splitHostPort(k)[1] === port);
		if (!stillUsed && config.TCP) delete config.TCP[port];
		await this.save(config, etag);
		return true;
	}
}

function splitHostPort(hp) {
	const i = hp.lastIndexOf(":");
	return [hp.slice(0, i), Number(hp.slice(i + 1))];
}

// What tailscaled should forward to for a service address: the same port on this machine.
// HTTPS services with their own certificate are reached with "https+insecure".
function targetFor(serviceUrl) {
	const u = new URL(serviceUrl);
	const port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
	return { port, target: `${u.protocol === "https:" ? "https+insecure" : "http"}://127.0.0.1:${port}` };
}

module.exports = { Tailscale, targetFor, splitHostPort };
