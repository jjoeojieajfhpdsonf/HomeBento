"use strict";
// Nextcloud: users, files and free space from the serverinfo app. Login with the serverinfo token
// (occ config:app:set serverinfo token --value …) or an admin user with an app password.
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	b = Number(b) || 0;
	while (b >= 1000 && i < u.length - 1) (b /= 1000), i++;
	return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

module.exports = {
	kind: "nextcloud",
	label: "Nextcloud",
	match: /^(?!.*([-_ ]db\b|redis|valkey|mariadb|mysql|postgres|imaginary|whiteboard)).*nextcloud/,
	repo: "nextcloud/server",
	ttl: 60000,
	fields: [
		{ key: "token", label: L("Serverinfo-Token", "Serverinfo token"), help: L("occ config:app:set serverinfo token --value …  (oder Benutzer + App-Passwort)", "occ config:app:set serverinfo token --value …  (or user + app password)"), secret: true },
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur ohne Token: Admin-Benutzer", "Only without a token: admin user") },
		{ key: "password", label: L("App-Passwort", "App password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const headers = { "OCS-APIRequest": "true" };
		if (secrets.token) headers["NC-Token"] = secrets.token;
		else if (secrets.username && secrets.password) headers.Authorization = `Basic ${Buffer.from(`${secrets.username}:${secrets.password}`).toString("base64")}`;
		else throw new Error("Login missing (serverinfo token or user + app password)");
		const r = await json(`${url}/ocs/v2.php/apps/serverinfo/api/v1/info?format=json&skipApps=false&skipUpdate=false`, { headers });
		const meta = (r.ocs && r.ocs.meta) || {};
		const data = r.ocs && r.ocs.data;
		if (!data || (meta.status && meta.status !== "ok")) throw new Error(meta.message || "Unexpected answer from Nextcloud");
		const nc = data.nextcloud || {};
		const sys = nc.system || {};
		const storage = nc.storage || {};
		const active = data.activeUsers || {};
		const version = sys.version ? String(sys.version).split(".").slice(0, 3).join(".") : "–";
		const update = sys.update && sys.update.available ? sys.update : null;
		const appUpdates = (sys.apps && sys.apps.num_updates_available) || 0;
		const warnings = [];
		if (update) warnings.push(`Nextcloud update available${update.available_version ? `: ${update.available_version}` : ""}`);
		return {
			metrics: [
				{ value: active.last5minutes || 0, label: L("aktiv (5 Min.)", "active (5 min)") },
				{ value: storage.num_files || 0, label: L("Dateien", "Files") },
				{ value: sys.freespace !== undefined && sys.freespace !== null ? fmtBytes(sys.freespace) : "–", label: L("frei", "free") },
				{ value: version, label: "Version", warn: !!update }
			],
			warnings,
			summary: [storage.num_users ? `${storage.num_users} users` : null, appUpdates ? `${appUpdates} app update(s)` : null].filter(Boolean).join(" · ") || null
		};
	}
};
