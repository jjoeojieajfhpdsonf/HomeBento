"use strict";
// Trilium Notes (TriliumNext): notes, attachments, database size and version from the ETAPI
// (/etapi/metrics?format=json). Older versions without metrics only show the version
// (/etapi/app-info). Needs an ETAPI token (Options → ETAPI).
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	if (typeof b !== "number" || !(b >= 0)) return null;
	const u = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	while (b >= 1024 && i < u.length - 1) (b /= 1024), i++;
	return `${b.toFixed(i && b < 10 ? 1 : 0)} ${u[i]}`;
}

module.exports = {
	kind: "trilium",
	label: "Trilium Notes",
	match: /trilium/,
	repo: "TriliumNext/Trilium",
	ttl: 300000,
	fields: [{ key: "token", label: L("ETAPI-Token", "ETAPI token"), help: L("Trilium → Optionen → ETAPI → Neues Token erstellen", "Trilium → Options → ETAPI → Create new token"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("ETAPI token missing");
		const headers = { Authorization: secrets.token };
		let m = null;
		try {
			m = await json(`${url}/etapi/metrics?format=json`, { headers });
		} catch (err) {
			if (err.message !== "HTTP 404") throw err;
		}
		if (m) {
			if (!m.database || !m.version) throw new Error("Unexpected answer from Trilium");
			const d = m.database;
			return {
				metrics: [
					{ value: d.activeNotes ?? null, label: L("Notizen", "Notes") },
					{ value: d.activeAttachments ?? null, label: L("Anhänge", "Attachments") },
					{ value: fmtBytes(m.statistics && m.statistics.databaseSizeBytes), label: L("Datenbank", "Database") },
					{ value: m.version.app ? `v${m.version.app}` : null, label: "Version" }
				],
				summary: d.protectedNotes ? `${d.protectedNotes} protected notes` : null
			};
		}
		// older versions: no metrics endpoint
		const info = await json(`${url}/etapi/app-info`, { headers });
		if (!info || !info.appVersion) throw new Error("Unexpected answer from Trilium");
		return {
			metrics: [
				{ value: null, label: L("Notizen", "Notes") },
				{ value: `v${info.appVersion}`, label: "Version" }
			],
			summary: "Update Trilium to see the number of notes"
		};
	}
};
