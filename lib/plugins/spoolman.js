"use strict";
// Spoolman: filament spools and how much filament is left (/api/v1/spool, archived spools are
// left out). Spools with less than 100 g become warnings. Spoolman has no login.
const L = (de, en) => ({ de, en });

const LOW = 100; // grams
const kg = (g) => (g >= 1000 ? `${(g / 1000).toFixed(1)} kg` : `${Math.round(g)} g`);

function spoolName(s) {
	const f = s.filament || {};
	const vendor = f.vendor && f.vendor.name;
	return [vendor, f.name || f.material || `#${s.id}`].filter(Boolean).join(" ") || `Spool ${s.id}`;
}

module.exports = {
	kind: "spoolman",
	label: "Spoolman",
	match: /spoolman/,
	repo: "Donkie/Spoolman",
	ttl: 300000,
	fields: [],
	async fetch({ url, json }) {
		const r = await json(`${url}/api/v1/spool`);
		if (!Array.isArray(r)) throw new Error("Unexpected answer from Spoolman");
		const spools = r
			.filter((s) => !s.archived)
			.map((s) => ({
				id: s.id,
				name: spoolName(s),
				material: (s.filament && s.filament.material) || "",
				location: s.location || "",
				left: typeof s.remaining_weight === "number" ? Math.max(0, s.remaining_weight) : null,
				total: typeof s.initial_weight === "number" ? s.initial_weight : s.filament && typeof s.filament.weight === "number" ? s.filament.weight : null
			}));
		const known = spools.filter((s) => s.left !== null);
		const low = known.filter((s) => s.left < LOW);
		return {
			metrics: [
				{ value: spools.length, label: L("Spulen", "Spools") },
				{ value: known.length ? kg(known.reduce((a, s) => a + s.left, 0)) : null, label: L("Filament übrig", "Filament left") },
				{ value: low.length, label: L(`unter ${LOW} g`, `below ${LOW} g`), warn: low.length > 0 }
			],
			items: spools
				.sort((a, b) => (a.left ?? Infinity) - (b.left ?? Infinity) || a.name.localeCompare(b.name))
				.map((s) => ({
					title: s.name,
					sub: [s.left !== null ? `${kg(s.left)} left${s.total ? ` (${Math.round((s.left / s.total) * 100)} %)` : ""}` : "", s.material, s.location].filter(Boolean).join(" · "),
					status: s.left === null ? "ok" : s.left <= 0 ? "bad" : s.left < LOW ? "warn" : "ok"
				})),
			warnings: low.map((s) => `${s.name} (#${s.id}): only ${Math.round(s.left)} g left`),
			summary: low.length ? `${low.length} spool${low.length > 1 ? "s" : ""} almost empty` : null
		};
	}
};
