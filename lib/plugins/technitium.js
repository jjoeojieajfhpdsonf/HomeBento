"use strict";
// Technitium DNS Server: queries, blocked queries and clients of the last 24 hours from
// /api/dashboard/stats/get with an API token (the token goes in the query string, as the API wants).
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "technitium",
	label: "Technitium DNS",
	match: /technitium/,
	repo: "TechnitiumSoftware/DnsServer",
	ttl: 60000,
	fields: [{ key: "token", label: L("API-Token", "API token"), help: L("Technitium → Administration → Sessions → Create Token", "Technitium → Administration → Sessions → Create Token"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("API token missing");
		const r = await json(`${url}/api/dashboard/stats/get?token=${encodeURIComponent(secrets.token)}&type=LastDay&utc=true`);
		if (r && r.status === "invalid-token") throw new Error("Access denied (check the API token)");
		if (r && r.status === "error") throw new Error(`Technitium: ${r.errorMessage || "error"}`);
		const s = r && r.status === "ok" && r.response && r.response.stats;
		if (!s) throw new Error("Unexpected answer from Technitium");
		const total = Number(s.totalQueries) || 0;
		const blocked = Number(s.totalBlocked) || 0;
		const failed = Number(s.totalServerFailure) || 0;
		const blockedList = Array.isArray(r.response.topBlockedDomains) ? r.response.topBlockedDomains : [];
		const listed = (Number(s.blockListZones) || 0) + (Number(s.blockedZones) || 0);
		// many SERVFAIL answers usually mean the upstream resolvers are unreachable
		const failShare = total >= 100 ? failed / total : 0;
		return {
			metrics: [
				{ value: total, label: L("Anfragen 24 h", "Queries 24 h") },
				{ value: blocked, label: L("blockiert", "blocked") },
				{ value: `${total ? ((100 * blocked) / total).toFixed(1) : "0.0"} %`, label: L("blockiert", "blocked") },
				{ value: Number(s.totalClients) || 0, label: L("Clients", "Clients") }
			],
			items: blockedList.slice(0, 10).map((d) => ({ title: d.name, sub: `${d.hits}×`, status: "ok" })),
			warnings: failShare > 0.2 ? [`Technitium: ${Math.round(failShare * 100)} % of the queries failed (server failure)`] : [],
			summary: listed ? `${listed.toLocaleString("en-US")} domains on the blocklist` : null
		};
	}
};
