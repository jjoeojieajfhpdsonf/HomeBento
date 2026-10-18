"use strict";
// Jackett: configured indexers and the ones whose last search failed (/api/v2.0/indexers?configured=true,
// `last_error` set). Needs the API key; when Jackett has an admin password, it also needs that one:
// HomeBento logs in at /UI/Dashboard and keeps the session cookie.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const sessions = new Map(); // url + password hash -> cookie
const keyOf = (url, pw) => `${url}|${crypto.createHash("sha256").update(pw).digest("hex")}`;

async function login(url, password, request) {
	const r = await request(`${url}/UI/Dashboard`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `password=${encodeURIComponent(password)}` });
	if (!r.status) throw new Error(r.error);
	const cookies = [].concat(r.headers["set-cookie"] || []).map((c) => c.split(";")[0]).filter((c) => /^Jackett=/i.test(c));
	if (!cookies.length) throw new Error("Access denied (check the admin password)");
	return cookies.join("; ");
}

module.exports = {
	kind: "jackett",
	label: "Jackett",
	match: /jackett/,
	repo: "Jackett/Jackett",
	ttl: 5 * 60000,
	fields: [
		{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Jackett-Oberfläche oben rechts: API Key", "Jackett web UI, top right: API Key"), secret: true },
		{ key: "password", label: L("Admin-Passwort", "Admin password"), help: L("Nur nötig, wenn Jackett ein Admin-Passwort hat", "Only if Jackett has an admin password"), secret: true }
	],
	async fetch({ url, secrets, request }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const skey = secrets.password ? keyOf(url, secrets.password) : null;
		const get = async () => {
			const headers = { Accept: "application/json" };
			if (skey && sessions.has(skey)) headers.Cookie = sessions.get(skey);
			return request(`${url}/api/v2.0/indexers?apikey=${encodeURIComponent(secrets.apiKey)}&configured=true`, { headers });
		};
		let r = await get();
		if (!r.status) throw new Error(r.error);
		// without a valid session Jackett redirects to its login page (or answers 401)
		if ((r.status >= 300 && r.status < 400) || r.status === 401 || r.status === 403) {
			if (!secrets.password) throw new Error("Jackett has an admin password: enter it as well");
			sessions.delete(skey);
			sessions.set(skey, await login(url, secrets.password, request));
			r = await get();
			if (!r.status) throw new Error(r.error);
			if ((r.status >= 300 && r.status < 400) || r.status === 401 || r.status === 403) {
				sessions.delete(skey);
				throw new Error("Access denied (check the admin password)");
			}
		}
		if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
		let list;
		try {
			list = JSON.parse(r.body.toString("utf8"));
		} catch {
			throw new Error("Unexpected answer (not JSON)");
		}
		if (!Array.isArray(list)) throw new Error("Unexpected answer from Jackett");
		const indexers = list.filter((i) => i.configured !== false);
		const failing = indexers.filter((i) => i.last_error);
		return {
			metrics: [
				{ value: indexers.length, label: L("Indexer", "Indexers") },
				{ value: failing.length, label: L("fehlerhaft", "Failing"), warn: failing.length > 0 }
			],
			items: indexers
				.map((i) => ({ title: i.name || i.id, sub: i.last_error ? String(i.last_error).slice(0, 160) : "", status: i.last_error ? "bad" : "ok" }))
				.sort((a, b) => (a.status === "bad" ? 0 : 1) - (b.status === "bad" ? 0 : 1) || String(a.title).localeCompare(String(b.title))),
			warnings: failing.length ? [`${failing.length} indexer(s) failing: ${failing.map((i) => i.name || i.id).join(", ")}`] : [],
			summary: null
		};
	}
};
