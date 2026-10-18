"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { holidays, next, easter, CANTONS } = require("../lib/holidays");

const find = (list, de) => list.find((h) => h.name.de === de);

test("Easter Sunday 2024–2030", () => {
	const expected = { 2024: "2024-03-31", 2025: "2025-04-20", 2026: "2026-04-05", 2027: "2027-03-28", 2028: "2028-04-16", 2029: "2029-04-01", 2030: "2030-04-21" };
	for (const [y, d] of Object.entries(expected)) assert.equal(easter(+y), d);
});

test("26 cantons with names", () => {
	assert.equal(Object.keys(CANTONS).length, 26);
	assert.deepEqual(CANTONS.ZH, { de: "Zürich", en: "Zurich" });
	for (const c of Object.values(CANTONS)) assert.ok(c.de && c.en);
});

test("Zürich 2026", () => {
	const list = holidays(2026, "ZH");
	assert.deepEqual(
		list.map((h) => [h.date, h.name.de, h.scope]),
		[
			["2026-01-01", "Neujahr", "national"],
			["2026-01-02", "Berchtoldstag", "cantonal"],
			["2026-04-03", "Karfreitag", "cantonal"],
			["2026-04-06", "Ostermontag", "cantonal"],
			["2026-05-01", "Tag der Arbeit", "cantonal"],
			["2026-05-14", "Auffahrt", "national"],
			["2026-05-25", "Pfingstmontag", "cantonal"],
			["2026-08-01", "Bundesfeiertag", "national"],
			["2026-12-25", "Weihnachten", "national"],
			["2026-12-26", "Stephanstag", "cantonal"]
		]
	);
	assert.deepEqual(list[0].name, { de: "Neujahr", en: "New Year's Day" });
	assert.equal(holidays(2026, "zh").length, 10, "canton code is case-insensitive");
});

test("Ticino and Valais have no Good Friday", () => {
	assert.equal(find(holidays(2026, "TI"), "Karfreitag"), undefined);
	assert.equal(find(holidays(2026, "VS"), "Karfreitag"), undefined);
	assert.ok(find(holidays(2026, "BE"), "Karfreitag"));
	assert.equal(find(holidays(2026, "TI"), "Peter und Paul").date, "2026-06-29");
});

test("Bettagsmontag only in Vaud", () => {
	for (const c of Object.keys(CANTONS)) {
		const h = find(holidays(2026, c), "Bettagsmontag");
		if (c === "VD") assert.deepEqual([h.date, h.scope], ["2026-09-21", "cantonal"]);
		else assert.equal(h, undefined, c);
	}
});

test("catholic and cantonal days", () => {
	const lu = holidays(2026, "LU");
	assert.equal(find(lu, "Fronleichnam").date, "2026-06-04");
	assert.equal(find(lu, "Mariä Empfängnis").scope, "cantonal");
	assert.equal(find(lu, "Peter und Paul").scope, "partial");
	assert.equal(find(holidays(2026, "ZH"), "Fronleichnam"), undefined);
	assert.equal(find(holidays(2026, "GE"), "Genfer Bettag").date, "2026-09-10");
	assert.equal(find(holidays(2026, "GE"), "Restauration der Republik").date, "2026-12-31");
	assert.equal(find(holidays(2026, "JU"), "Fest der Unabhängigkeit").date, "2026-06-23");
	// first Thursday in April, a week later when it is Maundy Thursday
	assert.equal(find(holidays(2026, "GL"), "Näfelser Fahrt").date, "2026-04-09");
	assert.equal(find(holidays(2023, "GL"), "Näfelser Fahrt").date, "2023-04-13");
	assert.equal(find(holidays(2027, "GL"), "Näfelser Fahrt").date, "2027-04-01");
	// Neuchâtel: St. Stephen only on a Monday (2022-12-26 was a Monday)
	assert.ok(find(holidays(2022, "NE"), "Stephanstag"));
	assert.equal(find(holidays(2026, "NE"), "Stephanstag"), undefined);
});

test("without canton only national days; unknown canton throws", () => {
	assert.deepEqual(holidays(2026).map((h) => h.name.de), ["Neujahr", "Auffahrt", "Bundesfeiertag", "Weihnachten"]);
	assert.ok(holidays(2026).every((h) => h.scope === "national"));
	assert.throws(() => holidays(2026, "XX"), /Unknown canton/);
});

test("next() is ordered and crosses the year", () => {
	const list = next("ZH", new Date(2026, 11, 20), 4);
	assert.deepEqual(list.map((h) => h.date), ["2026-12-25", "2026-12-26", "2027-01-01", "2027-01-02"]);
	assert.deepEqual(list.map((h) => h.days), [5, 6, 12, 13]);
	const today = next("ZH", new Date(2026, 7, 1, 18, 30), 2);
	assert.equal(today[0].date, "2026-08-01");
	assert.equal(today[0].days, 0);
	const many = next("LU", new Date(2026, 0, 1), 20);
	assert.equal(many.length, 20);
	for (let i = 1; i < many.length; i++) assert.ok(many[i - 1].date <= many[i].date);
});
