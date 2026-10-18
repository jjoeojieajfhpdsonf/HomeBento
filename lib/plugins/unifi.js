"use strict";
// UniFi Network: clients, devices and subsystems with problems from stat/health.
// UniFi OS (UDM, Cloud Key Gen2+, UniFi OS Server): POST /api/auth/login, then
// /proxy/network/api/s/<site>/stat/health, or an API key (Network 9+) without a login.
// Classic controller (software, port 8443): POST /api/login, then /api/s/<site>/stat/health.
// Use a local admin account; Ubiquiti cloud accounts with 2FA cannot log in this way.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const sessions = new Map(); // url + login hash -> { cookie, prefix }
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;
const cookieOf = (r) => [].concat((r.headers && r.headers["set-cookie"]) || []).map((c) => c.split(";")[0]).join("; ");
const OS = "/proxy/network";

// UniFi OS answers / with an x-csrf-token header, the classic controller redirects to /manage.
async function detect(url, request) {
	const r = await request(`${url}/`, { timeout: 8000, maxBytes: 200000 });
	if (!r.status) throw new Error(r.error);
	return r.headers["x-csrf-token"] || r.headers["access-control-expose-headers"] ? OS : "";
}

async function login(url, username, password, request) {
	const first = await detect(url, request);
	for (const prefix of [first, first === OS ? "" : OS]) {
		const r = await request(`${url}${prefix === OS ? "/api/auth/login" : "/api/login"}`, { method: "POST", body: { username, password, remember: false }, headers: { "Content-Type": "application/json", Accept: "application/json" } });
		if (!r.status) throw new Error(r.error);
		if (r.status === 404) continue;
		if (r.status === 429) throw new Error("Too many login attempts, try again later");
		if (r.status === 400 || r.status === 401 || r.status === 403) {
			// classic controllers answer with "api.err.…" (also for paths they do not know),
			// UniFi OS without it: an answer of the other kind means the wrong login path
			const classic = /api\.err\./.test(r.body.toString("utf8"));
			if (classic !== (prefix === "")) continue;
			if (/2fa|Ubic2fa|MFA/i.test(r.body.toString("utf8"))) throw new Error("Two-factor login is not supported, use a local account");
			throw new Error("Access denied (check the username and password)");
		}
		if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
		const cookie = cookieOf(r);
		if (!cookie) throw new Error("Login failed (no session cookie)");
		return { cookie, prefix };
	}
	throw new Error("No UniFi Network login found at this address");
}

function result(health) {
	const sub = (name) => health.find((x) => x.subsystem === name) || {};
	const wlan = sub("wlan");
	const lan = sub("lan");
	const wan = sub("wan");
	const clients = ["wlan", "lan"].reduce((n, s) => n + (Number(sub(s).num_user) || 0) + (Number(sub(s).num_guest) || 0), 0);
	const devices = ["wlan", "lan", "wan"].reduce((n, s) => n + (Number(sub(s).num_adopted) || 0), 0);
	const offline = ["wlan", "lan", "wan"].reduce((n, s) => n + (Number(sub(s).num_disconnected) || 0), 0);
	// status: "ok", "warning", "error"; "unknown" when a subsystem is not in use
	const problems = health.filter((x) => x.status && x.status !== "ok" && x.status !== "unknown");
	const names = { wlan: "WiFi", lan: "LAN", wan: "WAN", www: "Internet", vpn: "VPN" };
	return {
		metrics: [
			{ value: clients, label: L("Clients", "Clients") },
			{ value: devices, label: L("Geräte", "Devices") },
			{ value: problems.length + offline, label: L("Warnungen", "Alerts"), warn: problems.length + offline > 0 },
			...(wlan.num_user !== undefined ? [{ value: Number(wlan.num_user) || 0, label: "WLAN" }] : [])
		],
		items: health
			.filter((x) => x.status && x.status !== "unknown")
			.map((x) => ({
				title: names[x.subsystem] || x.subsystem,
				sub: [x.num_adopted !== undefined ? `${x.num_adopted} device(s)` : "", x.num_disconnected ? `${x.num_disconnected} offline` : "", x.num_user !== undefined ? `${x.num_user} client(s)` : ""].filter(Boolean).join(" · "),
				status: x.status === "ok" ? "ok" : x.status === "error" ? "bad" : "warn"
			})),
		warnings: [...problems.map((x) => `UniFi ${names[x.subsystem] || x.subsystem}: ${x.status}`), ...(offline ? [`${offline} UniFi device(s) offline`] : [])],
		summary: wan.wan_ip ? `WAN ${wan.wan_ip}` : lan.lan_ip ? `LAN ${lan.lan_ip}` : null
	};
}

module.exports = {
	kind: "unifi",
	label: "UniFi Network",
	match: /unifi/,
	ttl: 60000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Lokales Admin-Konto", "Local admin account") },
		{ key: "password", label: L("Passwort", "Password"), secret: true },
		{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Statt Benutzer/Passwort, nur UniFi OS (Network 9+)", "Instead of user/password, UniFi OS only (Network 9+)"), secret: true },
		{ key: "site", label: L("Site", "Site"), help: L("Leer = default", "Empty = default") }
	],
	async fetch({ url, secrets, request, json }) {
		const site = encodeURIComponent(secrets.site || "default");
		const path = `/api/s/${site}/stat/health`;
		if (secrets.apiKey) {
			const r = await json(`${url}${OS}${path}`, { headers: { "X-API-KEY": secrets.apiKey } });
			return result(r.data || []);
		}
		if (!secrets.username) throw new Error("Username missing");
		if (!secrets.password) throw new Error("Password missing");
		const key = keyOf(url, secrets.username, secrets.password);
		const load = (s) => json(`${url}${s.prefix}${path}`, { headers: { Cookie: s.cookie } });
		let s = sessions.get(key);
		let r = null;
		if (s) {
			try {
				r = await load(s);
			} catch (err) {
				if (!/Access denied/.test(err.message)) throw err;
				s = null;
			}
		}
		if (!s) {
			sessions.delete(key);
			s = await login(url, secrets.username, secrets.password, request);
			sessions.set(key, s);
			r = await load(s);
		}
		if (r.meta && r.meta.rc && r.meta.rc !== "ok") throw new Error(r.meta.msg === "api.err.NoSiteContext" ? "Site not found" : r.meta.msg || "UniFi error");
		return result(r.data || []);
	}
};
