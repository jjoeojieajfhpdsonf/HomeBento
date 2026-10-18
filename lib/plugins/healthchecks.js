"use strict";
// Healthchecks (healthchecks.io or self-hosted): all checks and whether they are up, late (grace)
// or down, from GET /api/v3/checks/ with a project API key in the X-Api-Key header
// (Project → Settings → API Access; the read-only key is enough).
const L = (de, en) => ({ de, en });

function age(iso) {
	const t = Date.parse(iso);
	if (!iso || isNaN(t)) return "";
	const min = Math.max(0, Math.round((Date.now() - t) / 60000));
	if (min < 60) return `${min} min`;
	if (min < 48 * 60) return `${Math.round(min / 60)} h`;
	return `${Math.round(min / 1440)} d`;
}

const STATUS = { up: "ok", started: "ok", grace: "warn", down: "bad" };

module.exports = {
	kind: "healthchecks",
	label: "Healthchecks",
	match: /^(?!.*(postgres|mariadb|mysql|[-_ ]db\b)).*healthchecks/,
	repo: "healthchecks/healthchecks",
	ttl: 60000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Projekt → Settings → API Access (der Nur-Lese-Schlüssel genügt)", "Project → Settings → API Access (the read-only key is enough)"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const r = await json(`${url}/api/v3/checks/`, { headers: { "X-Api-Key": secrets.apiKey } });
		if (!r || !Array.isArray(r.checks)) throw new Error("Unexpected answer from Healthchecks");
		const checks = r.checks.map((c) => ({ name: c.name || c.slug || "?", status: c.status || "new", lastPing: c.last_ping }));
		const down = checks.filter((c) => c.status === "down");
		const grace = checks.filter((c) => c.status === "grace");
		const up = checks.filter((c) => c.status === "up" || c.status === "started");
		const rank = (c) => (c.status === "down" ? 0 : c.status === "grace" ? 1 : 2);
		return {
			metrics: [
				{ value: `${up.length}/${checks.length}`, label: L("Checks OK", "Checks up") },
				{ value: down.length, label: L("ausgefallen", "down"), warn: down.length > 0 },
				{ value: grace.length, label: L("verspätet", "late"), warn: grace.length > 0 }
			],
			items: checks
				.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
				.map((c) => ({ title: c.name, sub: [c.status, c.lastPing ? age(c.lastPing) : ""].filter(Boolean).join(" · "), status: STATUS[c.status] || "warn" })),
			warnings: down.map((c) => `${c.name} is down`),
			summary: down.length ? `${down.map((c) => c.name).join(", ")} down` : grace.length ? `${grace.map((c) => c.name).join(", ")} late` : null
		};
	}
};
