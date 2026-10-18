"use strict";
// Gatus: endpoints and whether their latest check succeeded, from /api/v1/endpoints/statuses.
// No login by default; basic auth when Gatus has security.basic configured.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "gatus",
	label: "Gatus",
	match: /^(?!.*(postgres|mariadb|mysql|[-_ ]db\b)).*gatus/,
	repo: "TwiN/gatus",
	ttl: 30000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur nötig, wenn in Gatus security.basic eingerichtet ist", "Only if security.basic is set up in Gatus") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const login = secrets.username || secrets.password;
		const headers = login ? { Authorization: `Basic ${Buffer.from(`${secrets.username || ""}:${secrets.password || ""}`).toString("base64")}` } : {};
		let r;
		try {
			r = await json(`${url}/api/v1/endpoints/statuses?page=1&pageSize=20`, { headers });
		} catch (err) {
			if (!login && /Access denied/.test(err.message)) throw new Error("Login missing");
			throw err;
		}
		if (!Array.isArray(r)) throw new Error("Unexpected answer from Gatus");
		const endpoints = r.map((e) => {
			const results = Array.isArray(e.results) ? e.results : [];
			const last = results[results.length - 1];
			return {
				name: e.group ? `${e.group} / ${e.name}` : e.name || e.key || "?",
				state: !last ? null : last.success ? "up" : "down",
				ms: last && typeof last.duration === "number" ? Math.round(last.duration / 1e6) : null,
				error: last && Array.isArray(last.errors) && last.errors.length ? String(last.errors[0]) : null,
				ok: results.filter((x) => x.success).length,
				n: results.length
			};
		});
		const down = endpoints.filter((e) => e.state === "down");
		const up = endpoints.filter((e) => e.state === "up");
		const total = endpoints.reduce((a, e) => a + e.n, 0);
		const uptime = total ? (100 * endpoints.reduce((a, e) => a + e.ok, 0)) / total : null;
		return {
			metrics: [
				{ value: `${up.length}/${endpoints.length}`, label: L("Endpunkte OK", "Endpoints up") },
				{ value: down.length, label: L("ausgefallen", "down"), warn: down.length > 0 },
				{ value: uptime !== null ? `${uptime.toFixed(1)} %` : null, label: L("Verfügbarkeit", "Uptime"), warn: uptime !== null && uptime < 95 }
			],
			items: endpoints
				.sort((a, b) => (a.state === "down" ? 0 : 1) - (b.state === "down" ? 0 : 1) || a.name.localeCompare(b.name))
				.map((e) => ({ title: e.name, sub: e.state === "down" && e.error ? e.error.slice(0, 120) : e.ms !== null ? `${e.ms} ms` : "", status: e.state === "up" ? "ok" : e.state === "down" ? "bad" : "warn" })),
			warnings: down.map((e) => `${e.name} is down`),
			summary: down.length ? `${down.map((e) => e.name).join(", ")} down` : null
		};
	}
};
