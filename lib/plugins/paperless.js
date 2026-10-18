"use strict";
// Paperless-ngx: documents and inbox from /api/statistics/, failed tasks from /api/tasks/.
// Token: Paperless → My profile → API auth token.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "paperless",
	label: "Paperless-ngx",
	match: /^(?!.*(redis|valkey|broker|postgres|mariadb|gotenberg|tika|[-_ ]db\b|\bai\b|-gpt)).*paperless/,
	repo: "paperless-ngx/paperless-ngx",
	ttl: 60000,
	fields: [{ key: "token", label: "API-Token", help: L("Paperless → Mein Profil → API-Token", "Paperless → My profile → API auth token"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Token missing");
		const headers = { Authorization: `Token ${secrets.token}` };
		const [stats, tasks] = await Promise.all([json(`${url}/api/statistics/`, { headers }), json(`${url}/api/tasks/`, { headers })]);
		const list = Array.isArray(tasks) ? tasks : (tasks && tasks.results) || [];
		const today = new Date().toDateString();
		const failed = list.filter((t) => t.status === "FAILURE" && !t.acknowledged && t.date_created && new Date(t.date_created).toDateString() === today);
		return {
			metrics: [
				{ value: stats.documents_total || 0, label: L("Dokumente", "Documents") },
				{ value: stats.documents_inbox || 0, label: L("Posteingang", "Inbox") },
				{ value: failed.length, label: L("fehlgeschlagen", "failed tasks"), warn: failed.length > 0 }
			],
			items: failed.map((t) => ({ title: t.task_file_name || t.task_name || t.task_id, sub: String(t.result || "").slice(0, 120), status: "bad" })),
			warnings: failed.map((t) => `Consuming ${t.task_file_name || "a document"} failed`),
			summary: stats.character_count ? `${Number(stats.character_count).toLocaleString("en-US")} characters` : null
		};
	}
};
