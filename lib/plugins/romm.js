"use strict";
// RomM: platforms, ROMs, saves and the library size from /api/stats, and the ROMs per platform from
// /api/platforms when a login is given. Login: a user and password (HTTP basic auth) or an API
// token (Bearer). /api/stats also answers without a login.
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	b = Number(b) || 0;
	while (b >= 1000 && i < u.length - 1) (b /= 1000), i++;
	return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

module.exports = {
	kind: "romm",
	label: "RomM",
	// not the companion database or cache containers (romm-db, romm-redis)
	match: /(?:^|[^a-z])romm(?![a-z]|[-_.]?(db|mariadb|mysql|postgres|redis))/,
	repo: "rommapp/romm",
	ttl: 300000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Optional: Benutzer und Passwort oder ein API-Token, damit auch die Plattformen erscheinen", "Optional: user and password or an API token, so the platforms are listed too") },
		{ key: "password", label: L("Passwort", "Password"), secret: true },
		{ key: "token", label: L("API-Token", "API token"), help: L("Statt Benutzer/Passwort: RomM → Administration → Client API Tokens (rmm_…)", "Instead of user/password: RomM → Administration → Client API Tokens (rmm_…)"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const headers = secrets.token
			? { Authorization: `Bearer ${secrets.token}` }
			: secrets.username
				? { Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password || ""}`).toString("base64")}` }
				: {};
		const login = !!headers.Authorization;
		const [stats, platforms] = await Promise.all([json(`${url}/api/stats`, { headers }), login ? json(`${url}/api/platforms`, { headers }) : null]);
		if (!stats || stats.ROMS === undefined) throw new Error("Unexpected answer from RomM");
		const n = (k) => Number(stats[k]) || 0;
		const list = (Array.isArray(platforms) ? platforms : []).filter((p) => Number(p.rom_count) > 0).sort((a, b) => b.rom_count - a.rom_count);
		return {
			metrics: [
				{ value: n("PLATFORMS"), label: L("Plattformen", "Platforms") },
				{ value: n("ROMS"), label: L("ROMs", "ROMs") },
				{ value: n("SAVES"), label: L("Spielstände", "Saves") },
				{ value: fmtBytes(stats.TOTAL_FILESIZE_BYTES ?? stats.FILESIZE), label: L("Grösse", "Size") }
			],
			items: list.map((p) => ({
				title: p.display_name || p.custom_name || p.name || p.slug || "?",
				sub: [`${p.rom_count} ROMs`, p.fs_size_bytes ? fmtBytes(p.fs_size_bytes) : ""].filter(Boolean).join(" · "),
				status: "ok"
			})),
			summary: `${n("STATES")} save states · ${n("SCREENSHOTS")} screenshots`
		};
	}
};
