"use strict";
// Komga: series, books, unread and in-progress books plus the libraries. Newer Komga searches with
// POST /api/v1/series/list and /api/v1/books/list; older versions only know GET /api/v1/series and
// /api/v1/books, used when the list endpoints answer 404/405. Login: an API key (X-API-Key, Komga
// → Account settings → API keys) or user + password (basic auth; the session token is kept).
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const sessions = new Map(); // url + login hash -> X-Auth-Token
const keyOf = (url, login) => `${url}|${crypto.createHash("sha256").update(login).digest("hex")}`;

module.exports = {
	kind: "komga",
	label: "Komga",
	match: /komga/,
	repo: "gotson/komga",
	ttl: 5 * 60000,
	fields: [
		{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Komga → Kontoeinstellungen → API-Schlüssel. Oder Benutzer und Passwort eintragen.", "Komga → Account settings → API keys. Or enter user and password."), secret: true },
		{ key: "username", label: L("Benutzer (statt Schlüssel)", "User (instead of a key)"), help: L("E-Mail-Adresse des Komga-Kontos", "E-mail address of the Komga account") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, request }) {
		const basic = secrets.username && secrets.password ? `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString("base64")}` : null;
		if (!secrets.apiKey && !basic) throw new Error("API key or login missing");
		const skey = basic ? keyOf(url, basic) : null;

		// returns { status, data }; 401/403 throw, other errors are left to the caller
		const call = async (path, body) => {
			for (let attempt = 0; attempt < 2; attempt++) {
				const headers = { Accept: "application/json" };
				if (body !== undefined) headers["Content-Type"] = "application/json";
				if (secrets.apiKey && !basic) headers["X-API-Key"] = secrets.apiKey;
				else if (sessions.has(skey)) headers["X-Auth-Token"] = sessions.get(skey);
				else headers.Authorization = basic;
				const r = await request(`${url}/api/v1/${path}`, { method: body === undefined ? "GET" : "POST", headers, body });
				if (!r.status) throw new Error(r.error);
				if (r.status === 401 || r.status === 403) {
					if (headers["X-Auth-Token"]) {
						sessions.delete(skey); // session expired: log in again
						continue;
					}
					throw new Error("Access denied (check the API key or login)");
				}
				const token = r.headers["x-auth-token"];
				if (basic && token) sessions.set(skey, token);
				if (r.status >= 400) return { status: r.status, data: null };
				try {
					return { status: r.status, data: JSON.parse(r.body.toString("utf8")) };
				} catch {
					throw new Error("Unexpected answer (not JSON)");
				}
			}
			throw new Error("Access denied (check the API key or login)");
		};
		const total = (r) => {
			if (r.status >= 400 || !r.data || r.data.totalElements === undefined) throw new Error(`Unexpected answer from Komga (HTTP ${r.status})`);
			return Number(r.data.totalElements) || 0;
		};
		// count with the list search, or the old GET endpoint
		const count = async (what, readStatus) => {
			const r = await call(`${what}/list?size=1`, readStatus ? { condition: { readStatus: { operator: "is", value: readStatus } } } : {});
			if (r.status !== 404 && r.status !== 405) return total(r);
			return total(await call(`${what}?size=1${readStatus ? `&read_status=${readStatus}` : ""}`));
		};

		const libs = await call("libraries");
		if (libs.status >= 400 || !Array.isArray(libs.data)) throw new Error(`Unexpected answer from Komga (HTTP ${libs.status})`);
		const [series, books, unread, reading] = await Promise.all([count("series"), count("books"), count("books", "UNREAD"), count("books", "IN_PROGRESS")]);
		const unavailable = libs.data.filter((l) => l.unavailable);
		return {
			metrics: [
				{ value: series, label: L("Serien", "Series") },
				{ value: books, label: L("Bücher", "Books") },
				{ value: unread, label: L("ungelesen", "Unread") },
				{ value: reading, label: L("am Lesen", "Reading") }
			],
			items: libs.data.map((l) => ({ title: l.name, sub: l.unavailable ? "unavailable" : "", status: l.unavailable ? "bad" : "ok" })),
			warnings: unavailable.map((l) => `Library ${l.name} is unavailable`),
			summary: `${libs.data.length} ${libs.data.length === 1 ? "library" : "libraries"}`
		};
	}
};
