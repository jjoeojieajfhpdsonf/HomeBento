"use strict";
// Watchtower: containers scanned, updated and failed in the last run, from the HTTP API
// /v1/metrics (Prometheus format). Needs WATCHTOWER_HTTP_API_METRICS=true and the token from
// WATCHTOWER_HTTP_API_TOKEN, sent as a Bearer token. The API listens on port 8080 in the container.
const L = (de, en) => ({ de, en });

// "name value" lines without labels -> { name: value }
function parse(text) {
	const out = {};
	for (const line of text.split("\n")) {
		const m = /^(\w+)(?:\{[^}]*\})?\s+([\d.eE+-]+|NaN)/.exec(line.trim());
		if (m && !(m[1] in out)) out[m[1]] = Number(m[2]);
	}
	return out;
}

module.exports = {
	kind: "watchtower",
	label: "Watchtower",
	match: /watchtower/,
	ttl: 5 * 60000,
	fields: [{ key: "token", label: "API-Token", help: L("Wert von WATCHTOWER_HTTP_API_TOKEN (dazu WATCHTOWER_HTTP_API_METRICS=true)", "Value of WATCHTOWER_HTTP_API_TOKEN (plus WATCHTOWER_HTTP_API_METRICS=true)"), secret: true }],
	parse,
	async fetch({ url, secrets, request }) {
		if (!secrets.token) throw new Error("API token missing");
		const r = await request(`${url}/v1/metrics`, { headers: { Authorization: `Bearer ${secrets.token}` }, timeout: 10000 });
		if (!r.status) throw new Error(r.error);
		if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the API token)");
		if (r.status === 404) throw new Error("No metrics API (set WATCHTOWER_HTTP_API_METRICS=true)");
		if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
		const m = parse(r.body.toString("utf8"));
		if (m.watchtower_containers_scanned === undefined) throw new Error("Unexpected answer from Watchtower");
		const failed = m.watchtower_containers_failed || 0;
		return {
			metrics: [
				{ value: m.watchtower_containers_scanned, label: L("Geprüft", "Scanned") },
				{ value: m.watchtower_containers_updated || 0, label: L("aktualisiert", "updated") },
				{ value: failed, label: L("fehlgeschlagen", "failed"), warn: failed > 0 }
			],
			warnings: failed ? [`Watchtower could not update ${failed} container${failed === 1 ? "" : "s"}`] : []
		};
	}
};
