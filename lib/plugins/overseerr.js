"use strict";
// Overseerr and Jellyseerr (same API): requests by state and whether an update is waiting.
// API key: Settings → General → API Key. No repo for the Updates tile: the kind covers two projects,
// the update hint comes from /api/v1/status instead.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "overseerr",
	label: "Overseerr / Jellyseerr",
	match: /overseerr|jellyseerr|\bseerr/,
	ttl: 60000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Einstellungen → Allgemein → API-Schlüssel", "Settings → General → API Key"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { "X-Api-Key": secrets.apiKey };
		const [count, status] = await Promise.all([json(`${url}/api/v1/request/count`, { headers }), json(`${url}/api/v1/status`, { headers }).catch(() => null)]);
		const warnings = [];
		if (status && status.updateAvailable) warnings.push(`Update available${status.commitsBehind ? ` (${status.commitsBehind} commits behind)` : ""}`);
		if (status && status.restartRequired) warnings.push("Restart required");
		return {
			metrics: [
				{ value: count.pending ?? 0, label: L("offen", "Pending") },
				{ value: count.approved ?? 0, label: L("genehmigt", "Approved") },
				{ value: count.processing ?? 0, label: L("in Arbeit", "Processing") },
				{ value: count.available ?? 0, label: L("verfügbar", "Available") }
			],
			warnings,
			summary: status && status.version ? `v${status.version}` : null
		};
	}
};
