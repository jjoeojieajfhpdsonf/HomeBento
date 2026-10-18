"use strict";
// OPNsense: CPU, memory and WAN traffic with an API key and secret (basic auth).
// CPU from /api/diagnostics/activity/getActivity (the header of `top`), memory from
// /api/diagnostics/system/systemResources, traffic from /api/diagnostics/traffic/interface
// (byte counters; the rate is the difference to the last call) and system messages from
// /api/core/system/status.
const L = (de, en) => ({ de, en });

const samples = new Map(); // url + interface -> { t, rx, tx } of the last call

function rate(bytesPerSec) {
	const bits = Math.max(0, bytesPerSec) * 8;
	if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbit/s`;
	if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
	return `${Math.round(bits / 1e3)} kbit/s`;
}

function counters(itf) {
	// newer versions: inbytes/outbytes, older: the raw names of netstat
	const rx = Number(itf.inbytes !== undefined ? itf.inbytes : itf["bytes received"]);
	const tx = Number(itf.outbytes !== undefined ? itf.outbytes : itf["bytes transmitted"]);
	return { rx: Number.isFinite(rx) ? rx : null, tx: Number.isFinite(tx) ? tx : null };
}

// CPU usage from a line like "CPU:  1.2% user,  0.0% nice, ... 97.9% idle"
function cpuOf(activity) {
	const line = ((activity && activity.headers) || []).find((h) => /^\s*CPU/.test(h) && /idle/.test(h));
	const m = line && /([\d.]+)%\s*idle/.exec(line);
	return m ? Math.max(0, Math.round((100 - Number(m[1])) * 10) / 10) : null;
}

// fallback for memory: "Mem: 312M Active, ..." when systemResources is missing
function activeMem(activity) {
	const line = ((activity && activity.headers) || []).find((h) => /^\s*Mem:/.test(h));
	const m = line && /Mem:\s*([\d.]+[KMGT]?)\s*Active/i.exec(line);
	return m ? `${m[1]}B` : null;
}

module.exports = {
	kind: "opnsense",
	label: "OPNsense",
	match: /opnsense/,
	repo: "opnsense/core",
	ttl: 30000,
	sampleDelay: 1000, // first call: wait this long for a second traffic sample
	fields: [
		{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("System → Zugang → Benutzer → Benutzer bearbeiten → API-Schlüssel (+). Die heruntergeladene Datei enthält key und secret.", "System → Access → Users → edit a user → API keys (+). The downloaded file holds key and secret."), secret: true },
		{ key: "apiSecret", label: L("API-Geheimnis", "API secret"), secret: true },
		{ key: "wan", label: L("WAN-Schnittstelle", "WAN interface"), help: L("Optional, Standard: wan (z. B. opt1)", "Optional, default: wan (e.g. opt1)") }
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey || !secrets.apiSecret) throw new Error("API key missing");
		const headers = { Authorization: `Basic ${Buffer.from(`${secrets.apiKey}:${secrets.apiSecret}`).toString("base64")}` };
		const wanKey = (secrets.wan || "wan").trim().toLowerCase();
		const traffic = () => json(`${url}/api/diagnostics/traffic/interface`, { headers });
		const [activity, resources, first, status] = await Promise.all([
			json(`${url}/api/diagnostics/activity/getActivity`, { headers }),
			json(`${url}/api/diagnostics/system/systemResources`, { headers }).catch(() => null),
			traffic(),
			json(`${url}/api/core/system/status`, { headers }).catch(() => null)
		]);
		if (!activity || !Array.isArray(activity.headers) || !first || typeof first.interfaces !== "object") throw new Error("Unexpected answer from OPNsense");

		// WAN rate: difference to the last sample (or a second one right now)
		const key = `${url}|${wanKey}`;
		let now = first;
		let prev = samples.get(key);
		const wanNow = () => now.interfaces && now.interfaces[wanKey];
		if (wanNow() && (!prev || Date.now() - prev.at > 10 * 60000)) {
			const c = counters(wanNow());
			prev = { t: Number(now.time) || Date.now() / 1000, ...c };
			await new Promise((r) => setTimeout(r, module.exports.sampleDelay));
			now = await traffic();
		}
		let down = null;
		let up = null;
		const wan = wanNow();
		if (wan) {
			const c = counters(wan);
			const t = Number(now.time) || Date.now() / 1000;
			const dt = prev ? t - prev.t : 0;
			if (prev && dt > 0 && c.rx !== null && prev.rx !== null && c.rx >= prev.rx) down = (c.rx - prev.rx) / dt;
			if (prev && dt > 0 && c.tx !== null && prev.tx !== null && c.tx >= prev.tx) up = (c.tx - prev.tx) / dt;
			samples.set(key, { at: Date.now(), t, ...c });
		}

		const cpu = cpuOf(activity);
		const m = resources && resources.memory;
		const mem = m && Number(m.total) > 0 && Number.isFinite(Number(m.used)) ? Math.round((Number(m.used) / Number(m.total)) * 100) : null;

		// system messages (OK = 2, NOTICE = 1, WARNING = 0, ERROR = -1)
		const subsystems = (status && status.subsystems && typeof status.subsystems === "object" && Object.values(status.subsystems)) || [];
		const problems = subsystems.filter((s) => s && (Number(s.statusCode) <= 0 || /^(WARNING|ERROR)$/i.test(s.status || "")));

		return {
			metrics: [
				{ value: cpu !== null ? `${cpu} %` : null, label: "CPU", warn: cpu > 90 },
				{ value: mem !== null ? `${mem} %` : activeMem(activity), label: "RAM", warn: mem > 90 },
				{ value: down !== null ? rate(down) : null, label: "WAN ↓" },
				{ value: up !== null ? rate(up) : null, label: "WAN ↑" }
			],
			items: problems.map((s) => ({ title: s.title || "OPNsense", sub: String(s.message || "").replace(/<[^>]+>/g, "").trim(), status: Number(s.statusCode) < 0 || /ERROR/i.test(s.status || "") ? "bad" : "warn" })),
			warnings: [...(wan ? [] : [`OPNsense has no interface "${wanKey}"`]), ...problems.map((s) => `${s.title || "OPNsense"}: ${String(s.message || "").replace(/<[^>]+>/g, "").trim()}`)]
		};
	}
};
