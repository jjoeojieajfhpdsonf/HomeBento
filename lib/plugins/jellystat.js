"use strict";
// Jellystat: Jellyfin plays and watch time of the last 7 days and the most active users, from the
// stats API (/stats/getViewsByLibraryType, /stats/getViewsOverTime, /stats/getMostActiveUsers).
// API key: Jellystat → Settings → API Keys, sent as the x-api-token header.
const L = (de, en) => ({ de, en });

const DAYS = 7;

// Jellystat sums the watch time per day in minutes
function duration(min) {
	min = Math.round(Number(min) || 0);
	if (min < 60) return `${min} min`;
	const h = min / 60;
	return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

async function call(request, url, apiKey, path, body) {
	const r = await request(`${url}/stats/${path}`, {
		method: body ? "POST" : "GET",
		body,
		headers: { "x-api-token": apiKey, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }
	});
	if (!r.status) throw new Error(r.error);
	let data = null;
	try {
		data = JSON.parse(r.body.toString("utf8"));
	} catch {
		// handled below
	}
	if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the API key)");
	if (r.status === 404 && data && /api key/i.test(data.message || "")) throw new Error("No API key is set up in Jellystat (Settings → API Keys)");
	if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
	if (data === null) throw new Error("Unexpected answer from Jellystat (not JSON)");
	return data;
}

module.exports = {
	kind: "jellystat",
	label: "Jellystat",
	// not the companion database container (jellystat-db)
	match: /jellystat(?![-_.]?(db|postgres|database))/,
	repo: "CyferShepard/Jellystat",
	ttl: 300000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Jellystat → Einstellungen → API-Schlüssel", "Jellystat → Settings → API Keys"), secret: true }],
	async fetch({ url, secrets, request }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const [byType, users, overTime] = await Promise.all([
			call(request, url, secrets.apiKey, `getViewsByLibraryType?days=${DAYS}`),
			call(request, url, secrets.apiKey, "getMostActiveUsers", { days: DAYS }),
			// older versions have no duration in this answer: then the watch time is left out
			call(request, url, secrets.apiKey, `getViewsOverTime?days=${DAYS}`).catch(() => null)
		]);
		if (!byType || typeof byType !== "object" || Array.isArray(byType)) throw new Error("Unexpected answer from Jellystat");
		const n = (k) => Number(byType[k]) || 0;
		const plays = n("Audio") + n("Movie") + n("Series") + n("Other");
		let minutes = null;
		if (overTime && Array.isArray(overTime.stats)) {
			for (const day of overTime.stats) {
				for (const v of Object.values(day || {})) if (v && typeof v === "object" && v.duration !== undefined) minutes = (minutes || 0) + (Number(v.duration) || 0);
			}
		}
		const top = (Array.isArray(users) ? users : []).map((u) => ({ name: u.Name || u.UserName || "?", plays: Number(u.Plays) || 0 })).filter((u) => u.plays > 0);
		const parts = [[n("Series"), "episodes"], [n("Movie"), "movies"], [n("Audio"), "songs"], [n("Other"), "other"]].filter(([v]) => v > 0);
		return {
			metrics: [
				{ value: plays, label: L(`Wiedergaben (${DAYS} T.)`, `Plays (${DAYS} d)`) },
				minutes !== null ? { value: duration(minutes), label: L(`Wiedergabezeit (${DAYS} T.)`, `Watch time (${DAYS} d)`) } : null,
				{ value: top.length ? top[0].name : "–", label: L("Aktivster Benutzer", "Top user") }
			].filter(Boolean),
			items: top.map((u) => ({ title: u.name, sub: `${u.plays} ${u.plays === 1 ? "play" : "plays"}`, status: "ok" })),
			summary: parts.length ? parts.map(([v, w]) => `${v} ${w}`).join(" · ") : null
		};
	}
};
