"use strict";
// Firefly III: net worth and what was spent and earned this month from /api/v1/summary/basic.
// Needs a personal access token (Firefly III → Options → Profile → OAuth → Personal Access Tokens).
const L = (de, en) => ({ de, en });

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v, locale) => Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");

// Firefly formats the values itself (value_parsed); otherwise format the amount with the currency.
function money(entry) {
	if (!entry) return null;
	if (typeof entry.value_parsed === "string" && entry.value_parsed) return entry.value_parsed;
	const v = Number(entry.monetary_value);
	if (!Number.isFinite(v)) return null;
	const c = entry.currency_symbol || entry.currency_code || "";
	return L(`${c} ${num(v, "de-CH")}`.trim(), `${c} ${num(v, "en-US")}`.trim());
}

module.exports = {
	kind: "firefly",
	label: "Firefly III",
	match: /^(?!.*(importer|cron|postgres|mariadb|mysql|[-_ ]db\b)).*firefly/,
	repo: "firefly-iii/firefly-iii",
	ttl: 600000,
	fields: [{ key: "token", label: L("Persönliches Zugriffstoken", "Personal access token"), help: L("Firefly III → Optionen → Profil → OAuth → Persönliche Zugangs-Tokens", "Firefly III → Options → Profile → OAuth → Personal Access Tokens"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Access token missing");
		const now = new Date();
		const start = isoDay(new Date(now.getFullYear(), now.getMonth(), 1));
		const end = isoDay(new Date(now.getFullYear(), now.getMonth() + 1, 0));
		const s = await json(`${url}/api/v1/summary/basic?start=${start}&end=${end}`, { headers: { Authorization: `Bearer ${secrets.token}` } });
		if (!s || typeof s !== "object" || Array.isArray(s)) throw new Error("Unexpected answer from Firefly III");
		// keys look like "net-worth-in-EUR", "spent-in-EUR", …; one set per currency
		const currencies = [...new Set(Object.keys(s).map((k) => (/^[a-z-]+-in-(.+)$/.exec(k) || [])[1]).filter(Boolean))];
		if (!currencies.length) throw new Error("Unexpected answer from Firefly III");
		const nonZero = (c) => Number((s[`net-worth-in-${c}`] || {}).monetary_value) !== 0;
		const cur = currencies.find((c) => s[`net-worth-in-${c}`] && nonZero(c)) || currencies.find((c) => s[`net-worth-in-${c}`]) || currencies[0];
		const get = (what) => s[`${what}-in-${cur}`];
		const unpaid = get("bills-unpaid");
		const others = currencies.filter((c) => c !== cur);
		return {
			metrics: [
				{ value: money(get("net-worth")), label: L("Vermögen", "Net worth") },
				{ value: money(get("spent")), label: L("ausgegeben (Monat)", "spent (month)") },
				{ value: money(get("earned")), label: L("eingenommen (Monat)", "earned (month)") },
				{ value: money(unpaid), label: L("offene Rechnungen", "bills unpaid") }
			],
			summary: others.length ? `Also in ${others.join(", ")}` : null
		};
	}
};
