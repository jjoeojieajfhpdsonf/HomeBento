"use strict";
// Plex Media Server: current streams from /status/sessions and the size of the movie, show and
// music libraries. Needs the X-Plex-Token (Plex Web → any item → … → Get Info → View XML, "X-Plex-Token=" in the address).
const L = (de, en) => ({ de, en });

const what = (m) => {
	if (m.type === "episode") return `${m.grandparentTitle || ""} S${String(m.parentIndex || 0).padStart(2, "0")}E${String(m.index || 0).padStart(2, "0")}`.trim();
	if (m.type === "track") return [m.grandparentTitle, m.title].filter(Boolean).join(" – ");
	return m.year ? `${m.title} (${m.year})` : m.title || "?";
};

module.exports = {
	kind: "plex",
	label: "Plex",
	// "plex" as a word or the official image, but not Tautulli, Overseerr & co. running next to it
	match: /^(?!.*(?:tautulli|seerr|ombi|kometa)).*(?:\bplex|pms-docker)/,
	ttl: 15000,
	fields: [{ key: "token", label: "X-Plex-Token", help: L("Plex Web → Medium → … → Medieninfo → XML anzeigen, Wert von X-Plex-Token in der Adresse", "Plex Web → item → … → Get Info → View XML, value of X-Plex-Token in the address"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Token missing");
		const headers = { "X-Plex-Token": secrets.token, Accept: "application/json" };
		const [sessions, sections] = await Promise.all([json(`${url}/status/sessions`, { headers }), json(`${url}/library/sections`, { headers })]);
		const now = ((sessions.MediaContainer && sessions.MediaContainer.Metadata) || []).map((m) => ({
			user: (m.User && m.User.title) || "?",
			title: what(m),
			paused: m.Player && m.Player.state === "paused",
			device: (m.Player && (m.Player.title || m.Player.product)) || "",
			progress: m.duration ? Math.round(((m.viewOffset || 0) / m.duration) * 100) : null
		}));
		// the number of items per library type; one cheap call per library (container size 0)
		const dirs = ((sections.MediaContainer && sections.MediaContainer.Directory) || []).filter((d) => ["movie", "show", "artist"].includes(d.type));
		const counts = { movie: 0, show: 0, artist: 0 };
		const has = { movie: false, show: false, artist: false };
		await Promise.all(
			dirs.map(async (d) => {
				has[d.type] = true;
				const r = await json(`${url}/library/sections/${encodeURIComponent(d.key)}/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0`, { headers }).catch(() => null);
				const c = r && r.MediaContainer;
				if (c) counts[d.type] += Number(c.totalSize ?? c.size) || 0;
			})
		);
		const metrics = [
			{ value: now.length, label: L("Streams", "Streams") },
			{ value: has.movie ? counts.movie : null, label: L("Filme", "Movies") },
			{ value: has.show ? counts.show : null, label: L("Serien", "Shows") }
		];
		if (has.artist) metrics.push({ value: counts.artist, label: L("Interpreten", "Artists") });
		return {
			metrics,
			items: now.map((n) => ({ title: `${n.user} · ${n.title}`, sub: [n.device, n.progress !== null ? `${n.progress} %` : "", n.paused ? "⏸" : ""].filter(Boolean).join(" · "), status: n.paused ? "warn" : "ok" })),
			summary: now.length ? `${now[0].user} · ${now[0].title}` : null
		};
	}
};
