"use strict";
// Emby: current streams (/emby/Sessions) and the library counts (/emby/Items/Counts).
// API key: Emby → Settings → Advanced → API Keys.
const L = (de, en) => ({ de, en });

const what = (it) => {
	if (it.Type === "Episode") return `${it.SeriesName || ""} S${String(it.ParentIndexNumber || 0).padStart(2, "0")}E${String(it.IndexNumber || 0).padStart(2, "0")}`.trim();
	if (it.Type === "Audio") return [it.AlbumArtist || (it.Artists && it.Artists[0]), it.Name].filter(Boolean).join(" – ");
	return it.ProductionYear ? `${it.Name} (${it.ProductionYear})` : it.Name || "?";
};

module.exports = {
	kind: "emby",
	label: "Emby",
	match: /\bemby/,
	repo: "MediaBrowser/Emby.Releases",
	ttl: 10000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Emby → Einstellungen → Erweitert → API-Schlüssel", "Emby → Settings → Advanced → API Keys"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { "X-Emby-Token": secrets.apiKey };
		const [sessions, counts] = await Promise.all([json(`${url}/emby/Sessions`, { headers }), json(`${url}/emby/Items/Counts`, { headers })]);
		const now = (Array.isArray(sessions) ? sessions : [])
			.filter((s) => s.NowPlayingItem)
			.map((s) => {
				const it = s.NowPlayingItem;
				const pos = (s.PlayState && s.PlayState.PositionTicks) || 0;
				return { user: s.UserName || "?", title: what(it), device: s.DeviceName || s.Client || "", paused: !!(s.PlayState && s.PlayState.IsPaused), progress: it.RunTimeTicks ? Math.round((pos / it.RunTimeTicks) * 100) : null };
			});
		return {
			metrics: [
				{ value: now.length, label: L("Streams", "Streams") },
				{ value: counts.MovieCount ?? null, label: L("Filme", "Movies") },
				{ value: counts.SeriesCount ?? null, label: L("Serien", "Series") },
				{ value: counts.EpisodeCount ?? null, label: L("Episoden", "Episodes") }
			],
			items: now.map((n) => ({ title: `${n.user} · ${n.title}`, sub: [n.device, n.progress !== null ? `${n.progress} %` : "", n.paused ? "⏸" : ""].filter(Boolean).join(" · "), status: n.paused ? "warn" : "ok" })),
			summary: now.length ? `${now[0].user} · ${now[0].title}` : null
		};
	}
};
