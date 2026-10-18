"use strict";
// TrueNAS SCALE / CORE: pools, alerts and system info from the REST API v2.0 with an API key
// (user menu → API Keys). TrueNAS revokes keys that are sent over plain HTTP, so use https.
const L = (de, en) => ({ de, en });

const BAD = new Set(["FAULTED", "UNAVAIL", "OFFLINE", "REMOVED"]);
const LOUD = new Set(["WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"]);

// 93784 → "1 d", 7300 → "2 h", 300 → "5 min"
function uptime(sec) {
	if (!(sec >= 0)) return null;
	if (sec >= 86400) return `${Math.floor(sec / 86400)} d`;
	if (sec >= 3600) return `${Math.floor(sec / 3600)} h`;
	return `${Math.floor(sec / 60)} min`;
}

module.exports = {
	kind: "truenas",
	label: "TrueNAS",
	match: /truenas|freenas/,
	ttl: 60000,
	fields: [
		{
			key: "apiKey",
			label: L("API-Schlüssel", "API key"),
			help: L(
				"TrueNAS → Benutzermenü → API-Schlüssel. Adresse mit https:// angeben – über http gesendete Schlüssel sperrt TrueNAS.",
				"TrueNAS → user menu → API Keys. Use an https:// address – TrueNAS revokes keys that are sent over http."
			),
			secret: true
		}
	],
	uptime,
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { Authorization: `Bearer ${secrets.apiKey}` };
		const [info, pools, alerts] = await Promise.all([json(`${url}/api/v2.0/system/info`, { headers }), json(`${url}/api/v2.0/pool`, { headers }), json(`${url}/api/v2.0/alert/list`, { headers })]);
		if (!info || typeof info !== "object" || !Array.isArray(pools) || !Array.isArray(alerts)) throw new Error("Unexpected answer from TrueNAS");
		const list = pools.map((p) => {
			const size = Number(p.size) || 0;
			const used = size ? Math.round((Number(p.allocated) / size) * 100) : null;
			const healthy = p.status === "ONLINE" && p.healthy !== false;
			return { name: p.name, status: p.status || "UNKNOWN", healthy, used };
		});
		const sick = list.filter((p) => !p.healthy);
		const open = alerts.filter((a) => !a.dismissed);
		const version = String(info.version || "").replace(/^TrueNAS-(SCALE-)?/i, "") || null;
		return {
			metrics: [
				{ value: `${list.length - sick.length}/${list.length}`, label: L("Pools gesund", "Pools healthy"), warn: sick.length > 0 },
				{ value: open.length, label: L("Meldungen", "Alerts"), warn: open.length > 0 },
				{ value: uptime(info.uptime_seconds), label: L("Laufzeit", "Uptime") },
				{ value: version, label: "Version" }
			],
			items: list
				.sort((a, b) => a.healthy - b.healthy || a.name.localeCompare(b.name))
				.map((p) => ({
					title: p.name,
					sub: [p.status, p.used !== null ? `${p.used} %` : ""].filter(Boolean).join(" · "),
					status: BAD.has(p.status) ? "bad" : !p.healthy || p.used >= 90 ? "warn" : "ok"
				})),
			warnings: [
				...sick.map((p) => `Pool ${p.name} is ${p.status}`),
				...open.filter((a) => LOUD.has(a.level)).map((a) => String(a.formatted || a.klass || "Alert").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 160))
			],
			summary: sick.length ? `${sick.map((p) => p.name).join(", ")} not healthy` : null
		};
	}
};
