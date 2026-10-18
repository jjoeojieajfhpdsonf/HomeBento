"use strict";
// Wallos: active subscriptions, the cost of this month and the next payment
// (api/subscriptions/get_subscriptions.php and get_monthly_cost.php). Wallos takes the API key as
// the query parameter api_key (Wallos → Profile → API Key) and answers wrong keys with success: false.
const L = (de, en) => ({ de, en });

const num = (v, locale) => Number(v).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/’/g, "'");
const money = (v, code) => L(`${code} ${num(v, "de-CH")}`.trim(), `${code} ${num(v, "en-US")}`.trim());

function check(r) {
	if (!r || typeof r !== "object") throw new Error("Unexpected answer from Wallos");
	if (r.success === false) {
		if (/api key/i.test(r.title || "")) throw new Error("Access denied (check the API key)");
		throw new Error(`Wallos: ${r.title || "request failed"}`);
	}
	return r;
}

module.exports = {
	kind: "wallos",
	label: "Wallos",
	match: /wallos/,
	repo: "ellite/Wallos",
	ttl: 600000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Wallos → Profil → API-Schlüssel", "Wallos → Profile → API Key"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const key = encodeURIComponent(secrets.apiKey);
		const now = new Date();
		const [subs, cost] = await Promise.all([
			json(`${url}/api/subscriptions/get_subscriptions.php?api_key=${key}&state=0&sort=next_payment&convert_currency=true`).then(check),
			json(`${url}/api/subscriptions/get_monthly_cost.php?api_key=${key}&month=${now.getMonth() + 1}&year=${now.getFullYear()}`).then(check)
		]);
		if (!Array.isArray(subs.subscriptions)) throw new Error("Unexpected answer from Wallos");
		const code = cost.currency_code || cost.currency_symbol || "";
		const active = subs.subscriptions
			.filter((x) => !Number(x.inactive))
			// prices are converted to the main currency only when Wallos has exchange rates, so items show no currency
			.map((x) => ({ name: x.name || "?", next: x.next_payment || "", price: Number(x.price) }))
			.sort((a, b) => (a.next || "9999").localeCompare(b.next || "9999") || a.name.localeCompare(b.name));
		const next = active.find((x) => x.next);
		const [y, m, d] = next ? next.next.split("-") : [];
		return {
			metrics: [
				{ value: active.length, label: L("Abos aktiv", "Active subscriptions") },
				{ value: cost.monthly_cost !== undefined && Number.isFinite(Number(cost.monthly_cost)) ? money(cost.monthly_cost, code) : cost.localized_monthly_cost || null, label: L("diesen Monat", "this month") },
				{ value: next ? next.name : null, label: next ? L(`nächste am ${d}.${m}.${y}`, `next on ${y}-${m}-${d}`) : L("nächste Zahlung", "next payment") }
			],
			items: active.map((x) => ({ title: x.name, sub: [x.next, Number.isFinite(x.price) ? num(x.price, "en-US") : ""].filter(Boolean).join(" · "), status: "ok" }))
		};
	}
};
