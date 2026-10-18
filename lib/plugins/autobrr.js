"use strict";
// autobrr: releases pushed today (/api/release, push_status=PUSH_APPROVED), all approved pushes
// (/api/release/stats), active filters (/api/filters) and the health of the IRC networks (/api/irc).
// Login: an API key, sent as X-API-Token (Settings → API keys).
const L = (de, en) => ({ de, en });

const PAGE = 100; // releases looked at for "today"

function startOfToday() {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

module.exports = {
	kind: "autobrr",
	label: "autobrr",
	// not the companions published under ghcr.io/autobrr/ (omegabrr, dashbrr, …)
	match: /autobrr(?!\/(?!autobrr))/,
	repo: "autobrr/autobrr",
	ttl: 60000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("autobrr → Einstellungen → API-Schlüssel", "autobrr → Settings → API keys"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { "X-API-Token": secrets.apiKey };
		const [stats, filters, irc, recent] = await Promise.all([
			json(`${url}/api/release/stats`, { headers }),
			json(`${url}/api/filters`, { headers }),
			json(`${url}/api/irc`, { headers }).catch(() => null),
			json(`${url}/api/release?offset=0&limit=${PAGE}&push_status=PUSH_APPROVED`, { headers }).catch(() => null)
		]);
		if (!stats || stats.push_approved_count === undefined) throw new Error("Unexpected answer from autobrr");
		const filterList = Array.isArray(filters) ? filters : (filters && filters.filters) || [];
		const networks = Array.isArray(irc) ? irc.filter((n) => n.enabled) : [];
		const unhealthy = networks.filter((n) => !n.healthy);
		const metrics = [];
		if (recent && Array.isArray(recent.data)) {
			const since = startOfToday();
			const pushedAt = (rel) => {
				const ok = [].concat(rel.action_status || []).filter((a) => a.status === "PUSH_APPROVED").map((a) => Date.parse(a.timestamp)).filter((t) => !Number.isNaN(t));
				return ok.length ? Math.max(...ok) : Date.parse(rel.timestamp);
			};
			const today = recent.data.filter((rel) => pushedAt(rel) >= since).length;
			metrics.push({ value: today >= PAGE ? `${PAGE}+` : today, label: L("heute gepusht", "Pushed today") });
		}
		metrics.push(
			{ value: Number(stats.push_approved_count) || 0, label: L("gepusht total", "Pushed total") },
			{ value: `${filterList.filter((f) => f.enabled).length}/${filterList.length}`, label: L("Filter aktiv", "Filters active") }
		);
		if (irc) metrics.push({ value: `${networks.length - unhealthy.length}/${networks.length}`, label: L("IRC gesund", "IRC healthy"), warn: unhealthy.length > 0 });
		return {
			metrics,
			items: networks.map((n) => {
				const errors = [].concat(n.connection_errors || []).filter(Boolean);
				return { title: n.name, sub: [n.server, n.healthy ? "" : n.connected ? "unhealthy" : "disconnected", errors[0] || ""].filter(Boolean).join(" · "), status: n.healthy ? "ok" : "bad" };
			}),
			warnings: unhealthy.map((n) => `IRC network ${n.name} is ${n.connected ? "unhealthy" : "disconnected"}`),
			summary: Number(stats.push_error_count) > 0 ? `${stats.push_error_count} push error(s)` : null
		};
	}
};
