"use strict";
// Tube Archivist: videos, channels, the download queue and the archive size from the statistics
// endpoints (/api/stats/video|channel|download|playlist). Login: the API token, sent as
// "Authorization: Token …" (Settings → Application → API token).
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	b = Number(b) || 0;
	while (b >= 1000 && i < u.length - 1) (b /= 1000), i++;
	return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

module.exports = {
	kind: "tubearchivist",
	label: "Tube Archivist",
	// not the companion Elasticsearch / Redis containers (tubearchivist-es, archivist-redis)
	match: /tube.?archivist(?![-_.]?(es|redis|elastic))/,
	repo: "tubearchivist/tubearchivist",
	ttl: 5 * 60000,
	fields: [{ key: "token", label: "API-Token", help: L("Einstellungen → Anwendung → API-Token", "Settings → Application → API token"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("API token missing");
		const headers = { Authorization: `Token ${secrets.token}` };
		const [video, channel, download, playlist] = await Promise.all([
			json(`${url}/api/stats/video/`, { headers }),
			json(`${url}/api/stats/channel/`, { headers }),
			json(`${url}/api/stats/download/`, { headers }),
			json(`${url}/api/stats/playlist/`, { headers }).catch(() => null)
		]);
		if (!video || video.doc_count === undefined) throw new Error("Unexpected answer from Tube Archivist");
		const n = (v) => Number(v) || 0;
		return {
			metrics: [
				{ value: n(video.doc_count), label: L("Videos", "Videos") },
				{ value: n(channel && channel.doc_count), label: L("Kanäle", "Channels") },
				{ value: n(download && download.pending), label: L("Download-Warteschlange", "Download queue") },
				{ value: fmtBytes(video.media_size), label: L("Grösse", "Size") }
			],
			summary: [video.duration_str ? `${video.duration_str} of video` : "", playlist && playlist.doc_count ? `${n(playlist.doc_count)} playlists` : ""].filter(Boolean).join(" · ") || null
		};
	}
};
