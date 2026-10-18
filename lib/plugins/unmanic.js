"use strict";
// Unmanic: busy workers (/unmanic/api/v2/workers/status), pending tasks (POST pending/tasks) and
// the completed and failed tasks (POST history/tasks). Unmanic has no login of its own.
const path = require("node:path");
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "unmanic",
	label: "Unmanic",
	match: /unmanic/,
	ttl: 30000,
	fields: [],
	async fetch({ url, json }) {
		const api = `${url}/unmanic/api/v2`;
		const page = { start: 0, length: 1 };
		const [workers, pending, history] = await Promise.all([
			json(`${api}/workers/status`),
			json(`${api}/pending/tasks`, { method: "POST", body: page }),
			json(`${api}/history/tasks`, { method: "POST", body: page }).catch(() => null)
		]);
		if (!workers || !Array.isArray(workers.workers_status) || !pending || pending.recordsTotal === undefined) throw new Error("Unexpected answer from Unmanic");
		const list = workers.workers_status;
		const busy = list.filter((w) => !w.idle);
		const failed = history ? Number(history.failedCount) || 0 : null;
		const metrics = [
			{ value: `${busy.length}/${list.length}`, label: L("Worker aktiv", "Workers busy") },
			{ value: Number(pending.recordsTotal) || 0, label: L("ausstehend", "Pending") }
		];
		if (history) metrics.push({ value: Number(history.successCount) || 0, label: L("erledigt", "Completed") }, { value: failed, label: L("fehlgeschlagen", "Failed"), warn: failed > 0 });
		return {
			metrics,
			items: list.map((w) => ({
				title: w.name || `Worker ${w.id}`,
				sub: w.idle ? (w.paused ? "paused" : "idle") : [w.current_file ? path.basename(String(w.current_file)) : "", w.paused ? "paused" : ""].filter(Boolean).join(" · "),
				status: w.paused ? "warn" : "ok"
			})),
			summary: null
		};
	}
};
