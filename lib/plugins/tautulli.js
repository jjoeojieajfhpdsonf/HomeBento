"use strict";
// Tautulli: what Plex is streaming right now (get_activity) and the libraries (get_libraries).
// API key: Tautulli → Settings → Web Interface → API key.
const L = (de, en) => ({ de, en });

async function call(json, url, apiKey, cmd) {
	const r = await json(`${url}/api/v2?apikey=${encodeURIComponent(apiKey)}&cmd=${cmd}`);
	const res = r && r.response;
	if (!res || res.result !== "success") throw new Error(`Tautulli: ${(res && res.message) || "unexpected answer"}`);
	return res.data;
}

// Tautulli reports the bandwidth in kbit/s; shown like Tautulli itself in Mbit/s
const mbit = (kbps) => `${(Number(kbps || 0) / 1000).toFixed(1)} Mbit/s`;

module.exports = {
	kind: "tautulli",
	label: "Tautulli",
	match: /tautulli/,
	repo: "Tautulli/Tautulli",
	ttl: 15000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Tautulli → Einstellungen → Web Interface → API key", "Tautulli → Settings → Web Interface → API key"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const [act, libs] = await Promise.all([call(json, url, secrets.apiKey, "get_activity"), call(json, url, secrets.apiKey, "get_libraries")]);
		const sessions = (act && act.sessions) || [];
		const libraries = Array.isArray(libs) ? libs : [];
		return {
			metrics: [
				{ value: Number(act && act.stream_count) || 0, label: L("Streams", "Streams") },
				{ value: mbit(act && act.total_bandwidth), label: L("Bandbreite", "Bandwidth") },
				{ value: libraries.length, label: L("Bibliotheken", "Libraries") }
			],
			items: sessions.map((s) => ({
				title: `${s.friendly_name || s.user || "?"} · ${s.full_title || s.title || "?"}`,
				sub: [s.player, s.progress_percent !== undefined ? `${s.progress_percent} %` : "", s.transcode_decision && s.transcode_decision !== "direct play" ? s.transcode_decision : ""].filter(Boolean).join(" · "),
				status: s.state === "paused" || s.state === "buffering" ? "warn" : "ok"
			})),
			summary: sessions.length ? `${sessions[0].friendly_name || sessions[0].user} · ${sessions[0].full_title || sessions[0].title}` : null
		};
	}
};
