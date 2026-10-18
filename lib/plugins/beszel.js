"use strict";
// Beszel (hub): monitored systems, whether they are up, and CPU, RAM and disk use of each, from the
// PocketBase API. Logs in with a Beszel user (or the superuser) via
// /api/collections/users/auth-with-password and reads /api/collections/systems/records with the
// token. The token is kept in memory and renewed when it stops working.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const tokens = new Map(); // url + login hash -> token
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;
const pct = (x) => (typeof x === "number" && isFinite(x) ? Math.round(x) : null);

async function login(url, identity, password, request) {
	// normal users first, then the PocketBase superuser (PocketBase ≥ 0.23)
	for (const coll of ["users", "_superusers"]) {
		const r = await request(`${url}/api/collections/${coll}/auth-with-password`, { method: "POST", body: { identity, password }, headers: { "Content-Type": "application/json", Accept: "application/json" }, timeout: 10000 });
		if (!r.status) throw new Error(r.error);
		if (r.status === 200) {
			let body = null;
			try {
				body = JSON.parse(r.body.toString("utf8"));
			} catch {
				// handled below
			}
			if (!body || !body.token) throw new Error("Unexpected answer from Beszel");
			return body.token;
		}
		if (r.status === 429) throw new Error("Too many login attempts, try again later");
		// 400 = wrong login, 404 = collection unknown: try the next one
		if (r.status !== 400 && r.status !== 401 && r.status !== 403 && r.status !== 404) throw new Error(`HTTP ${r.status}`);
	}
	throw new Error("Access denied (check user and password)");
}

async function systems(url, token, request) {
	const r = await request(`${url}/api/collections/systems/records?page=1&perPage=500&sort=%2Bname`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, timeout: 10000 });
	if (!r.status) throw new Error(r.error);
	if (r.status === 400 || r.status === 401 || r.status === 403) return null; // token no longer valid
	if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
	let body;
	try {
		body = JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error("Unexpected answer (not JSON)");
	}
	if (!body || !Array.isArray(body.items)) throw new Error("Unexpected answer from Beszel");
	return body.items;
}

module.exports = {
	kind: "beszel",
	label: "Beszel",
	match: /^(?!.*agent).*beszel/,
	repo: "henrygd/beszel",
	ttl: 30000,
	fields: [
		{ key: "username", label: L("E-Mail", "Email"), help: L("Login eines Beszel-Benutzers (sieht nur seine Systeme) oder des Superusers", "Login of a Beszel user (sees only their systems) or of the superuser") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, request }) {
		if (!secrets.username || !secrets.password) throw new Error("Login missing");
		const key = keyOf(url, secrets.username, secrets.password);
		let list = null;
		if (tokens.has(key)) {
			list = await systems(url, tokens.get(key), request);
			// an expired token may also just see no systems: log in again then
			if (!list || !list.length) {
				tokens.delete(key);
				list = null;
			}
		}
		if (!list) {
			const token = await login(url, secrets.username, secrets.password, request);
			tokens.set(key, token);
			list = await systems(url, token, request);
			if (!list) throw new Error("Access denied (check user and password)");
		}
		const all = list.map((s) => {
			const i = s.info || {};
			return { name: s.name || s.host || s.id, status: s.status || "pending", cpu: pct(i.cpu), mem: pct(i.mp), disk: pct(i.dp) };
		});
		const up = all.filter((s) => s.status === "up");
		const down = all.filter((s) => s.status === "down");
		const max = (k) => up.reduce((a, s) => (s[k] !== null && (a === null || s[k] > a) ? s[k] : a), null);
		const cpu = max("cpu");
		const disk = max("disk");
		const rank = (s) => (s.status === "down" ? 0 : s.status === "up" ? 2 : 1);
		return {
			metrics: [
				{ value: `${up.length}/${all.length}`, label: L("Systeme online", "Systems up"), warn: down.length > 0 },
				{ value: down.length, label: L("ausgefallen", "down"), warn: down.length > 0 },
				{ value: cpu !== null ? `${cpu} %` : null, label: L("CPU max.", "CPU max"), warn: cpu > 90 },
				{ value: disk !== null ? `${disk} %` : null, label: L("Disk max.", "Disk max"), warn: disk > 90 }
			],
			items: all
				.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
				.map((s) => ({
					title: s.name,
					sub: s.status === "up" ? [s.cpu !== null ? `CPU ${s.cpu} %` : "", s.mem !== null ? `RAM ${s.mem} %` : "", s.disk !== null ? `Disk ${s.disk} %` : ""].filter(Boolean).join(" · ") : s.status,
					status: s.status === "up" ? (s.disk > 90 || s.mem > 90 ? "warn" : "ok") : s.status === "down" ? "bad" : "warn"
				})),
			warnings: down.map((s) => `${s.name} is down`),
			summary: down.length ? `${down.map((s) => s.name).join(", ")} down` : null
		};
	}
};
