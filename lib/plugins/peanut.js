"use strict";
// PeaNUT (web interface for NUT, the Network UPS Tools): battery charge, runtime, load and status
// of the UPS from the REST API (/api/v1/devices/<ups>, or /api/v1/devices for all of them).
// NUT itself (upsd on port 3493) speaks no HTTP, so a UPS is shown through PeaNUT.
// Newer PeaNUT versions protect the API with basic auth (the PeaNUT login).
const L = (de, en) => ({ de, en });

// NUT status flags (ups.status is a space separated list, e.g. "OB DISCHRG LB")
const FLAG = { OL: "online", OB: "on battery", LB: "battery low", HB: "battery high", RB: "replace battery", CHRG: "charging", DISCHRG: "discharging", BYPASS: "bypass", CAL: "calibrating", OFF: "off", OVER: "overload", TRIM: "trimming voltage", BOOST: "boosting voltage", FSD: "forced shutdown" };

const num = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));

// 4500 → "1 h 15 min", 300 → "5 min"
function runtime(sec) {
	if (sec === null || !(sec >= 0)) return null;
	const min = Math.round(sec / 60);
	return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

function ups(d, fallbackName) {
	// PeaNUT v1 used underscores instead of dots
	const get = (k) => (k in d ? d[k] : d[k.replace(/\./g, "_")]);
	const flags = String(get("ups.status") || "").split(/\s+/).filter(Boolean);
	const name = get("peanut.device_id") || fallbackName || get("device.model") || get("ups.model") || "UPS";
	const model = [get("device.mfr") || get("ups.mfr"), get("device.model") || get("ups.model")].filter(Boolean).join(" ").trim();
	return {
		name: String(name),
		model,
		flags,
		charge: num(get("battery.charge")),
		runtime: num(get("battery.runtime")),
		load: num(get("ups.load")),
		onBattery: flags.includes("OB"),
		low: flags.includes("LB"),
		replace: flags.includes("RB"),
		overload: flags.includes("OVER"),
		online: flags.includes("OL")
	};
}

module.exports = {
	kind: "peanut",
	label: "PeaNUT (NUT UPS)",
	match: /peanut/,
	repo: "Brandawg93/PeaNUT",
	ttl: 15000,
	fields: [
		{ key: "device", label: L("USV-Name", "UPS name"), help: L("Name der USV in NUT, z. B. ups – leer lassen für alle", "Name of the UPS in NUT, e.g. ups – leave empty for all") },
		{ key: "username", label: L("Benutzername", "User name"), help: L("Nur nötig, wenn PeaNUT eine Anmeldung hat", "Only if PeaNUT has a login") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	runtime,
	async fetch({ url, secrets, json }) {
		const device = String(secrets.device || "").trim();
		const headers = secrets.username || secrets.password ? { Authorization: `Basic ${Buffer.from(`${secrets.username || ""}:${secrets.password || ""}`).toString("base64")}` } : {};
		let list;
		try {
			const r = await json(device ? `${url}/api/v1/devices/${encodeURIComponent(device)}` : `${url}/api/v1/devices?meta=true`, { headers });
			list = device ? (r && typeof r === "object" && !Array.isArray(r) ? [ups(r, device)] : null) : Array.isArray(r) ? r.map((x) => ups(x)) : null;
		} catch (err) {
			if (/Access denied/.test(err.message)) throw new Error(headers.Authorization ? "Access denied (check user name and password)" : "PeaNUT asks for a login: enter user name and password");
			if (device && /HTTP (404|500)/.test(err.message)) throw new Error(`UPS "${device}" not found in PeaNUT`);
			throw err;
		}
		if (!list) throw new Error("Unexpected answer from PeaNUT");
		if (!list.length) throw new Error("PeaNUT knows no UPS");
		const charges = list.map((u) => u.charge).filter((x) => x !== null);
		const runtimes = list.map((u) => u.runtime).filter((x) => x !== null);
		const loads = list.map((u) => u.load).filter((x) => x !== null);
		const onBattery = list.filter((u) => u.onBattery);
		const charge = charges.length ? Math.min(...charges) : null;
		const load = loads.length ? Math.max(...loads) : null;
		const offline = list.filter((u) => !u.online && !u.onBattery);
		const state = onBattery.length ? (list.some((u) => u.low) ? L("Batterie schwach", "Battery low") : L("Batterie", "On battery")) : offline.length ? (list.length > 1 ? `${list.length - offline.length}/${list.length}` : list[0].flags.join(" ") || "?") : L("Netz", "Online");
		return {
			metrics: [
				{ value: state, label: L("Status", "Status"), warn: onBattery.length > 0 || offline.length > 0 },
				{ value: charge !== null ? `${Math.round(charge)} %` : null, label: L("Akku", "Battery"), warn: charge !== null && charge < 50 },
				{ value: runtimes.length ? runtime(Math.min(...runtimes)) : null, label: L("Laufzeit", "Runtime") },
				{ value: load !== null ? `${Math.round(load)} %` : null, label: L("Last", "Load"), warn: load >= 80 }
			].filter((m) => m.value !== null),
			items: list.map((u) => ({
				title: u.name,
				sub: [u.flags.map((f) => FLAG[f] || f).join(", "), u.charge !== null ? `${Math.round(u.charge)} %` : "", u.runtime !== null ? runtime(u.runtime) : "", u.load !== null ? `load ${Math.round(u.load)} %` : ""].filter(Boolean).join(" · "),
				status: u.low || u.overload || (!u.online && !u.onBattery) ? "bad" : u.onBattery || u.replace ? "warn" : "ok"
			})),
			warnings: list.flatMap((u) => [u.onBattery ? `${u.name} is running on battery${u.low ? " (battery low)" : ""}` : null, u.replace ? `${u.name}: replace the battery` : null, u.overload ? `${u.name} is overloaded` : null]).filter(Boolean),
			summary: list.length === 1 && list[0].model ? list[0].model : null
		};
	}
};
