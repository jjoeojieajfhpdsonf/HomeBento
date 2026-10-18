"use strict";
// wg-easy (WireGuard): clients, which of them are connected (handshake in the last 3 minutes)
// and their traffic.
// v14 and older: POST /api/session { password } gives a session cookie, then /api/wireguard/client.
// v15: /api/client with basic auth (username + password of the web interface, 2FA must be off).
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const ONLINE_MS = 3 * 60000;
const sessions = new Map(); // url + password hash -> session cookie (v14)
const keyOf = (url, pw) => `${url}|${crypto.createHash("sha256").update(pw || "").digest("hex")}`;
const cookieOf = (r) => [].concat((r.headers && r.headers["set-cookie"]) || []).map((c) => c.split(";")[0]).join("; ");

function fmtBytes(b) {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	while (b >= 1000 && i < units.length - 1) {
		b /= 1000;
		i++;
	}
	return `${i ? b.toFixed(b < 10 ? 1 : 0) : Math.round(b)} ${units[i]}`;
}

function result(list) {
	const now = Date.now();
	const clients = list.map((c) => {
		const seen = c.latestHandshakeAt ? new Date(c.latestHandshakeAt).getTime() : 0;
		return {
			name: c.name || c.id,
			address: c.address || c.ipv4Address || "",
			enabled: c.enabled !== false,
			online: c.enabled !== false && seen > 0 && now - seen < ONLINE_MS,
			seen,
			rx: Number(c.transferRx) || 0,
			tx: Number(c.transferTx) || 0
		};
	});
	const online = clients.filter((c) => c.online);
	const traffic = clients.reduce((n, c) => n + c.rx + c.tx, 0);
	return {
		metrics: [
			{ value: clients.length, label: L("Clients", "Clients") },
			{ value: online.length, label: L("verbunden", "connected") },
			{ value: fmtBytes(traffic), label: L("Datenverkehr", "Traffic") }
		],
		items: clients
			.sort((a, b) => b.online - a.online || b.seen - a.seen || String(a.name).localeCompare(String(b.name)))
			.map((c) => ({
				title: c.name,
				sub: c.enabled ? `${c.address}${c.online ? ` · ↓ ${fmtBytes(c.rx)} ↑ ${fmtBytes(c.tx)}` : ""}` : "disabled",
				status: c.online ? "ok" : c.enabled ? "warn" : "bad"
			})),
		summary: online.length ? `${online.map((c) => c.name).join(", ")} connected` : null
	};
}

// v15: basic auth. Returns null when the server is older (no /api/client).
async function v15(url, secrets, request) {
	const r = await request(`${url}/api/client`, { headers: { Accept: "application/json", Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString("base64")}` } });
	if (!r.status) throw new Error(r.error);
	if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the username and password; 2FA must be off)");
	if (r.status !== 200) return null;
	try {
		const list = JSON.parse(r.body.toString("utf8"));
		return Array.isArray(list) ? list : null;
	} catch {
		return null;
	}
}

// v14: session cookie. Returns null when the server has no v14 API.
async function v14(url, password, request) {
	const key = keyOf(url, password);
	const get = (cookie) => request(`${url}/api/wireguard/client`, { headers: { Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) } });
	let r = await get(sessions.get(key));
	if (!r.status) throw new Error(r.error);
	if (r.status === 404) return null;
	if (r.status === 401 || r.status === 403) {
		sessions.delete(key);
		if (!password) throw new Error("Password missing");
		const login = await request(`${url}/api/session`, { method: "POST", body: { password }, headers: { "Content-Type": "application/json", Accept: "application/json" } });
		if (!login.status) throw new Error(login.error);
		if (login.status === 401 || login.status === 403) throw new Error("Access denied (check the password)");
		if (login.status === 404 || login.status === 400) return null;
		if (login.status >= 300) throw new Error(`HTTP ${login.status}`);
		const cookie = cookieOf(login);
		if (!cookie) throw new Error("Login failed (no session cookie)");
		sessions.set(key, cookie);
		r = await get(cookie);
		if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the password)");
	}
	if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
	try {
		return JSON.parse(r.body.toString("utf8"));
	} catch {
		return null; // v15 serves its web interface for unknown paths
	}
}

module.exports = {
	kind: "wgeasy",
	label: "wg-easy",
	match: /wg-?easy/,
	repo: "wg-easy/wg-easy",
	ttl: 15000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur ab wg-easy v15", "Only for wg-easy v15 and newer") },
		{ key: "password", label: L("Passwort", "Password"), help: L("Passwort der Weboberfläche", "Password of the web interface"), secret: true }
	],
	async fetch({ url, secrets, request }) {
		const password = secrets.password || "";
		if (secrets.username) {
			if (!password) throw new Error("Password missing");
			const list = await v15(url, secrets, request);
			if (list) return result(list);
		}
		const list = await v14(url, password, request);
		if (list && Array.isArray(list)) return result(list);
		if (!secrets.username) throw new Error("Username missing (needed for wg-easy v15)");
		throw new Error("No wg-easy API found at this address");
	}
};
