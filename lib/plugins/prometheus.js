"use strict";
// Prometheus: scrape targets and their health from /api/v1/targets (no login by default).
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "prometheus",
	label: "Prometheus",
	match: /prometheus/,
	repo: "prometheus/prometheus",
	ttl: 30000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur bei Basic Auth", "Only with basic auth") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const headers = secrets.username ? { Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password || ""}`).toString("base64")}` } : {};
		const r = await json(`${url}/api/v1/targets?state=active`, { headers });
		const targets = ((r.data && r.data.activeTargets) || []).map((x) => ({ job: x.labels.job || x.scrapePool, instance: x.labels.instance || x.scrapeUrl, health: x.health, error: x.lastError || "" }));
		const down = targets.filter((x) => x.health !== "up");
		return {
			metrics: [
				{ value: targets.length, label: L("Ziele", "Targets") },
				{ value: down.length, label: L("ausgefallen", "down"), warn: down.length > 0 },
				{ value: new Set(targets.map((x) => x.job)).size, label: "Jobs" }
			],
			items: targets.sort((a, b) => (a.health === "up") - (b.health === "up") || a.job.localeCompare(b.job)).map((x) => ({ title: x.job, sub: x.health === "up" ? x.instance : x.error || x.instance, status: x.health === "up" ? "ok" : "bad" })),
			warnings: down.map((x) => `${x.job} (${x.instance}) is down${x.error ? `: ${x.error}` : ""}`),
			summary: down.length ? `${down.length} target(s) down` : null
		};
	}
};
