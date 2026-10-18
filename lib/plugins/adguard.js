"use strict";
// AdGuard Home: DNS queries and blocked queries of the statistics period (24 hours by default)
// from /control/stats and whether protection is on from /control/status. Login with basic auth.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "adguard",
	label: "AdGuard Home",
	match: /adguard/,
	repo: "AdguardTeam/AdGuardHome",
	ttl: 30000,
	fields: [
		{ key: "username", label: L("Benutzer", "User") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		if (secrets.username && !secrets.password) throw new Error("Password missing");
		const headers = secrets.username ? { Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString("base64")}` } : {};
		const [stats, status] = await Promise.all([json(`${url}/control/stats`, { headers }), json(`${url}/control/status`, { headers })]);
		const total = stats.num_dns_queries || 0;
		const blocked = stats.num_blocked_filtering || 0;
		const on = status.protection_enabled !== false;
		const warnings = [];
		if (!on) warnings.push("AdGuard Home protection is off");
		if (status.running === false) warnings.push("AdGuard Home DNS server is not running");
		// top_blocked_domains: [{ "ads.example.com": 120 }, …]
		const top = (stats.top_blocked_domains || []).slice(0, 10).map((x) => Object.entries(x)[0]).filter(Boolean);
		return {
			metrics: [
				{ value: total, label: L("DNS-Anfragen", "DNS queries") },
				{ value: blocked, label: L("blockiert", "blocked") },
				{ value: `${(total ? (100 * blocked) / total : 0).toFixed(1)} %`, label: L("blockiert", "blocked") },
				{ value: on ? L("An", "On") : L("Aus", "Off"), label: L("Schutz", "Protection"), warn: !on }
			],
			items: top.map(([domain, n]) => ({ title: domain, sub: `${n}×`, status: "ok" })),
			warnings,
			summary: status.version ? `Version ${String(status.version).replace(/^v/, "")}` : null
		};
	}
};
