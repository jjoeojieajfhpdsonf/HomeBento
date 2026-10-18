"use strict";
// CrowdSec: active decisions (bans) of the Local API with a bouncer key (GET /v1/decisions,
// X-Api-Key), and the alerts of the last 24 hours with an optional machine login
// (POST /v1/watchers/login, then GET /v1/alerts with the token). Decisions from the community
// blocklist (CAPI) and subscribed lists are left out; they are thousands and not about you.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const tokens = new Map(); // url + login hash -> { token, expire }
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;
const LOCAL = /^(crowdsec|cscli|console|appsec|cscli-import)$/i;

async function login(url, json, user, password) {
	let r;
	try {
		r = await json(`${url}/v1/watchers/login`, { method: "POST", body: { machine_id: user, password, scenarios: [] } });
	} catch (err) {
		if (/Access denied/.test(err.message)) throw new Error("Access denied (check machine ID and password)");
		throw err;
	}
	if (!r || !r.token) throw new Error("CrowdSec login failed");
	return { token: r.token, expire: Date.parse(r.expire) || Date.now() + 3600000 };
}

// GET with the machine token; logs in again once when the token has expired.
async function machineGet(url, json, user, password, path) {
	const key = keyOf(url, user, password);
	let t = tokens.get(key);
	for (let attempt = 0; attempt < 2; attempt++) {
		if (!t || t.expire - Date.now() < 60000) {
			t = await login(url, json, user, password);
			tokens.set(key, t);
		}
		try {
			return await json(`${url}${path}`, { headers: { Authorization: `Bearer ${t.token}` } });
		} catch (err) {
			if (!/Access denied/.test(err.message) || attempt) throw err;
			tokens.delete(key);
			t = null;
		}
	}
	return null;
}

// Active decisions; older versions do not know the "origins" filter, then all are fetched.
async function bouncerDecisions(url, json, key) {
	const opts = { headers: { "X-Api-Key": key }, maxBytes: 30_000_000 };
	try {
		return await json(`${url}/v1/decisions?origins=crowdsec,cscli,console,appsec`, opts);
	} catch (err) {
		if (/Access denied/.test(err.message) || !/HTTP (400|500)/.test(err.message)) throw err;
		return json(`${url}/v1/decisions`, opts);
	}
}

const shortScenario = (s) => String(s || "manual").replace(/^crowdsecurity\//, "");

module.exports = {
	kind: "crowdsec",
	label: "CrowdSec",
	match: /^(?!.*(bouncer|postgres|mariadb|mysql|[-_]db\b)).*crowdsec/,
	repo: "crowdsecurity/crowdsec",
	ttl: 60000,
	fields: [
		{ key: "apiKey", label: L("Bouncer-Schlüssel", "Bouncer key"), help: L("cscli bouncers add homebento – zeigt den Schlüssel einmal an. Die Adresse ist die Local API (Port 8080).", "cscli bouncers add homebento – shows the key once. The address is the Local API (port 8080)."), secret: true },
		{ key: "username", label: L("Maschinen-ID (optional)", "Machine ID (optional)"), help: L("Für die Alarme: cscli machines add homebento --auto zeigt ID und Passwort", "For the alerts: cscli machines add homebento --auto shows ID and password") },
		{ key: "password", label: L("Maschinen-Passwort", "Machine password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const machine = !!(secrets.username && secrets.password);
		if (!secrets.apiKey && !machine) throw new Error("API key missing");

		let decisions = null;
		let alerts = null;
		let banAlerts = null;
		await Promise.all([
			secrets.apiKey &&
				bouncerDecisions(url, json, secrets.apiKey).then(
					(r) => (decisions = (Array.isArray(r) ? r : []).filter((d) => LOCAL.test(d.origin || "crowdsec"))),
					(err) => {
						throw /Access denied/.test(err.message) ? new Error("Access denied (check the bouncer key)") : err;
					}
				),
			machine &&
				machineGet(url, json, secrets.username, secrets.password, "/v1/alerts?since=24h&limit=500&include_capi=false").then((r) => {
					alerts = Array.isArray(r) ? r : []; // crowdsec answers null when there are none
				}),
			machine &&
				!secrets.apiKey &&
				machineGet(url, json, secrets.username, secrets.password, "/v1/alerts?decision_type=ban&include_capi=false&has_active_decision=true&limit=1000").then((r) => {
					banAlerts = Array.isArray(r) ? r : [];
				})
		]);

		// without a bouncer key the bans come from the alerts that still have an active ban
		const bans = decisions ? decisions.filter((d) => d.type === "ban") : banAlerts.flatMap((a) => (Array.isArray(a.decisions) && a.decisions.length ? a.decisions.filter((d) => d.type === "ban") : [{ type: "ban", scenario: a.scenario, value: a.source && a.source.value }]));
		const other = decisions ? decisions.length - bans.length : null;
		const byScenario = new Map();
		for (const b of bans) byScenario.set(shortScenario(b.scenario), (byScenario.get(shortScenario(b.scenario)) || 0) + 1);
		const alertScenarios = new Map();
		for (const a of alerts || []) alertScenarios.set(shortScenario(a.scenario), (alertScenarios.get(shortScenario(a.scenario)) || 0) + 1);
		const top = [...byScenario].sort((a, b) => b[1] - a[1]);

		return {
			metrics: [
				{ value: bans.length, label: L("aktive Sperren", "active bans") },
				...(alerts ? [{ value: alerts.length >= 500 ? "500+" : alerts.length, label: L("Alarme 24 h", "Alerts 24 h") }] : []),
				...(other ? [{ value: other, label: L("andere Entscheide", "other decisions") }] : []),
				...(alertScenarios.size ? [{ value: [...alertScenarios].sort((a, b) => b[1] - a[1])[0][0], label: L("häufigster Alarm", "top alert") }] : [])
			].slice(0, 4),
			items: top.map(([scenario, n]) => ({ title: scenario, sub: `${n}×`, status: "ok" })),
			summary: top.length ? `Most bans: ${top[0][0]}` : null
		};
	}
};
