"use strict";
// Immich: photos, videos and storage from the server statistics. Needs an API key of an admin
// (Immich → Account settings → API keys, permission server.statistics).
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	b = Number(b) || 0;
	while (b >= 1000 && i < u.length - 1) (b /= 1000), i++;
	return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

module.exports = {
	kind: "immich",
	label: "Immich",
	match: /^(?!.*(machine.?learning|postgres|redis|valkey)).*immich/,
	repo: "immich-app/immich",
	ttl: 5 * 60000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Immich → Kontoeinstellungen → API-Schlüssel (Admin-Konto)", "Immich → Account settings → API keys (admin account)"), secret: true }],
	fmtBytes,
	async fetch({ url, secrets, request, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { "x-api-key": secrets.apiKey };
		// newer servers use /api/server, older ones /api/server-info
		let prefix = "/api/server";
		let ver = null;
		const probe = await request(`${url}/api/server/version`, { headers: { Accept: "application/json", ...headers } });
		if (probe.status === 404) {
			prefix = "/api/server-info";
			ver = await json(`${url}${prefix}/version`, { headers });
		} else if (probe.status === 200) {
			try {
				ver = JSON.parse(probe.body.toString("utf8"));
			} catch {
				ver = null;
			}
		} else if (!probe.status) throw new Error(probe.error);
		const stats = await json(`${url}${prefix}/statistics`, { headers });
		const version = ver && ver.major !== undefined ? `${ver.major}.${ver.minor}.${ver.patch}` : null;
		return {
			metrics: [
				{ value: stats.photos || 0, label: L("Fotos", "Photos") },
				{ value: stats.videos || 0, label: "Videos" },
				{ value: fmtBytes(stats.usage), label: L("Speicher", "Storage") },
				{ value: Array.isArray(stats.usageByUser) ? stats.usageByUser.length : 0, label: L("Benutzer", "Users") }
			],
			items: (stats.usageByUser || []).map((u) => ({ title: u.userName || u.userId, sub: `${u.photos || 0} · ${u.videos || 0} · ${fmtBytes(u.usage)}`, status: "ok" })),
			summary: version ? `v${version}` : null
		};
	}
};
