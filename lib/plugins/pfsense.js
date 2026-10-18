"use strict";
// pfSense: CPU, memory, disk and the state of the interfaces and gateways through the
// REST API package v2 (pfrest.org): /api/v2/status/system, /api/v2/status/interfaces and
// /api/v2/status/gateways with an API key in the X-API-Key header.
const L = (de, en) => ({ de, en });

const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const isUp = (s) => /^(up|associated)$/i.test(String(s || ""));

module.exports = {
	kind: "pfsense",
	label: "pfSense",
	match: /pfsense/,
	ttl: 30000,
	fields: [
		{
			key: "apiKey",
			label: L("API-Schlüssel", "API key"),
			help: L(
				"Paket «REST API» (pfrest.org) v2 installieren, dann System → REST API → Keys → Add. Die Authentifizierung «API Key» muss unter Settings erlaubt sein.",
				"Install the “REST API” package (pfrest.org) v2, then System → REST API → Keys → Add. “API Key” authentication has to be allowed under Settings."
			),
			secret: true
		}
	],
	async fetch({ url, secrets, request, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { "X-API-Key": secrets.apiKey };
		const r = await request(`${url}/api/v2/status/system`, { headers: { Accept: "application/json", ...headers } });
		if (!r.status) throw new Error(r.error);
		if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the API key)");
		if (r.status === 404) throw new Error("REST API v2 not found (install the pfSense REST API package)");
		if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
		let sys;
		try {
			sys = JSON.parse(r.body.toString("utf8")).data;
		} catch {
			throw new Error("Unexpected answer (not JSON)");
		}
		if (!sys || typeof sys !== "object") throw new Error("Unexpected answer from pfSense");
		const [ifs, gws, ver] = await Promise.all([
			json(`${url}/api/v2/status/interfaces?limit=0&offset=0`, { headers }).catch(() => null),
			json(`${url}/api/v2/status/gateways?limit=0&offset=0`, { headers }).catch(() => null),
			json(`${url}/api/v2/system/version`, { headers }).catch(() => null)
		]);

		const interfaces = ((ifs && Array.isArray(ifs.data) && ifs.data) || []).filter((i) => i.enable !== false);
		const wan = interfaces.find((i) => String(i.name).toLowerCase() === "wan") || interfaces.find((i) => /wan/i.test(i.descr || ""));
		const gateways = (gws && Array.isArray(gws.data) && gws.data) || [];
		const badGw = gateways.filter((g) => g.status && !/^(online|none)$/i.test(g.status));

		const cpu = pct(sys.cpu_usage);
		const mem = pct(sys.mem_usage);
		const disk = pct(sys.disk_usage);
		const warnings = [];
		if (wan && !isUp(wan.status)) warnings.push(`pfSense WAN is ${wan.status || "down"}`);
		for (const g of badGw) warnings.push(`Gateway ${g.name} is ${g.status}${g.loss ? ` (loss ${g.loss})` : ""}`);
		if (disk > 90) warnings.push(`pfSense disk is ${disk} % full`);

		const version = ver && ver.data && ver.data.version;
		return {
			metrics: [
				{ value: cpu !== null ? `${cpu} %` : Array.isArray(sys.cpu_load_avg) ? String(sys.cpu_load_avg[0]) : null, label: cpu !== null ? "CPU" : L("Last", "Load"), warn: cpu > 90 },
				{ value: mem !== null ? `${mem} %` : null, label: "RAM", warn: mem > 90 },
				{ value: disk !== null ? `${disk} %` : null, label: "Disk", warn: disk > 90 },
				{ value: wan ? (isUp(wan.status) ? L("Online", "Online") : L("Offline", "Offline")) : null, label: "WAN", warn: !!wan && !isUp(wan.status) }
			],
			items: [
				...interfaces.map((i) => ({ title: i.descr || i.name, sub: [i.hwif, i.ipaddr, isUp(i.status) ? "" : i.status].filter(Boolean).join(" · "), status: isUp(i.status) ? "ok" : "bad" })),
				...gateways.map((g) => ({ title: g.name, sub: [g.monitorip || g.srcip, g.delay, g.loss ? `loss ${g.loss}` : ""].filter(Boolean).join(" · "), status: badGw.includes(g) ? (/down/i.test(g.status) ? "bad" : "warn") : "ok" }))
			],
			warnings,
			summary: [version ? `pfSense ${version}` : null, wan && wan.ipaddr ? `WAN ${wan.ipaddr}` : null].filter(Boolean).join(" · ") || null
		};
	}
};
