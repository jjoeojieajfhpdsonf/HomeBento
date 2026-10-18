"use strict";
// xTeVe: channel counts from the API (POST /api/ with {"cmd":"status"}). The API must be turned on
// in xTeVe → Settings → API. With "API authentication" on, a user with the API permission logs in
// first ({"cmd":"login"}); every answer carries a new token, which is kept for the next call.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const tokens = new Map(); // url + login hash -> latest token
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;

async function api(request, url, payload) {
	const r = await request(`${url}/api/`, { method: "POST", body: payload, headers: { "Content-Type": "application/json", Accept: "application/json" } });
	if (!r.status) throw new Error(r.error);
	if (r.status === 423) throw new Error("The xTeVe API is off (Settings → API)");
	if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the user and password)");
	if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
	try {
		return JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error("Unexpected answer from xTeVe (not JSON)");
	}
}

const denied = (res) => res && res.status === false && /login|token|session|expired|authori|permission|user/i.test(res.err || "");

module.exports = {
	kind: "xteve",
	label: "xTeVe",
	match: /xteve/,
	ttl: 60000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur wenn die API-Authentifizierung an ist (Benutzer mit API-Berechtigung)", "Only if API authentication is on (a user with the API permission)") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, request }) {
		const user = secrets.username || "";
		const pw = secrets.password || "";
		const key = keyOf(url, user, pw);
		let res = null;
		if (tokens.has(key)) {
			res = await api(request, url, { cmd: "status", token: tokens.get(key) });
			if (!res || res.status !== true) {
				// token expired or used up: log in again
				tokens.delete(key);
				res = null;
			}
		}
		if (!res) {
			let token;
			if (user) {
				const login = await api(request, url, { cmd: "login", username: user, password: pw });
				if (!login || login.status !== true) throw new Error("Access denied (check the user and password)");
				token = login.token;
			}
			res = await api(request, url, token ? { cmd: "status", token } : { cmd: "status" });
		}
		if (denied(res)) throw new Error(user ? "Access denied (check the user and password)" : "User and password missing (API authentication is on)");
		if (!res || res.status !== true) throw new Error(`xTeVe: ${(res && res.err) || "unexpected answer"}`);
		if (res.token) tokens.set(key, res.token);
		else tokens.delete(key);
		const n = (k) => Number(res[k]) || 0;
		return {
			metrics: [
				{ value: n("streams.all"), label: L("Kanäle", "Channels") },
				{ value: n("streams.active"), label: L("nach Filter", "Filtered") },
				{ value: n("streams.xepg"), label: L("in XEPG", "In XEPG") }
			],
			summary: [res["version.xteve"] ? `xTeVe ${res["version.xteve"]}` : "", res["epg.source"] ? `EPG: ${res["epg.source"]}` : ""].filter(Boolean).join(" · ") || null
		};
	}
};
