"use strict";
// MikroTik RouterOS 7: CPU, memory, uptime and DHCP leases through the REST API
// (/rest/system/resource and /rest/ip/dhcp-server/lease) with basic auth. The REST API runs on
// the www-ssl service (https), or on www (http) from RouterOS 7.9 on.
const L = (de, en) => ({ de, en });

// RouterOS durations look like "2w3d04:05:06" or "1w2d3h4m5s"
function seconds(text) {
	const s = String(text || "");
	let total = 0;
	for (const [, n, unit] of s.matchAll(/(\d+)([wdhms])/g)) total += Number(n) * { w: 604800, d: 86400, h: 3600, m: 60, s: 1 }[unit];
	const clock = /(\d+):(\d+):(\d+)$/.exec(s);
	if (clock) total += Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
	return total;
}

function duration(sec) {
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

module.exports = {
	kind: "mikrotik",
	label: "MikroTik RouterOS",
	match: /mikrotik|routeros/,
	ttl: 30000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("RouterOS-Benutzer (Gruppe read genügt). REST-API ab RouterOS 7.1 über den Dienst www-ssl (ab 7.9 auch www).", "RouterOS user (group read is enough). REST API from RouterOS 7.1 through the www-ssl service (www too from 7.9).") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.username) throw new Error("Username missing");
		const headers = { Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password || ""}`).toString("base64")}` };
		const [res, leases] = await Promise.all([
			json(`${url}/rest/system/resource`, { headers }),
			json(`${url}/rest/ip/dhcp-server/lease?.proplist=address,status,host-name,disabled`, { headers }).catch((err) => {
				if (/Access denied/.test(err.message)) throw err;
				return null; // no DHCP server package or no right
			})
		]);
		if (!res || res["cpu-load"] === undefined) throw new Error("Unexpected answer from RouterOS");
		const cpu = Number(res["cpu-load"]);
		const total = Number(res["total-memory"]);
		const ram = total > 0 ? Math.round(100 - (Number(res["free-memory"]) / total) * 100) : null;
		const list = Array.isArray(leases) ? leases.filter((l) => String(l.disabled) !== "true") : null;
		// leases without a status field (old versions) count as active
		const bound = list ? list.filter((l) => !l.status || l.status === "bound").length : null;
		const hdd = Number(res["total-hdd-space"]) > 0 ? Math.round(100 - (Number(res["free-hdd-space"]) / Number(res["total-hdd-space"])) * 100) : null;
		return {
			metrics: [
				{ value: `${cpu} %`, label: "CPU", warn: cpu > 90 },
				{ value: ram !== null ? `${ram} %` : null, label: "RAM", warn: ram > 90 },
				{ value: bound, label: L("DHCP-Leases", "DHCP leases") },
				{ value: res.uptime ? duration(seconds(res.uptime)) : null, label: L("Laufzeit", "Uptime") }
			],
			warnings: hdd > 90 ? [`RouterOS storage is ${hdd} % full`] : [],
			summary: [res["board-name"], res.version ? `RouterOS ${res.version}` : null].filter(Boolean).join(" · ") || null
		};
	}
};
