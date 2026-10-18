"use strict";
// Tdarr: queue, processed and failed files plus the space saved, from the statistics document
// (POST /api/v2/cruddb, StatisticsJSONDB/statistics), and the nodes (/api/v2/get-nodes).
// Tables 1–3 are the transcode queue/success/error, 4–6 the same for health checks.
// An API key (x-api-key) is only needed when authentication is on in Tdarr.
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	let v = Math.abs(Number(b) || 0);
	while (v >= 1000 && i < u.length - 1) (v /= 1000), i++;
	return `${b < 0 ? "-" : ""}${v < 10 && i > 1 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

module.exports = {
	kind: "tdarr",
	label: "Tdarr",
	// the server, not the separate tdarr_node containers
	match: /tdarr(?![-_]?node)/,
	ttl: 60000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Nur nötig, wenn die Authentifizierung in Tdarr eingeschaltet ist", "Only needed when authentication is turned on in Tdarr"), secret: true }],
	fmtBytes,
	async fetch({ url, secrets, json }) {
		const headers = secrets.apiKey ? { "x-api-key": secrets.apiKey } : {};
		const [s, nodes] = await Promise.all([
			json(`${url}/api/v2/cruddb`, { method: "POST", headers, body: { data: { collection: "StatisticsJSONDB", mode: "getById", docID: "statistics" } } }),
			json(`${url}/api/v2/get-nodes`, { headers }).catch(() => null)
		]);
		if (!s || typeof s !== "object" || s.table1Count === undefined) throw new Error("Unexpected answer from Tdarr");
		// the "viewable" counts leave out disabled libraries, like the tables in the web UI
		const n = (i) => Number(s[`table${i}ViewableCount`] || s[`table${i}Count`]) || 0;
		const queue = n(1) + n(4);
		const done = n(2) + n(5);
		const errored = n(3) + n(6);
		const saved = (Number(s.sizeDiff) || 0) * 1e9; // sizeDiff is in GB
		const nodeList = nodes && typeof nodes === "object" ? Object.values(nodes).filter((x) => x && typeof x === "object") : [];
		const items = nodeList.map((x) => {
			const workers = Object.values(x.workers || {});
			return {
				title: x.nodeName || x._id || "Node",
				sub: x.nodePaused ? "paused" : workers.length ? `${workers.length} worker(s) busy` : "idle",
				status: x.nodePaused ? "warn" : "ok"
			};
		});
		const busy = nodeList.reduce((a, x) => a + Object.keys(x.workers || {}).length, 0);
		return {
			metrics: [
				{ value: queue, label: L("Warteschlange", "Queue") },
				{ value: done, label: L("verarbeitet", "Processed") },
				{ value: errored, label: L("Fehler", "Errored"), warn: errored > 0 },
				{ value: fmtBytes(saved), label: L("gespart", "Saved") }
			],
			items,
			summary: nodes ? `${busy} worker(s) busy on ${nodeList.length} node(s)` : null
		};
	}
};
