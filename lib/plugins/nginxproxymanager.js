"use strict";
// Nginx Proxy Manager: proxy hosts and certificates. POST /api/tokens with the login of the web
// interface gives a token (valid for a day, kept and reused), then /api/nginx/proxy-hosts and
// /api/nginx/certificates.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const DAY = 86400000;
const SOON = 14 * DAY;
const tokens = new Map(); // url + login hash -> { token, until }
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;

// "2025-01-31 12:00:00" (UTC, older versions) or an ISO date
function parseDate(v) {
	if (!v) return null;
	const s = String(v);
	const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
	return Number.isNaN(t) ? null : t;
}

async function login(url, identity, secret, request) {
	const r = await request(`${url}/api/tokens`, { method: "POST", body: { identity, secret }, headers: { "Content-Type": "application/json", Accept: "application/json" } });
	if (!r.status) throw new Error(r.error);
	if (r.status === 400 || r.status === 401 || r.status === 403) throw new Error("Access denied (check the email and password)");
	if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
	let body;
	try {
		body = JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error("Unexpected answer (not JSON)");
	}
	if (body.requires_2fa) throw new Error("Two-factor login is not supported, use a user without 2FA");
	if (!body.token) throw new Error("Login failed");
	return { token: body.token, until: Math.min(parseDate(body.expires) || Infinity, Date.now() + 12 * 3600000) };
}

module.exports = {
	kind: "nginxproxymanager",
	label: "Nginx Proxy Manager",
	match: /nginx.?proxy.?manager/,
	repo: "NginxProxyManager/nginx-proxy-manager",
	ttl: 60000,
	fields: [
		{ key: "username", label: L("E-Mail", "Email"), help: L("Login der Weboberfläche", "Login of the web interface") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, request, json }) {
		if (!secrets.username) throw new Error("Email missing");
		if (!secrets.password) throw new Error("Password missing");
		const key = keyOf(url, secrets.username, secrets.password);
		const load = async (token) => {
			const headers = { Authorization: `Bearer ${token}` };
			return Promise.all([json(`${url}/api/nginx/proxy-hosts`, { headers }), json(`${url}/api/nginx/certificates`, { headers })]);
		};
		let s = tokens.get(key);
		let hosts, certs;
		if (s && s.until > Date.now()) {
			try {
				[hosts, certs] = await load(s.token);
			} catch (err) {
				if (!/Access denied/.test(err.message)) throw err;
				s = null;
			}
		} else s = null;
		if (!s) {
			tokens.delete(key);
			s = await login(url, secrets.username, secrets.password, request);
			tokens.set(key, s);
			[hosts, certs] = await load(s.token);
		}
		const now = Date.now();
		const enabled = (h) => h.enabled === true || h.enabled === 1;
		const disabled = hosts.filter((h) => !enabled(h));
		const offline = hosts.filter((h) => enabled(h) && h.meta && h.meta.nginx_online === false);
		const expiring = certs
			.map((c) => ({ name: c.nice_name || (c.domain_names || []).join(", ") || `#${c.id}`, until: parseDate(c.expires_on) }))
			.filter((c) => c.until !== null && c.until - now < SOON)
			.sort((a, b) => a.until - b.until);
		const days = (t) => Math.floor((t - now) / DAY);
		return {
			metrics: [
				{ value: hosts.length, label: L("Proxy-Hosts", "Proxy hosts") },
				{ value: expiring.length, label: L("Zertifikate laufen ab", "Certificates expiring"), warn: expiring.length > 0 },
				{ value: disabled.length, label: L("deaktiviert", "disabled") },
				{ value: certs.length, label: L("Zertifikate", "Certificates") }
			],
			items: [
				...expiring.map((c) => ({ title: c.name, sub: c.until < now ? "certificate expired" : `certificate expires in ${days(c.until)} days`, status: c.until < now ? "bad" : "warn" })),
				...hosts
					.slice()
					.sort((a, b) => enabled(b) - enabled(a) || String((a.domain_names || [])[0] || "").localeCompare(String((b.domain_names || [])[0] || "")))
					.map((h) => ({
						title: (h.domain_names || []).join(", "),
						sub: !enabled(h) ? "disabled" : h.meta && h.meta.nginx_err ? h.meta.nginx_err : `${h.forward_scheme || "http"}://${h.forward_host}:${h.forward_port}`,
						status: !enabled(h) ? "warn" : h.meta && h.meta.nginx_online === false ? "bad" : "ok"
					}))
			],
			warnings: [
				...expiring.map((c) => (c.until < now ? `Certificate ${c.name} has expired` : `Certificate ${c.name} expires in ${days(c.until)} days`)),
				...offline.map((h) => `${(h.domain_names || [])[0]}: nginx configuration error`)
			],
			summary: offline.length ? `${offline.length} host(s) with errors` : null
		};
	}
};
