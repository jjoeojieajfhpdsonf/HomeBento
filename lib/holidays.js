"use strict";
// Public holidays of Switzerland, computed locally (no network).
//
// Source of the cantonal lists: Wikipedia "Feiertage in der Schweiz"
// (https://de.wikipedia.org/wiki/Feiertage_in_der_Schweiz, table "Übersicht der Feiertage" and
// "Regionale und lokale Feiertage", retrieved 2026-10-18), which follows the list of the Federal Office
// of Justice "Feiertage der Kantone" (https://www.bj.admin.ch → Zivilprozessrecht → kant-feiertage.pdf).
// Mapping of the table marks: A/B/D (holiday or general day of rest in the whole canton) → "cantonal",
// a/d (only some municipalities) and C/c (half day) → "partial". Days observed in all 26 cantons → "national".
// Näfelser Fahrt: first Thursday in April, one week later if that Thursday is in Holy Week (Canton of Glarus).
// Left out on purpose: Fasnacht days (no legal holidays), city festivals with moving dates (Sechseläuten,
// Knabenschiessen) and Escalade (not a day off).

const CANTONS = {
	ZH: { de: "Zürich", en: "Zurich" },
	BE: { de: "Bern", en: "Bern" },
	LU: { de: "Luzern", en: "Lucerne" },
	UR: { de: "Uri", en: "Uri" },
	SZ: { de: "Schwyz", en: "Schwyz" },
	OW: { de: "Obwalden", en: "Obwalden" },
	NW: { de: "Nidwalden", en: "Nidwalden" },
	GL: { de: "Glarus", en: "Glarus" },
	ZG: { de: "Zug", en: "Zug" },
	FR: { de: "Freiburg", en: "Fribourg" },
	SO: { de: "Solothurn", en: "Solothurn" },
	BS: { de: "Basel-Stadt", en: "Basel-City" },
	BL: { de: "Basel-Landschaft", en: "Basel-Country" },
	SH: { de: "Schaffhausen", en: "Schaffhausen" },
	AR: { de: "Appenzell Ausserrhoden", en: "Appenzell Outer Rhodes" },
	AI: { de: "Appenzell Innerrhoden", en: "Appenzell Inner Rhodes" },
	SG: { de: "St. Gallen", en: "St. Gallen" },
	GR: { de: "Graubünden", en: "Grisons" },
	AG: { de: "Aargau", en: "Aargau" },
	TG: { de: "Thurgau", en: "Thurgau" },
	TI: { de: "Tessin", en: "Ticino" },
	VD: { de: "Waadt", en: "Vaud" },
	VS: { de: "Wallis", en: "Valais" },
	NE: { de: "Neuenburg", en: "Neuchâtel" },
	GE: { de: "Genf", en: "Geneva" },
	JU: { de: "Jura", en: "Jura" }
};

const DAY = 86400000;
const ALL = Object.keys(CANTONS).join(" ");
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const utc = (y, m, d) => Date.UTC(y, m - 1, d);
const weekday = (t) => new Date(t).getUTCDay();
// first given weekday (0 = Sunday) on or after a date
const onOrAfter = (t, wd) => t + ((wd - weekday(t) + 7) % 7) * DAY;

// Easter Sunday (Gregorian computus, anonymous algorithm) as UTC timestamp.
function easterTime(year) {
	const a = year % 19, b = Math.floor(year / 100), c = year % 100;
	const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
	const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
	const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
	const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
	return utc(year, month, day);
}
const easter = (year) => iso(easterTime(year));

// date(year, easter) → UTC timestamp; in = whole canton, part = some municipalities / half day.
const fixed = (m, d) => (y) => utc(y, m, d);
const fromEaster = (n) => (y, e) => e + n * DAY;
const RULES = [
	{ de: "Neujahr", en: "New Year's Day", date: fixed(1, 1), in: ALL },
	{ de: "Berchtoldstag", en: "St. Berchtold's Day", date: fixed(1, 2), in: "ZH BE LU OW GL ZG FR SO SH TG VD NE GE JU", part: "GR AG" },
	{ de: "Heilige Drei Könige", en: "Epiphany", date: fixed(1, 6), in: "UR SZ TI", part: "GR" },
	{ de: "Ausrufung der Republik", en: "Republic Day", date: fixed(3, 1), in: "NE" },
	{ de: "Josefstag", en: "St. Joseph's Day", date: fixed(3, 19), in: "UR SZ NW TI VS", part: "LU ZG GR" },
	{
		de: "Näfelser Fahrt", en: "Näfels Pilgrimage", in: "GL",
		date: (y, e) => {
			const t = onOrAfter(utc(y, 4, 1), 4);
			return t === e - 3 * DAY ? t + 7 * DAY : t;
		}
	},
	{ de: "Karfreitag", en: "Good Friday", date: fromEaster(-2), in: "ZH BE LU UR SZ OW NW GL ZG FR SO BS BL SH AR AI SG GR AG TG VD NE GE JU" },
	{ de: "Ostermontag", en: "Easter Monday", date: fromEaster(1), in: "ZH BE LU UR SZ OW NW GL ZG FR BS BL SH AR AI SG GR TG TI VD NE GE JU", part: "SO AG" },
	{ de: "Tag der Arbeit", en: "Labour Day", date: fixed(5, 1), in: "ZH BS BL SH TG TI NE JU", part: "FR SO AG" },
	{ de: "Auffahrt", en: "Ascension Day", date: fromEaster(39), in: ALL },
	{ de: "Pfingstmontag", en: "Whit Monday", date: fromEaster(50), in: "ZH BE LU UR SZ OW NW GL ZG FR BS BL SH AR AI SG GR TG TI VD NE GE JU", part: "SO AG" },
	{ de: "Fronleichnam", en: "Corpus Christi", date: fromEaster(60), in: "LU UR SZ OW NW ZG AI TI VS JU", part: "FR SO BL GR AG NE" },
	{ de: "Fest der Unabhängigkeit", en: "Jura Independence Day", date: fixed(6, 23), in: "JU" },
	{ de: "Peter und Paul", en: "Saints Peter and Paul", date: fixed(6, 29), in: "TI", part: "LU GR" },
	{ de: "Bundesfeiertag", en: "Swiss National Day", date: fixed(8, 1), in: ALL },
	{ de: "Mariä Himmelfahrt", en: "Assumption Day", date: fixed(8, 15), in: "LU UR SZ OW NW ZG AI TI VS JU", part: "FR SO BL GR AG" },
	// Thursday after the first Sunday in September
	{ de: "Genfer Bettag", en: "Geneva Fast", date: (y) => onOrAfter(utc(y, 9, 1), 0) + 4 * DAY, in: "GE" },
	// Monday after the Federal Fast (third Sunday in September)
	{ de: "Bettagsmontag", en: "Federal Fast Monday", date: (y) => onOrAfter(utc(y, 9, 1), 0) + 15 * DAY, in: "VD" },
	{ de: "Mauritiustag", en: "St. Maurice's Day", date: fixed(9, 22), part: "AI" },
	{ de: "Bruder Klaus", en: "St. Nicholas of Flüe", date: fixed(9, 25), in: "OW" },
	{ de: "St. Ursentag", en: "St. Ursus' Day", date: fixed(9, 30), part: "SO" },
	{ de: "St. Leodegar", en: "St. Leodegar's Day", date: fixed(10, 2), part: "LU" },
	{ de: "Allerheiligen", en: "All Saints' Day", date: fixed(11, 1), in: "LU UR SZ OW NW GL ZG AI SG TI VS JU", part: "FR SO GR AG" },
	{ de: "Mariä Empfängnis", en: "Immaculate Conception", date: fixed(12, 8), in: "LU UR SZ OW NW ZG AI TI VS", part: "FR SO GR AG" },
	{ de: "Weihnachten", en: "Christmas Day", date: fixed(12, 25), in: ALL },
	// Neuchâtel: only when it falls on a Monday
	{ de: "Stephanstag", en: "St. Stephen's Day", date: fixed(12, 26), in: "ZH BE LU UR SZ OW NW GL ZG FR BS BL SH AR AI SG GR TG TI", part: "SO AG", only: { NE: (t) => weekday(t) === 1 } },
	{ de: "Restauration der Republik", en: "Restoration of the Republic", date: fixed(12, 31), in: "GE" }
].map((r) => ({ ...r, in: (r.in || "").split(" ").filter(Boolean), part: (r.part || "").split(" ").filter(Boolean) }));

const normCanton = (canton) => {
	if (canton === undefined || canton === null || canton === "") return null;
	const c = String(canton).toUpperCase();
	if (!CANTONS[c]) throw new Error(`Unknown canton: ${canton}`);
	return c;
};

// Holidays of one year for a canton, sorted by date. Without a canton only the national ones.
function holidays(year, canton) {
	const c = normCanton(canton);
	const e = easterTime(year);
	const out = [];
	for (const r of RULES) {
		const t = r.date(year, e);
		const national = r.in.length === 26;
		let scope = null;
		if (national) scope = "national";
		else if (!c) continue;
		else if (r.in.includes(c) || (r.only && r.only[c] && r.only[c](t))) scope = "cantonal";
		else if (r.part.includes(c)) scope = "partial";
		if (scope) out.push({ t, date: iso(t), name: { de: r.de, en: r.en }, scope });
	}
	return out.sort((a, b) => a.t - b.t).map(({ t, ...h }) => h);
}

// The next n holidays from `from` (today included), each with `days` until then (0 = today).
function next(canton, from = new Date(), n = 5) {
	const y = from.getFullYear();
	const today = utc(y, from.getMonth() + 1, from.getDate());
	const list = [];
	for (let year = y; list.length < n && year <= y + 2; year++) {
		for (const h of holidays(year, canton)) {
			const t = Date.parse(h.date);
			if (t >= today && list.length < n) list.push({ ...h, days: Math.round((t - today) / DAY) });
		}
	}
	return list;
}

module.exports = { holidays, next, easter, CANTONS };
