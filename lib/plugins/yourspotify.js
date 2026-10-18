"use strict";
// Your Spotify: songs, listening time and artists of the last 7 days plus the top artists, from the
// server API (/spotify/songs_per, /time_per, /different_artists_per, /top/artists). Login is the
// public token (Your Spotify → Settings → Account → Public token) sent as ?token=. The address is
// the one of the server (API) container, not of the web client.
const L = (de, en) => ({ de, en });

const DAYS = 7;

function duration(ms) {
	const min = Math.round((Number(ms) || 0) / 60000);
	if (min < 60) return `${min} min`;
	const h = min / 60;
	return `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
}

const total = (rows, key) => (Array.isArray(rows) ? rows.reduce((a, r) => a + (Number(r && r[key]) || 0), 0) : 0);

module.exports = {
	kind: "yourspotify",
	label: "Your Spotify",
	// the server only: not the web client or the MongoDB container
	match: /your.?spotify(?![-_.]?(client|web|mongo|db))/,
	repo: "Yooooomi/your_spotify",
	ttl: 300000,
	fields: [
		{
			key: "token",
			label: L("Öffentliches Token", "Public token"),
			help: L(
				"Your Spotify → Einstellungen → Konto → Öffentliches Token generieren. Als Adresse die des Servers (API) eintragen, nicht die des Web-Clients.",
				"Your Spotify → Settings → Account → generate a public token. Use the address of the server (API), not of the web client."
			),
			secret: true
		}
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Public token missing");
		const end = new Date();
		const start = new Date(end.getTime() - DAYS * 86400000);
		const q = `start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&token=${encodeURIComponent(secrets.token)}`;
		const get = (path, extra = "") => json(`${url}/spotify/${path}?${q}${extra}`);
		const [songs, time, artists, top] = await Promise.all([
			get("songs_per", "&timeSplit=all"),
			get("time_per", "&timeSplit=all"),
			get("different_artists_per", "&timeSplit=all"),
			get("top/artists", "&nb=5").catch(() => [])
		]);
		if (!Array.isArray(songs) || !Array.isArray(time)) throw new Error("Unexpected answer from Your Spotify");
		const artistCount = Array.isArray(artists) && artists[0] && Array.isArray(artists[0].artists) ? artists[0].artists.length : 0;
		return {
			metrics: [
				{ value: total(songs, "count"), label: L(`Songs (${DAYS} T.)`, `Songs (${DAYS} d)`) },
				{ value: duration(total(time, "count")), label: L(`Hörzeit (${DAYS} T.)`, `Listened (${DAYS} d)`) },
				{ value: artistCount, label: L("Künstler", "Artists") }
			],
			items: (Array.isArray(top) ? top : []).map((a) => ({
				title: (a.artist && a.artist.name) || "?",
				sub: [`${Number(a.count) || 0} ${Number(a.count) === 1 ? "play" : "plays"}`, a.duration_ms ? duration(a.duration_ms) : ""].filter(Boolean).join(" · "),
				status: "ok"
			}))
		};
	}
};
