"use strict";
// Syncthing Relay Server (strelaysrv): active sessions, connections, data relayed and the current
// rate from its status page (/status, by default on port 22070, not the relay port 22067). No login.
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
	return `${b.toFixed(i && b < 10 ? 1 : 0)} ${u[i]}`;
}
const fmtRate = (kbps) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbit/s` : `${Math.round(kbps)} kbit/s`);
function fmtUptime(s) {
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	return d ? `${d} d ${h} h` : `${h} h ${Math.floor((s % 3600) / 60)} min`;
}

module.exports = {
	kind: "strelaysrv",
	label: "Syncthing Relay",
	// before the syncthing plugin, which would also match these names
	match: /strelaysrv|relaysrv|syncthing.?relay/,
	ttl: 30000,
	fields: [],
	async fetch({ url, json }) {
		const s = await json(`${url}/status`);
		if (!s || typeof s.numActiveSessions !== "number" || typeof s.bytesProxied !== "number") throw new Error("Unexpected answer (is this the status port, usually 22070?)");
		const rates = Array.isArray(s.kbps10s1m5m15m30m60m) ? s.kbps10s1m5m15m30m60m : [];
		return {
			metrics: [
				{ value: s.numActiveSessions, label: L("Sitzungen", "Sessions") },
				{ value: s.numConnections ?? null, label: L("Verbindungen", "Connections") },
				{ value: fmtBytes(s.bytesProxied), label: L("weitergeleitet", "relayed") },
				{ value: typeof rates[1] === "number" ? fmtRate(rates[1]) : null, label: L("Rate (1 min)", "Rate (1 min)") }
			],
			summary: typeof s.uptimeSeconds === "number" ? `Up ${fmtUptime(s.uptimeSeconds)}` : null
		};
	}
};
