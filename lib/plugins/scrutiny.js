"use strict";
// Scrutiny: S.M.A.R.T. state and temperature of the disks from /api/summary (no login).
const L = (de, en) => ({ de, en });

const HOT = 55; // °C
// device_status is a bit field: 1 = S.M.A.R.T. failed, 2 = Scrutiny's thresholds failed
const FAILED_SMART = 1;
const FAILED_SCRUTINY = 2;

module.exports = {
	kind: "scrutiny",
	label: "Scrutiny",
	match: /scrutiny/,
	repo: "AnalogJ/scrutiny",
	ttl: 5 * 60000,
	fields: [],
	async fetch({ url, json }) {
		const r = await json(`${url}/api/summary`);
		const summary = r && r.success && r.data && r.data.summary;
		if (!summary || typeof summary !== "object") throw new Error("Unexpected answer from Scrutiny");
		const disks = Object.values(summary)
			.filter((x) => x && x.device && !x.device.archived)
			.map((x) => {
				const d = x.device;
				const st = Number(d.device_status) || 0;
				const temp = x.smart && x.smart.temp > 0 ? x.smart.temp : null;
				return {
					name: d.device_name ? `/dev/${String(d.device_name).replace(/^\/dev\//, "")}` : d.wwn,
					model: d.model_name || "",
					host: d.host_id || "",
					temp,
					hours: x.smart && x.smart.power_on_hours > 0 ? x.smart.power_on_hours : null,
					failed: st !== 0,
					why: [st & FAILED_SMART ? "S.M.A.R.T." : "", st & FAILED_SCRUTINY ? "Scrutiny" : ""].filter(Boolean).join(" + ") || "health"
				};
			});
		const failed = disks.filter((d) => d.failed);
		const temps = disks.map((d) => d.temp).filter((t) => t !== null);
		const max = temps.length ? Math.max(...temps) : null;
		return {
			metrics: [
				{ value: disks.length, label: L("Disks", "Disks") },
				{ value: failed.length, label: L("fehlerhaft", "failed"), warn: failed.length > 0 },
				{ value: max !== null ? `${max} °C` : null, label: L("Temp. max.", "Max temp"), warn: max !== null && max >= HOT }
			],
			items: disks
				.sort((a, b) => b.failed - a.failed || (a.host + a.name).localeCompare(b.host + b.name))
				.map((d) => ({
					title: [d.host, d.name].filter(Boolean).join(" "),
					sub: [d.model, d.temp !== null ? `${d.temp} °C` : "", d.hours !== null ? `${d.hours.toLocaleString("en").replace(/,/g, "'")} h` : "", d.failed ? `failed (${d.why})` : ""].filter(Boolean).join(" · "),
					status: d.failed ? "bad" : d.temp !== null && d.temp >= HOT ? "warn" : "ok"
				})),
			warnings: [...failed.map((d) => `${d.name}${d.model ? ` (${d.model})` : ""} failed ${d.why} checks`), ...disks.filter((d) => !d.failed && d.temp >= HOT).map((d) => `${d.name} is at ${d.temp} °C`)],
			summary: failed.length ? `${failed.length} disk(s) failed` : null
		};
	}
};
