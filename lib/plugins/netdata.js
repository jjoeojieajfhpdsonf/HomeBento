"use strict";
// Netdata (agent): active alarms (warning/critical) from /api/v1/info and /api/v1/alarms, plus the
// current CPU and RAM use from the charts system.cpu and system.ram. No login by default; basic
// auth when the agent sits behind a proxy that asks for one.
const L = (de, en) => ({ de, en });

// latest point of a chart: { dimension: value }
async function chart(url, name, headers, json) {
	const r = await json(`${url}/api/v1/data?chart=${name}&after=-5&points=1&group=average&format=json`, { headers });
	if (!r || !Array.isArray(r.labels) || !Array.isArray(r.data) || !Array.isArray(r.data[0])) return null;
	const out = {};
	r.labels.forEach((l, i) => {
		if (l !== "time" && l !== "idle") out[l] = Math.abs(Number(r.data[0][i]) || 0);
	});
	return out;
}

module.exports = {
	kind: "netdata",
	label: "Netdata",
	match: /netdata/,
	repo: "netdata/netdata",
	ttl: 15000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur nötig, wenn ein Proxy davor ein Login verlangt", "Only if a proxy in front asks for a login") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const login = secrets.username || secrets.password;
		const headers = login ? { Authorization: `Basic ${Buffer.from(`${secrets.username || ""}:${secrets.password || ""}`).toString("base64")}` } : {};
		let info;
		try {
			info = await json(`${url}/api/v1/info`, { headers });
		} catch (err) {
			if (!login && /Access denied/.test(err.message)) throw new Error("Login missing");
			throw err;
		}
		if (!info || typeof info !== "object" || !info.alarms) throw new Error("Unexpected answer from Netdata");
		const [alarms, cpu, ram] = await Promise.all([
			json(`${url}/api/v1/alarms`, { headers }).catch(() => null),
			chart(url, "system.cpu", headers, json).catch(() => null),
			chart(url, "system.ram", headers, json).catch(() => null)
		]);
		const active = Object.values((alarms && alarms.alarms) || {})
			.filter((a) => a && (a.status === "WARNING" || a.status === "CRITICAL"))
			.map((a) => ({ name: a.name || "?", chart: a.chart || "", value: a.value_string || "", critical: a.status === "CRITICAL" }));
		const crit = alarms ? active.filter((a) => a.critical).length : Number(info.alarms.critical) || 0;
		const warn = alarms ? active.filter((a) => !a.critical).length : Number(info.alarms.warning) || 0;
		const cpuPct = cpu ? Math.round(Object.values(cpu).reduce((a, v) => a + v, 0)) : null;
		const ramTotal = ram ? Object.values(ram).reduce((a, v) => a + v, 0) : 0;
		const ramPct = ram && ramTotal > 0 && typeof ram.used === "number" ? Math.round((100 * ram.used) / ramTotal) : null;
		const criticals = active.filter((a) => a.critical);
		return {
			metrics: [
				{ value: cpuPct !== null ? `${Math.min(cpuPct, 100)} %` : null, label: "CPU", warn: cpuPct > 90 },
				{ value: ramPct !== null ? `${ramPct} %` : null, label: "RAM", warn: ramPct > 90 },
				{ value: warn, label: L("Warnungen", "Warnings"), warn: warn > 0 },
				{ value: crit, label: L("kritisch", "critical"), warn: crit > 0 }
			],
			items: active
				.sort((a, b) => b.critical - a.critical || a.name.localeCompare(b.name))
				.map((a) => ({ title: a.name.replace(/_/g, " "), sub: [a.chart, a.value].filter(Boolean).join(" · "), status: a.critical ? "bad" : "warn" })),
			warnings: criticals.map((a) => `Netdata: ${a.name.replace(/_/g, " ")} is critical${a.value ? ` (${a.value})` : ""}`),
			summary: criticals.length ? `${criticals.length} critical alarm${criticals.length === 1 ? "" : "s"}` : null
		};
	}
};
