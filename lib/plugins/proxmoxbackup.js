"use strict";
// Proxmox Backup Server: datastore usage (/api2/json/status/datastore-usage) and the tasks of the
// last 24 hours (/api2/json/nodes/localhost/tasks) with an API token
// (Configuration → Access Control → API Token; give the token the Audit role on /).
const L = (de, en) => ({ de, en });

const DAY = 86400;
const TYPES = { backup: "Backup", reader: "Restore", verify: "Verify", verificationjob: "Verify job", garbage_collection: "Garbage collection", prune: "Prune", prunejob: "Prune job", syncjob: "Sync", "tape-backup": "Tape backup" };

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

function ago(sec) {
	if (!(sec >= 0)) return null;
	if (sec >= 86400) return `${Math.floor(sec / 86400)} d`;
	if (sec >= 3600) return `${Math.floor(sec / 3600)} h`;
	return `${Math.max(1, Math.floor(sec / 60))} min`;
}

function size(bytes) {
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let v = Number(bytes);
	if (!(v >= 0)) return null;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

module.exports = {
	kind: "proxmoxbackup",
	label: "Proxmox Backup Server",
	match: /proxmox-?backup|\bpbs\b/,
	ttl: 60000,
	fields: [
		{
			key: "tokenId",
			label: L("Token-ID", "Token ID"),
			help: L(
				"Konfiguration → Zugriffskontrolle → API-Token, z. B. root@pam!homebento; unter Berechtigungen dem Token die Rolle Audit auf / geben. PBS läuft meist auf https://…:8007 mit eigenem Zertifikat – dann «Eigenes Zertifikat erlauben» einschalten.",
				"Configuration → Access Control → API Token, e.g. root@pam!homebento; under Permissions give the token the Audit role on /. PBS usually runs on https://…:8007 with a self-signed certificate – then turn on “Allow own certificate”."
			)
		},
		{ key: "tokenSecret", label: L("Token-Geheimnis", "Token secret"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.tokenId || !secrets.tokenSecret) throw new Error("API token missing");
		if (!/^[^@!\s]+@[^@!\s]+![^@!\s]+$/.test(secrets.tokenId)) throw new Error("Token ID must look like user@realm!name");
		const headers = { Authorization: `PBSAPIToken=${secrets.tokenId}:${secrets.tokenSecret}` };
		const now = Math.floor(Date.now() / 1000);
		const [usage, tasks] = await Promise.all([json(`${url}/api2/json/status/datastore-usage`, { headers }), json(`${url}/api2/json/nodes/localhost/tasks?since=${now - DAY}&limit=1000`, { headers })]);
		if (!usage || !Array.isArray(usage.data) || !tasks || !Array.isArray(tasks.data)) throw new Error("Unexpected answer from Proxmox Backup Server");

		const stores = usage.data.map((d) => ({ name: d.store, used: pct(Number(d.used), Number(d.total)), free: size(d.avail), error: d.error || null }));
		if (!stores.length) throw new Error("The token sees no datastores (give it the Audit role on /)");
		const done = tasks.data.filter((t) => t.endtime && t.status);
		const failed = done.filter((t) => t.status !== "OK" && !/^WARNINGS/i.test(t.status));
		const warned = done.filter((t) => /^WARNINGS/i.test(t.status));
		const backups = done.filter((t) => t.worker_type === "backup");
		const okBackups = backups.filter((t) => t.status === "OK" || /^WARNINGS/i.test(t.status));
		const last = okBackups.reduce((m, t) => Math.max(m, Number(t.endtime) || 0), 0);
		const fullest = stores.reduce((m, s) => (s.used !== null && (m === null || s.used > m) ? s.used : m), null);
		const task = (t) => `${TYPES[t.worker_type] || t.worker_type}${t.worker_id ? ` ${t.worker_id}` : ""}`;

		return {
			metrics: [
				{ value: fullest !== null ? `${fullest} %` : null, label: L("Datastore belegt", "Datastore used"), warn: fullest >= 90 || stores.some((s) => s.error) },
				{ value: `${okBackups.length}/${backups.length}`, label: L("Backups OK (24 h)", "Backups OK (24 h)"), warn: okBackups.length < backups.length },
				{ value: failed.length, label: L("Fehler (24 h)", "Failed (24 h)"), warn: failed.length > 0 },
				{ value: last ? L(`vor ${ago(now - last)}`, `${ago(now - last)} ago`) : null, label: L("Letztes Backup", "Last backup") }
			].filter((m) => m.value !== null),
			items: [
				...failed.sort((a, b) => b.starttime - a.starttime).map((t) => ({ title: task(t), sub: String(t.status).slice(0, 120), status: "bad" })),
				...stores.map((s) => ({ title: s.name, sub: s.error ? String(s.error).slice(0, 120) : [s.used !== null ? `${s.used} %` : "", s.free ? `${s.free} free` : ""].filter(Boolean).join(" · "), status: s.error ? "bad" : s.used >= 90 ? "warn" : "ok" })),
				...warned.sort((a, b) => b.starttime - a.starttime).map((t) => ({ title: task(t), sub: String(t.status).slice(0, 120), status: "warn" }))
			],
			warnings: [...stores.filter((s) => s.error).map((s) => `Datastore ${s.name}: ${String(s.error).slice(0, 120)}`), ...stores.filter((s) => !s.error && s.used >= 90).map((s) => `Datastore ${s.name} is ${s.used} % full`), ...failed.slice(0, 5).map((t) => `${task(t)} failed`)],
			summary: failed.length ? `${failed.length} failed task${failed.length === 1 ? "" : "s"} in 24 h` : null
		};
	}
};
