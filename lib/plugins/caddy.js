"use strict";
// Caddy: sites from the running config (/config/) and the state of the reverse-proxy upstreams
// (/reverse_proxy/upstreams) through the admin API, port 2019 by default. The admin API only
// listens on localhost unless Caddy is told otherwise (admin 0.0.0.0:2019 { origins … }).
const L = (de, en) => ({ de, en });

// The admin address: the URL as entered when it names a special port, otherwise port 2019.
function adminBase(url, adminUrl) {
	if (adminUrl) return String(adminUrl).trim().replace(/\/+$/, "");
	const u = new URL(url);
	if (u.port && u.port !== "80" && u.port !== "443") return url;
	return `http://${u.hostname}:2019`;
}

// All host names the HTTP servers route (match.host), including nested subroutes.
function hostsOf(config) {
	const hosts = new Set();
	const walk = (routes) => {
		for (const r of routes || []) {
			for (const m of r.match || []) for (const h of m.host || []) hosts.add(h);
			for (const hd of r.handle || []) if (hd.routes) walk(hd.routes);
		}
	};
	const servers = (config && config.apps && config.apps.http && config.apps.http.servers) || {};
	for (const s of Object.values(servers)) walk(s.routes);
	return [...hosts];
}

async function get(request, url, what) {
	const r = await request(url, { headers: { Accept: "application/json" } });
	if (!r.status) throw new Error(r.error);
	const text = r.body.toString("utf8");
	if (r.status === 403 && /host not allowed|origin/i.test(text)) throw new Error("Caddy refuses this address: add it to the admin origins (admin … { origins … })");
	if (r.status === 401 || r.status === 403) throw new Error("Access denied");
	if (r.status >= 400) throw new Error(`HTTP ${r.status} from the Caddy admin API (${what})`);
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("Unexpected answer (not JSON) – is this the Caddy admin API (port 2019)?");
	}
}

module.exports = {
	kind: "caddy",
	label: "Caddy",
	match: /caddy/,
	repo: "caddyserver/caddy",
	ttl: 30000,
	fields: [
		{
			key: "adminUrl",
			label: L("Admin-API-Adresse", "Admin API address"),
			help: L("Optional, Standard: http://<Host>:2019. Caddy muss die Admin-API nach aussen öffnen (admin 0.0.0.0:2019).", "Optional, default: http://<host>:2019. Caddy has to open the admin API (admin 0.0.0.0:2019).")
		}
	],
	adminBase,
	async fetch({ url, secrets, request }) {
		const base = adminBase(url, secrets.adminUrl);
		const [config, upstreams] = await Promise.all([get(request, `${base}/config/`, "config"), get(request, `${base}/reverse_proxy/upstreams`, "upstreams").catch(() => null)]);
		const hosts = hostsOf(config);
		const list = Array.isArray(upstreams) ? upstreams : [];
		// "healthy" exists in older versions; newer ones report the remembered failures
		const isBad = (u) => u.healthy === false || Number(u.fails) > 0;
		const bad = list.filter(isBad);
		const active = list.reduce((n, u) => n + (Number(u.num_requests) || 0), 0);
		return {
			metrics: [
				{ value: hosts.length, label: L("Hosts", "Hosts") },
				{ value: `${list.length - bad.length}/${list.length}`, label: L("Upstreams gesund", "Upstreams healthy"), warn: bad.length > 0 },
				{ value: active, label: L("aktive Anfragen", "active requests") }
			],
			items: list
				.slice()
				.sort((a, b) => isBad(b) - isBad(a) || String(a.address).localeCompare(String(b.address)))
				.map((u) => ({ title: u.address, sub: [Number(u.fails) ? `${u.fails} failures` : "", Number(u.num_requests) ? `${u.num_requests} active` : ""].filter(Boolean).join(" · "), status: isBad(u) ? "bad" : "ok" })),
			warnings: bad.map((u) => `Caddy upstream ${u.address} is failing`),
			summary: hosts.length ? hosts.slice(0, 3).join(", ") + (hosts.length > 3 ? ` +${hosts.length - 3}` : "") : null
		};
	}
};
