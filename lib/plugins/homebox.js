"use strict";
// Homebox: items, locations, labels and the total value of the inventory from
// /api/v1/groups/statistics. Logs in with username and password (POST /api/v1/users/login); the
// token is kept in memory and renewed after a 401.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const sessions = new Map(); // url + login hash -> "Bearer …"
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;

const num = (v, locale) => Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");
const money = (v, code) => (code ? L(`${code} ${num(v, "de-CH")}`, `${code} ${num(v, "en-US")}`) : L(num(v, "de-CH"), num(v, "en-US")));

async function login(url, username, password, request) {
	const body = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
	const r = await request(`${url}/api/v1/users/login`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, timeout: 10000 });
	if (!r.status) throw new Error(r.error);
	if (r.status === 401 || r.status === 403) throw new Error("Access denied (check username and password)");
	if (r.status >= 400) throw new Error(`Login failed (HTTP ${r.status})`);
	let data;
	try {
		data = JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error("Unexpected answer from Homebox (not JSON)");
	}
	if (!data || !data.token) throw new Error("Login failed");
	return /^Bearer /i.test(data.token) ? data.token : `Bearer ${data.token}`;
}

async function load(url, token, json) {
	const headers = { Authorization: token };
	const [stats, group, locations] = await Promise.all([
		json(`${url}/api/v1/groups/statistics`, { headers }),
		json(`${url}/api/v1/groups`, { headers }).catch(() => null),
		json(`${url}/api/v1/locations`, { headers }).catch(() => null)
	]);
	return { stats, group, locations };
}

module.exports = {
	kind: "homebox",
	label: "Homebox",
	match: /homebox/,
	repo: "sysadminsmedia/homebox",
	ttl: 300000,
	fields: [
		{ key: "username", label: L("Benutzername (E-Mail)", "Username (email)"), help: L("Die Anmeldedaten eines Homebox-Benutzers", "The login of a Homebox user") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, request, json }) {
		if (!secrets.username || !secrets.password) throw new Error("Username or password missing");
		const key = keyOf(url, secrets.username, secrets.password);
		let data = null;
		if (sessions.has(key)) {
			try {
				data = await load(url, sessions.get(key), json);
			} catch (err) {
				sessions.delete(key);
				if (!/Access denied/.test(err.message)) throw err;
				// token expired: log in again below
			}
		}
		if (!data) {
			const token = await login(url, secrets.username, secrets.password, request);
			sessions.set(key, token);
			data = await load(url, token, json);
		}
		const { stats, group, locations } = data;
		if (!stats || typeof stats.totalItems !== "number") throw new Error("Unexpected answer from Homebox");
		const currency = group && typeof group.currency === "string" ? group.currency.toUpperCase() : "";
		return {
			metrics: [
				{ value: stats.totalItems, label: L("Gegenstände", "Items") },
				{ value: stats.totalLocations ?? null, label: L("Orte", "Locations") },
				{ value: stats.totalLabels ?? null, label: L("Etiketten", "Labels") },
				{ value: typeof stats.totalItemPrice === "number" ? money(stats.totalItemPrice, currency) : null, label: L("Gesamtwert", "Total value") }
			],
			items: (Array.isArray(locations) ? locations : [])
				.map((l) => ({ name: l.name || "?", count: Number(l.itemCount) || 0 }))
				.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
				.map((l) => ({ title: l.name, sub: `${l.count} items`, status: "ok" })),
			summary: stats.totalWithWarranty ? `${stats.totalWithWarranty} with warranty` : null
		};
	}
};
