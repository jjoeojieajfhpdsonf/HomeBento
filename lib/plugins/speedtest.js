"use strict";
// Speedtest Tracker (alexjustesen/speedtest-tracker): the latest result it measured. HomeBento runs
// no speed tests itself. API token: Speedtest Tracker → API Tokens (older versions need none).
const L = (de, en) => ({ de, en });

const round = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10);

function age(date) {
	const min = Math.max(0, Math.round((Date.now() - date.getTime()) / 60000));
	if (min < 60) return `${min} min`;
	if (min < 48 * 60) return `${Math.round(min / 60)} h`;
	return `${Math.round(min / 1440)} d`;
}

// "2024-05-01 12:00:00" (local time) or ISO
function parseDate(s) {
	if (!s) return null;
	const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(s) ? s.replace(" ", "T") : s);
	return isNaN(d) ? null : d;
}

// v1 API: download/upload in bytes per second (download_bits in bits); old API: already Mbit/s.
function mbit(r, key, legacy) {
	if (typeof r[`${key}_bits`] === "number") return r[`${key}_bits`] / 1e6;
	if (r[key] === null || r[key] === undefined || r[key] === "") return null;
	const v = Number(r[key]);
	return legacy ? v : (v * 8) / 1e6;
}

module.exports = {
	kind: "speedtest",
	label: "Speedtest Tracker",
	match: /speedtest.?tracker/,
	repo: "alexjustesen/speedtest-tracker",
	ttl: 5 * 60000,
	fields: [{ key: "token", label: "API-Token", help: L("Speedtest Tracker → API-Token (ältere Versionen brauchen keinen)", "Speedtest Tracker → API Tokens (older versions need none)"), secret: true }],
	async fetch({ url, secrets, request }) {
		const headers = { Accept: "application/json", ...(secrets.token ? { Authorization: `Bearer ${secrets.token}` } : {}) };
		const get = async (path) => {
			const r = await request(`${url}${path}`, { headers });
			if (!r.status) throw new Error(r.error);
			let body = null;
			try {
				body = JSON.parse(r.body.toString("utf8"));
			} catch {
				body = null;
			}
			return { status: r.status, body };
		};
		// the v1 API needs a token; the old /api/speedtest/latest (Mbit/s) needs none and still exists
		let legacy = !secrets.token;
		let r = await get(legacy ? "/api/speedtest/latest" : "/api/v1/results/latest");
		const noResults = (x) => x.status === 404 && x.body && /result/i.test(x.body.message || "");
		if (!legacy && r.status === 404 && !noResults(r)) {
			r = await get("/api/speedtest/latest");
			legacy = true;
		}
		if (r.status === 401 || r.status === 403) throw new Error(secrets.token ? "Access denied (check the token)" : "Token missing");
		if (noResults(r)) return { metrics: [{ value: "–", label: "Download Mbit/s" }], summary: "No results yet" };
		if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
		const d = r.body && r.body.data;
		if (!d || typeof d !== "object") throw new Error("Unexpected answer from Speedtest Tracker");
		const failed = d.status === "failed" || d.failed === true;
		const when = parseDate(d.created_at || d.updated_at);
		const down = mbit(d, "download", legacy);
		const up = mbit(d, "upload", legacy);
		const ping = d.ping !== null && d.ping !== undefined ? Number(d.ping) : null;
		const warnings = failed ? [`The last speed test failed${when ? ` (${age(when)} ago)` : ""}`] : [];
		return {
			metrics: [
				{ value: down !== null ? round(down) : "–", label: "Download Mbit/s", warn: failed || d.healthy === false },
				{ value: up !== null ? round(up) : "–", label: "Upload Mbit/s", warn: failed || d.healthy === false },
				{ value: ping !== null ? `${Math.round(ping)} ms` : "–", label: "Ping" },
				{ value: when ? age(when) : "–", label: L("letzter Test", "last test"), warn: failed }
			],
			warnings,
			summary: failed ? "Last test failed" : null
		};
	}
};
