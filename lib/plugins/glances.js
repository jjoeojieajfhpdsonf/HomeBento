"use strict";
// Glances (glances -w): CPU, memory, load and file systems from the REST API v4, with a
// fallback to v3 for older versions. No login by default; basic auth when started with --password.
const L = (de, en) => ({ de, en });

const round = (x, d = 0) => (typeof x === "number" && isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

module.exports = {
	kind: "glances",
	label: "Glances",
	match: /glances/,
	repo: "nicolargo/glances",
	ttl: 15000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur mit --password, Standard: glances", "Only with --password, default: glances") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const headers = secrets.username || secrets.password ? { Authorization: `Basic ${Buffer.from(`${secrets.username || "glances"}:${secrets.password || ""}`).toString("base64")}` } : {};
		let api = `${url}/api/4`;
		let cpu;
		try {
			cpu = await json(`${api}/cpu`, { headers });
		} catch (err) {
			if (err.message !== "HTTP 404") throw err;
			api = `${url}/api/3`;
			cpu = await json(`${api}/cpu`, { headers });
		}
		const [mem, load, fs, sensors] = await Promise.all([
			json(`${api}/mem`, { headers }),
			json(`${api}/load`, { headers }).catch(() => null),
			json(`${api}/fs`, { headers }).catch(() => []),
			json(`${api}/sensors`, { headers }).catch(() => []) // plugin may be disabled
		]);
		if (!cpu || typeof cpu.total !== "number" || !mem || typeof mem.percent !== "number") throw new Error("Unexpected answer from Glances");

		// one row per file system: skip bind-mounted files (Docker) and the same device mounted twice
		const seen = new Set();
		const disks = (Array.isArray(fs) ? fs : [])
			.filter((d) => d && typeof d.percent === "number" && d.mnt_point && !/^\/etc\//.test(d.mnt_point))
			.filter((d) => {
				const k = `${d.device_name}|${d.size}`;
				if (seen.has(k)) return false;
				seen.add(k);
				return true;
			})
			.map((d) => ({ mount: d.mnt_point, device: d.device_name || "", type: d.fs_type || "", used: round(d.percent) }));
		const full = disks.reduce((a, d) => (a === null || d.used > a.used ? d : a), null);
		const cores = load && load.cpucore;
		const hot = (Array.isArray(sensors) ? sensors : []).filter((s) => s && s.unit === "C" && typeof s.value === "number" && ((s.critical && s.value >= s.critical) || (s.warning && s.value >= s.warning)));
		const cpuP = round(cpu.total);
		const memP = round(mem.percent);
		return {
			metrics: [
				{ value: `${cpuP} %`, label: "CPU", warn: cpuP >= 90 },
				{ value: `${memP} %`, label: "RAM", warn: memP >= 90 },
				{ value: load ? round(load.min1, 2) : null, label: "Load", warn: !!(load && cores && load.min1 > cores) },
				{ value: full ? `${full.used} %` : null, label: L("Disk max.", "Disk max"), warn: !!full && full.used >= 90 }
			],
			items: disks
				.sort((a, b) => b.used - a.used || a.mount.localeCompare(b.mount))
				.map((d) => ({ title: d.mount, sub: [`${d.used} %`, d.device, d.type].filter(Boolean).join(" · "), status: d.used >= 95 ? "bad" : d.used >= 90 ? "warn" : "ok" })),
			warnings: [...disks.filter((d) => d.used >= 90).map((d) => `${d.mount} is ${d.used} % full`), ...hot.map((s) => `${s.label} at ${round(s.value)} °C`)],
			summary: hot.length ? hot.map((s) => `${s.label} ${round(s.value)} °C`).join(", ") : null
		};
	}
};
