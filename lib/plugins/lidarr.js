"use strict";
// Lidarr: library size, download queue, missing albums and health warnings (*arr API v1).
// API key: Settings → General → Security → API Key. readarr.js uses the same builder.
const L = (de, en) => ({ de, en });

// A plugin for an *arr app with the v1 API; `library` is the path of the main list (artist, author).
function make({ kind, label, match, repo, library, libraryLabel }) {
	return {
		kind,
		label,
		match,
		repo,
		ttl: 5 * 60000,
		fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Einstellungen → Allgemein → Sicherheit → API-Schlüssel", "Settings → General → Security → API Key"), secret: true }],
		async fetch({ url, secrets, json }) {
			if (!secrets.apiKey) throw new Error("API key missing");
			const h = { headers: { "X-Api-Key": secrets.apiKey } };
			// the library decides whether key and address are right; the rest is optional
			const lib = await json(`${url}/api/v1/${library}`, h);
			const [queue, missing, health] = await Promise.all([
				json(`${url}/api/v1/queue/status`, h).catch(() => null),
				json(`${url}/api/v1/wanted/missing?pageSize=1`, h).catch(() => null),
				json(`${url}/api/v1/health`, h).catch(() => [])
			]);
			const issues = (Array.isArray(health) ? health : []).filter((x) => x.type === "warning" || x.type === "error");
			return {
				metrics: [
					{ value: Array.isArray(lib) ? lib.length : null, label: libraryLabel },
					{ value: queue ? queue.totalCount ?? queue.count ?? 0 : null, label: L("Warteschlange", "Queue"), warn: !!(queue && (queue.errors || queue.unknownErrors)) },
					{ value: missing ? missing.totalRecords ?? 0 : null, label: L("fehlend", "Missing") },
					{ value: issues.length, label: L("Warnungen", "Warnings"), warn: issues.length > 0 }
				],
				items: issues.map((x) => ({ title: x.source || x.type, sub: x.message, status: x.type === "error" ? "bad" : "warn" })),
				warnings: issues.map((x) => x.message)
			};
		}
	};
}

module.exports = make({ kind: "lidarr", label: "Lidarr", match: /lidarr/, repo: "Lidarr/Lidarr", library: "artist", libraryLabel: L("Interpreten", "Artists") });
module.exports.make = make;
