"use strict";
// evcc (solar charging): PV, house and grid power, home battery and the loadpoints (wallboxes)
// with their vehicles from /api/state. The state is readable without a login.
// Older evcc versions wrap the answer in { result }, and before v0.133 the grid power was gridPower.
const L = (de, en) => ({ de, en });

const num = (v) => (v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));

// 850 → "850 W", 3240 → "3.2 kW"
function watts(w) {
	if (w === null) return null;
	return Math.abs(w) >= 1000 ? `${(w / 1000).toFixed(1)} kW` : `${Math.round(w)} W`;
}

// pv / grid / battery were plain numbers in older versions, objects or lists of devices in newer ones
function power(x) {
	if (Array.isArray(x)) return x.reduce((a, d) => a + (num(d && d.power) || 0), 0);
	if (x && typeof x === "object") return num(x.power);
	return num(x);
}

function batterySoc(d) {
	if (num(d.batterySoc) !== null && (d.batteryConfigured !== false || num(d.batterySoc) > 0)) return num(d.batterySoc);
	const b = d.battery;
	if (b && !Array.isArray(b) && typeof b === "object" && num(b.soc) !== null) return num(b.soc);
	const list = Array.isArray(b) ? b : b && Array.isArray(b.devices) ? b.devices : [];
	const socs = list.map((x) => num(x && x.soc)).filter((x) => x !== null);
	return socs.length ? socs.reduce((a, x) => a + x, 0) / socs.length : null;
}

module.exports = {
	kind: "evcc",
	label: "evcc",
	match: /evcc/,
	repo: "evcc-io/evcc",
	ttl: 15000,
	fields: [],
	watts,
	async fetch({ url, json }) {
		const r = await json(`${url}/api/state`);
		const d = r && typeof r === "object" ? r.result || r : null;
		if (!d || (!("pvPower" in d) && !("pv" in d) && !Array.isArray(d.loadpoints))) throw new Error("Unexpected answer from evcc");
		const pv = num(d.pvPower) !== null ? num(d.pvPower) : power(d.pv);
		const grid = num(d.gridPower) !== null ? num(d.gridPower) : power(d.grid);
		const home = num(d.homePower);
		const soc = batterySoc(d);
		const vehicles = d.vehicles && typeof d.vehicles === "object" ? d.vehicles : {};
		const lps = (Array.isArray(d.loadpoints) ? d.loadpoints : []).map((lp, i) => {
			const vehicle = lp.vehicleTitle || (lp.vehicleName && vehicles[lp.vehicleName] && vehicles[lp.vehicleName].title) || lp.vehicleName || "";
			const vsoc = num(lp.vehicleSoc);
			return { title: lp.title || `Loadpoint ${i + 1}`, charging: !!lp.charging, connected: !!lp.connected, power: num(lp.chargePower) || 0, mode: lp.mode || "", vehicle, vsoc: vsoc !== null && (vsoc > 0 || lp.connected) ? Math.round(vsoc) : null };
		});
		const charging = lps.filter((lp) => lp.charging);
		return {
			metrics: [
				{ value: watts(pv), label: "PV" },
				{ value: watts(home), label: L("Haus", "Home") },
				grid !== null ? { value: watts(Math.abs(grid)), label: grid < 0 ? L("Einspeisung", "Grid export") : L("Netzbezug", "Grid import") } : null,
				soc !== null ? { value: `${Math.round(soc)} %`, label: L("Hausbatterie", "Home battery") } : lps.length ? { value: watts(charging.reduce((a, lp) => a + lp.power, 0)), label: L("Laden", "Charging") } : null
			].filter((m) => m && m.value !== null),
			items: lps.map((lp) => ({
				title: lp.title,
				sub: [lp.charging ? `charging ${watts(lp.power)}` : lp.connected ? "connected" : "not connected", lp.vehicle, lp.vsoc !== null ? `${lp.vsoc} %` : "", lp.mode].filter(Boolean).join(" · "),
				status: "ok"
			})),
			summary: charging.length ? charging.map((lp) => `${lp.vehicle || lp.title} charging ${watts(lp.power)}`).join(", ") : d.siteTitle || null
		};
	}
};
