"use strict";
// Pi-hole: queries and blocked queries of the last 24 hours and whether blocking is on.
// Pi-hole v6 (REST API): POST /api/auth with the web password or an app password gives a session
// id, then /api/stats/summary and /api/dns/blocking. The session is kept and reused, because
// Pi-hole only allows a few sessions at a time. Pi-hole v5: /admin/api.php?summaryRaw with the API token.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const sessions = new Map(); // url + password hash -> sid (null when Pi-hole has no password)
const keyOf = (url, pw) => `${url}|${crypto.createHash("sha256").update(pw || "").digest("hex")}`;
const pct = (v) => `${Number(v || 0).toFixed(1)} %`;

function result({ total, blocked, percent, enabled, domains }) {
	const off = enabled === false;
	return {
		metrics: [
			{ value: total, label: L("Anfragen heute", "Queries today") },
			{ value: blocked, label: L("blockiert", "blocked") },
			{ value: pct(percent), label: L("blockiert", "blocked") },
			{ value: enabled === null ? "?" : off ? L("Aus", "Off") : L("An", "On"), label: L("Blockieren", "Blocking"), warn: off }
		],
		warnings: off ? ["Pi-hole blocking is disabled"] : [],
		summary: domains ? `${domains.toLocaleString("en-US")} domains on the blocklist` : null
	};
}

// Logs in (v6). Returns { sid } or { v5: true } when the server has no v6 API.
async function login(url, password, request) {
	const r = await request(`${url}/api/auth`, { method: "POST", body: { password }, headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 10000 });
	if (!r.status) throw new Error(r.error);
	if (r.status === 404 || r.status === 405) return { v5: true };
	let body = null;
	try {
		body = JSON.parse(r.body.toString("utf8"));
	} catch {
		// v5 answers with its web interface (HTML) instead of JSON
		if (r.status < 401) return { v5: true };
	}
	if (r.status === 401 || r.status === 403) {
		const msg = (body && body.session && body.session.message) || "";
		if (/2fa|totp/i.test(msg)) throw new Error("Two-factor login is on: use an app password (Settings → Web interface / API)");
		throw new Error("Access denied (check the password)");
	}
	if (r.status === 429) throw new Error("Too many login attempts, try again later");
	if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
	if (!body || !body.session || !body.session.valid) throw new Error("Login failed");
	return { sid: body.session.sid || null };
}

async function v6(url, sid, json) {
	const headers = sid ? { "X-FTL-SID": sid } : {};
	const [sum, block] = await Promise.all([json(`${url}/api/stats/summary`, { headers }), json(`${url}/api/dns/blocking`, { headers }).catch(() => null)]);
	const q = sum.queries || {};
	const state = block && block.blocking;
	return result({
		total: q.total || 0,
		blocked: q.blocked || 0,
		percent: q.percent_blocked !== undefined ? q.percent_blocked : q.total ? (100 * (q.blocked || 0)) / q.total : 0,
		enabled: state === "enabled" ? true : state === "disabled" ? false : null,
		domains: sum.gravity && sum.gravity.domains_being_blocked
	});
}

async function v5(url, token, json) {
	if (!token) throw new Error("Password missing");
	const r = await json(`${url}/admin/api.php?summaryRaw&auth=${encodeURIComponent(token)}`);
	// a wrong token gives an empty answer ([] or {})
	if (!r || Array.isArray(r) || r.dns_queries_today === undefined) throw new Error("Access denied (check the API token)");
	return result({
		total: Number(r.dns_queries_today) || 0,
		blocked: Number(r.ads_blocked_today) || 0,
		percent: Number(r.ads_percentage_today) || 0,
		enabled: r.status === "enabled" ? true : r.status === "disabled" ? false : null,
		domains: Number(r.domains_being_blocked) || 0
	});
}

module.exports = {
	kind: "pihole",
	label: "Pi-hole",
	match: /pi-?hole/,
	repo: "pi-hole/pi-hole",
	ttl: 30000,
	fields: [{ key: "password", label: L("Passwort", "Password"), help: L("v6: Web-Passwort oder App-Passwort · v5: API-Token", "v6: web password or app password · v5: API token"), secret: true }],
	async fetch({ url, secrets, request, json }) {
		const password = secrets.password || "";
		const key = keyOf(url, password);
		if (sessions.has(key)) {
			try {
				return await v6(url, sessions.get(key), json);
			} catch (err) {
				sessions.delete(key);
				if (!/Access denied/.test(err.message)) throw err;
				// session expired: log in again below
			}
		}
		if (!password) {
			// Pi-hole v6 without a password answers right away
			const r = await request(`${url}/api/stats/summary`, { headers: { Accept: "application/json" } });
			if (!r.status) throw new Error(r.error);
			if (r.status !== 200) throw new Error("Password missing");
			sessions.set(key, null);
			return v6(url, null, json);
		}
		const s = await login(url, password, request);
		if (s.v5) return v5(url, password, json);
		sessions.set(key, s.sid);
		return v6(url, s.sid, json);
	}
};
