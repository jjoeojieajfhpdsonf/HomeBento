"use strict";
// Navidrome: what is playing (getNowPlaying), library size (getArtists, getScanStatus) and the
// newest album (getAlbumList2) over the Subsonic API. Login: a Navidrome user and its password;
// the password is never sent, only md5(password + salt) with a fresh salt per request.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "navidrome",
	label: "Navidrome",
	match: /navidrome/,
	repo: "navidrome/navidrome",
	ttl: 30000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Ein Navidrome-Benutzer (Admin nicht nötig)", "A Navidrome user (admin not needed)") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.username || !secrets.password) throw new Error("User or password missing");
		const call = async (method, params = {}) => {
			const salt = crypto.randomBytes(8).toString("hex");
			const token = crypto.createHash("md5").update(secrets.password + salt).digest("hex");
			const q = new URLSearchParams({ u: secrets.username, t: token, s: salt, v: "1.16.1", c: "HomeBento", f: "json", ...params });
			const r = await json(`${url}/rest/${method}?${q}`);
			const sr = r && r["subsonic-response"];
			if (!sr) throw new Error("Unexpected answer from Navidrome");
			if (sr.status !== "ok") {
				const e = sr.error || {};
				// 40 wrong login, 41 token login not allowed, 44 unknown user
				if ([40, 41, 44].includes(Number(e.code))) throw new Error("Access denied (check the user and password)");
				throw new Error(`Navidrome: ${e.message || "error"}`);
			}
			return sr;
		};
		const [playing, artists, scan, newest] = await Promise.all([
			call("getNowPlaying"),
			call("getArtists").catch(() => null),
			call("getScanStatus").catch(() => null),
			call("getAlbumList2", { type: "newest", size: "1" }).catch(() => null)
		]);
		const entries = [].concat((playing.nowPlaying && playing.nowPlaying.entry) || []);
		const index = (artists && artists.artists && artists.artists.index) || [];
		const artistList = index.flatMap((i) => [].concat(i.artist || []));
		const albums = artistList.reduce((a, x) => a + (Number(x.albumCount) || 0), 0);
		const st = scan && scan.scanStatus;
		const latest = newest && newest.albumList2 && [].concat(newest.albumList2.album || [])[0];
		const metrics = [{ value: entries.length, label: L("läuft gerade", "Playing") }];
		if (artists) metrics.push({ value: albums, label: L("Alben", "Albums") }, { value: artistList.length, label: L("Interpreten", "Artists") });
		if (st && st.count !== undefined) metrics.push({ value: Number(st.count) || 0, label: L("Titel", "Tracks") });
		return {
			metrics,
			items: entries.map((e) => ({
				title: [e.username, [e.artist, e.title].filter(Boolean).join(" – ")].filter(Boolean).join(" · "),
				sub: [e.album, e.playerName, e.minutesAgo ? `${e.minutesAgo} min ago` : ""].filter(Boolean).join(" · "),
				status: "ok"
			})),
			summary: st && st.scanning ? "Library scan running" : latest ? `Newest: ${[latest.artist, latest.name].filter(Boolean).join(" – ")}` : null
		};
	}
};
