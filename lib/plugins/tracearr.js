"use strict";
// Tracearr: what Plex, Jellyfin and Emby stream right now and the open rule violations (alerts),
// from the public API (/api/v1/public/streams, /violations, /health) with a Bearer API key
// (Tracearr → Settings → API key, starts with trr_pub_).
const L = (de, en) => ({ de, en });

const pad = (n) => String(n).padStart(2, "0");

function title(s) {
	if (s.mediaType === "episode" && s.showTitle) {
		const ep = s.seasonNumber != null && s.episodeNumber != null ? ` S${pad(s.seasonNumber)}E${pad(s.episodeNumber)}` : "";
		return `${s.showTitle}${ep}`;
	}
	if (s.mediaType === "track" && s.artistName) return `${s.artistName} – ${s.mediaTitle}`;
	return s.year ? `${s.mediaTitle} (${s.year})` : s.mediaTitle || "?";
}

module.exports = {
	kind: "tracearr",
	label: "Tracearr",
	// not the companion containers (tracearr-db, tracearr-redis)
	match: /tracearr(?![-_.]?(db|redis|postgres|timescale))/,
	repo: "connorgallopo/Tracearr",
	ttl: 15000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Tracearr → Einstellungen → API-Schlüssel (beginnt mit trr_pub_)", "Tracearr → Settings → API key (starts with trr_pub_)"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { Authorization: `Bearer ${secrets.apiKey}` };
		const [streams, violations, health] = await Promise.all([
			json(`${url}/api/v1/public/streams`, { headers }),
			json(`${url}/api/v1/public/violations?acknowledged=false&page=1&pageSize=10`, { headers }).catch(() => null),
			json(`${url}/api/v1/public/health`, { headers }).catch(() => null)
		]);
		if (!streams || !Array.isArray(streams.data)) throw new Error("Unexpected answer from Tracearr");
		const sum = streams.summary || {};
		const open = violations && Array.isArray(violations.data) ? violations.data : null;
		const openCount = open ? Number((violations.meta && violations.meta.total) ?? open.length) || 0 : null;
		const offline = health && Array.isArray(health.servers) ? health.servers.filter((s) => s.online === false) : [];
		const items = streams.data.map((s) => ({
			title: `${s.username || "?"} · ${title(s)}`,
			sub: [s.device || s.player || s.serverName, s.durationMs > 0 ? `${Math.round((100 * (s.progressMs || 0)) / s.durationMs)} %` : "", s.isTranscode || s.videoDecision === "transcode" ? "transcode" : ""].filter(Boolean).join(" · "),
			status: s.state === "paused" ? "warn" : "ok"
		}));
		for (const v of open || []) {
			items.push({
				title: (v.rule && v.rule.name) || "Rule violation",
				sub: [v.user && v.user.username, v.serverName, v.severity].filter(Boolean).join(" · "),
				status: v.severity === "high" ? "bad" : "warn"
			});
		}
		return {
			metrics: [
				{ value: Number(sum.total ?? streams.data.length) || 0, label: L("Streams", "Streams") },
				{ value: Number(sum.transcodes) || 0, label: L("Transkodiert", "Transcodes") },
				sum.totalBitrate ? { value: String(sum.totalBitrate), label: L("Bitrate", "Bitrate") } : null,
				openCount !== null ? { value: openCount, label: L("Offene Warnungen", "Open alerts"), warn: openCount > 0 } : null
			].filter(Boolean),
			items,
			warnings: offline.map((s) => `Media server ${s.name || s.id} is offline`)
		};
	}
};
