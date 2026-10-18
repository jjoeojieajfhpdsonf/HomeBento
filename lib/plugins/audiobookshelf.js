"use strict";
// Audiobookshelf: books and podcasts per library (/api/libraries and /api/libraries/<id>/stats)
// and how long the key's user listened today (/api/me/listening-stats). Login: an API key
// (Settings → API Keys) or the API token of a user (older versions: Settings → Users → user).
const L = (de, en) => ({ de, en });

// seconds → "45 min", "3.5 h", "120 h"
function fmtDuration(sec) {
	const s = Number(sec) || 0;
	if (s < 3600) return `${Math.round(s / 60)} min`;
	const h = s / 3600;
	return h < 10 ? `${h.toFixed(1)} h` : `${Math.round(h).toLocaleString("en-US")} h`;
}

module.exports = {
	kind: "audiobookshelf",
	label: "Audiobookshelf",
	match: /audiobookshelf/,
	repo: "advplyr/audiobookshelf",
	ttl: 5 * 60000,
	fields: [
		{
			key: "apiKey",
			label: L("API-Schlüssel", "API key"),
			help: L("Einstellungen → API-Schlüssel (ältere Versionen: Einstellungen → Benutzer → Benutzer → API-Token)", "Settings → API Keys (older versions: Settings → Users → user → API token)"),
			secret: true
		}
	],
	fmtDuration,
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { Authorization: `Bearer ${secrets.apiKey}` };
		const r = await json(`${url}/api/libraries`, { headers });
		if (!r || !Array.isArray(r.libraries)) throw new Error("Unexpected answer from Audiobookshelf");
		const [libs, listening] = await Promise.all([
			Promise.all(r.libraries.map(async (l) => ({ ...l, stats: await json(`${url}/api/libraries/${encodeURIComponent(l.id)}/stats`, { headers }).catch(() => null) }))),
			json(`${url}/api/me/listening-stats`, { headers }).catch(() => null)
		]);
		const sum = (type, field) => libs.filter((l) => l.mediaType === type).reduce((a, l) => a + (Number(l.stats && l.stats[field]) || 0), 0);
		const hasPodcasts = libs.some((l) => l.mediaType === "podcast");
		const metrics = [{ value: sum("book", "totalItems"), label: L("Bücher", "Books") }];
		if (hasPodcasts) metrics.push({ value: sum("podcast", "totalItems"), label: "Podcasts" });
		metrics.push({ value: fmtDuration(sum("book", "totalDuration") + sum("podcast", "totalDuration")), label: L("Spieldauer", "Playtime") });
		if (listening) metrics.push({ value: fmtDuration(listening.today), label: L("heute gehört", "Listened today") });
		return {
			metrics,
			items: libs.map((l) => ({
				title: l.name,
				sub: l.stats ? [`${Number(l.stats.totalItems) || 0} ${l.mediaType === "podcast" ? "podcasts" : "books"}`, fmtDuration(l.stats.totalDuration)].join(" · ") : l.mediaType || "",
				status: l.stats ? "ok" : "warn"
			})),
			summary: listening && listening.totalTime ? `${fmtDuration(listening.totalTime)} listened in total` : null
		};
	}
};
