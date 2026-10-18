"use strict";
// Traefik: routers, services and their errors from the API (/api/overview, /api/version).
// The API has to be enabled (api.insecure or a router to api@internal); basic auth is optional.
const L = (de, en) => ({ de, en });
const PROTOCOLS = ["http", "tcp", "udp"];
const PARTS = ["routers", "services", "middlewares"];

function sum(overview, part, key) {
	return PROTOCOLS.reduce((n, p) => n + ((overview[p] && overview[p][part] && overview[p][part][key]) || 0), 0);
}

module.exports = {
	kind: "traefik",
	label: "Traefik",
	match: /traefik/,
	repo: "traefik/traefik",
	ttl: 30000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur bei Basic Auth", "Only with basic auth") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const headers = secrets.username ? { Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password || ""}`).toString("base64")}` } : {};
		const [overview, version] = await Promise.all([json(`${url}/api/overview`, { headers }), json(`${url}/api/version`, { headers }).catch(() => null)]);
		const errors = PARTS.reduce((n, part) => n + sum(overview, part, "errors"), 0);
		const warns = PARTS.reduce((n, part) => n + sum(overview, part, "warnings"), 0);
		// only list the routers when something is wrong
		const bad = (p) => overview[p] && overview[p].routers && (overview[p].routers.errors || overview[p].routers.warnings);
		let broken = [];
		if (PROTOCOLS.some(bad)) {
			const lists = await Promise.all(PROTOCOLS.filter(bad).map((p) => json(`${url}/api/${p}/routers?per_page=1000`, { headers }).then((list) => list.map((r) => ({ ...r, protocol: p }))).catch(() => [])));
			broken = lists.flat().filter((r) => (r.error && r.error.length) || (r.status && r.status !== "enabled"));
		}
		const v = version && version.Version;
		return {
			metrics: [
				{ value: sum(overview, "routers", "total"), label: L("Router", "Routers") },
				{ value: sum(overview, "services", "total"), label: L("Dienste", "Services") },
				{ value: errors, label: L("Fehler", "Errors"), warn: errors > 0 },
				...(v ? [{ value: String(v).replace(/^v/, ""), label: "Version" }] : [])
			],
			items: broken.map((r) => ({
				title: r.name,
				sub: (r.error && r.error.join(", ")) || r.rule || r.protocol.toUpperCase(),
				status: r.status === "disabled" || (r.error && r.error.length && r.status !== "warning") ? "bad" : "warn"
			})),
			warnings: broken.some((r) => r.error && r.error.length)
				? broken.filter((r) => r.error && r.error.length).map((r) => `${r.name}: ${r.error.join(", ")}`)
				: errors ? [`${errors} error(s) in the Traefik configuration`] : [],
			summary: warns ? `${warns} warning(s)` : null
		};
	}
};
