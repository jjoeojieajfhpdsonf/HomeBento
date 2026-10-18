"use strict";
// OpenDTU (Hoymiles / TSUN microinverters, also OpenDTU-OnBattery): current power, yield today and
// in total and which inverters are reachable and producing, from /api/livedata/status. The live data
// is readable without a login unless "Allow read-only access" is off; then basic auth with the
// admin password is needed.
const L = (de, en) => ({ de, en });

const num = (v) => (v === undefined || v === null || isNaN(Number(v)) ? null : Number(v));

// { v: 1234, u: "W" } → "1.2 kW"; energy in Wh or kWh → "850 Wh", "4.2 kWh", "1.23 MWh"
function fmt(x, kind) {
	const v = num(x && x.v);
	if (v === null) return null;
	const unit = String((x && x.u) || (kind === "power" ? "W" : "Wh"));
	const base = unit === "kW" || unit === "kWh" ? v * 1000 : unit === "MWh" ? v * 1e6 : v;
	const s = kind === "power" ? "W" : "Wh";
	if (Math.abs(base) >= 1e6) return `${(base / 1e6).toFixed(2)} M${s}`;
	if (Math.abs(base) >= 1000) return `${(base / 1000).toFixed(1)} k${s}`;
	return `${Math.round(base)} ${s}`;
}

module.exports = {
	kind: "opendtu",
	label: "OpenDTU",
	match: /opendtu/,
	repo: "tbnobody/OpenDTU",
	ttl: 15000,
	fields: [
		{ key: "username", label: L("Benutzername", "User name"), help: L("Nur nötig, wenn «Nur-Lese-Zugriff erlauben» aus ist (Benutzer admin)", "Only if “Allow read-only access” is off (user admin)") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	fmt,
	async fetch({ url, secrets, json }) {
		const headers = secrets.password ? { Authorization: `Basic ${Buffer.from(`${secrets.username || "admin"}:${secrets.password}`).toString("base64")}` } : {};
		let r;
		try {
			r = await json(`${url}/api/livedata/status`, { headers });
		} catch (err) {
			if (/Access denied/.test(err.message)) throw new Error(secrets.password ? "Access denied (check user name and password)" : "Password missing (read-only access is off in OpenDTU)");
			throw err;
		}
		if (!r || !Array.isArray(r.inverters) || !r.total) throw new Error("Unexpected answer from OpenDTU");
		const inv = r.inverters.map((i) => {
			const ac = i.AC && i.AC["0"] && i.AC["0"].Power;
			return { name: i.name || String(i.serial || "Inverter"), serial: i.serial, reachable: !!i.reachable, producing: !!i.producing, polled: i.poll_enabled !== false, power: ac ? fmt(ac, "power") : null, limit: num(i.limit_relative) };
		});
		const producing = inv.filter((i) => i.producing);
		const hints = r.hints || {};
		return {
			metrics: [
				{ value: fmt(r.total.Power, "power"), label: L("Leistung", "Power") },
				{ value: fmt(r.total.YieldDay, "energy"), label: L("Heute", "Today") },
				{ value: fmt(r.total.YieldTotal, "energy"), label: L("Gesamt", "Total") },
				{ value: `${producing.length}/${inv.length}`, label: L("Wechselrichter aktiv", "Inverters producing") }
			].filter((m) => m.value !== null),
			items: inv.map((i) => ({
				title: i.name,
				sub: [i.producing ? "producing" : i.reachable ? "reachable" : !i.polled ? "polling off" : "not reachable", i.power || "", i.limit !== null && i.limit < 100 ? `limit ${Math.round(i.limit)} %` : ""].filter(Boolean).join(" · "),
				// at night the inverters switch off and are not reachable, which is normal
				status: i.reachable ? "ok" : "warn"
			})),
			warnings: [hints.radio_problem ? "OpenDTU reports a radio problem (check the NRF24/CMT module)" : null, hints.time_sync === true ? "OpenDTU has no time sync, so it does not poll the inverters" : null].filter(Boolean),
			summary: hints.default_password ? "Default admin password still set" : null
		};
	}
};
