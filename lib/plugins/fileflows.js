"use strict";
// FileFlows: queue, files being processed and processed files. Up to version 26.10 from /api/status
// (no login); newer versions from the Fenrus dashboard endpoint (/webhook/fenrus) with its token,
// sent as X-Webhook-Token. With a token the new endpoint is tried first.
const L = (de, en) => ({ de, en });

const num = (v) => Number(v) || 0;

module.exports = {
	kind: "fileflows",
	label: "FileFlows",
	match: /fileflows/,
	ttl: 30000,
	fields: [
		{
			key: "token",
			label: "Fenrus-Token",
			help: L("Ab FileFlows 26.10: den Fenrus-Dashboard-Endpunkt einschalten und dessen Token eintragen. Ältere Versionen brauchen keinen.", "From FileFlows 26.10: turn on the Fenrus dashboard endpoint and enter its token. Older versions need none."),
			secret: true
		}
	],
	async fetch({ url, secrets, request, json }) {
		if (secrets.token) {
			const r = await request(`${url}/webhook/fenrus`, { headers: { Accept: "application/json", "X-Webhook-Token": secrets.token } });
			if (!r.status) throw new Error(r.error);
			if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the Fenrus token)");
			if (r.status === 200) {
				let d;
				try {
					d = JSON.parse(r.body.toString("utf8"));
				} catch {
					throw new Error("Unexpected answer (not JSON)");
				}
				if (!d || d.Unprocessed === undefined) throw new Error("Unexpected answer from FileFlows");
				const failed = num(d.Failed);
				return {
					metrics: [
						{ value: num(d.Unprocessed), label: L("Warteschlange", "Queue") },
						{ value: num(d.Processing), label: L("in Arbeit", "Processing") },
						{ value: num(d.Processed), label: L("verarbeitet", "Processed") },
						{ value: failed, label: L("fehlgeschlagen", "Failed"), warn: failed > 0 }
					]
				};
			}
			// 404: older version without the endpoint, fall back to /api/status
		}
		const r = await request(`${url}/api/status`, { headers: { Accept: "application/json" } });
		if (!r.status) throw new Error(r.error);
		if (r.status === 404 || r.status === 401 || r.status === 403) throw new Error(secrets.token ? `HTTP ${r.status}` : "Fenrus token missing (needed from FileFlows 26.10)");
		if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
		let d;
		try {
			d = JSON.parse(r.body.toString("utf8"));
		} catch {
			throw new Error("Unexpected answer (not JSON)");
		}
		if (!d || d.queue === undefined) throw new Error("Unexpected answer from FileFlows");
		const files = Array.isArray(d.processingFiles) ? d.processingFiles : [];
		return {
			metrics: [
				{ value: num(d.queue), label: L("Warteschlange", "Queue") },
				{ value: num(d.processing), label: L("in Arbeit", "Processing") },
				{ value: num(d.processed), label: L("verarbeitet", "Processed") },
				{ value: d.time || "0:00", label: L("Laufzeit", "Time") }
			],
			items: files.map((f) => ({
				title: f.name || f.relativePath || "File",
				sub: [f.library, f.step, f.stepPercent !== undefined ? `${Math.round(num(f.stepPercent))} %` : ""].filter(Boolean).join(" · "),
				status: "ok"
			}))
		};
	}
};
