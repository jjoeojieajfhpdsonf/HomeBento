"use strict";
// authentik: users, logins and failed logins of the last 24 hours and the version, through
// /api/v3/ with an API token (bearer). Events from /events/events/volume/ (2024.x and newer),
// older versions /events/events/per_month/. The version check (/admin/version/) needs an
// admin token; without it the version is left out.
const L = (de, en) => ({ de, en });
const DAY = 86400000;

async function logins(url, json, headers) {
	try {
		const r = await json(`${url}/api/v3/events/events/volume/?actions=login&actions=login_failed&history_days=1`, { headers });
		if (!Array.isArray(r)) throw new Error("Unexpected answer from authentik");
		const sum = (action) => r.filter((x) => x && x.action === action).reduce((n, x) => n + (Number(x.count) || 0), 0);
		return { ok: sum("login"), failed: sum("login_failed") };
	} catch (err) {
		if (!/HTTP (400|404|405)/.test(err.message)) throw err;
	}
	// before the volume endpoint: per_month gives points { x_cord: ms, y_cord: count }
	const since = Date.now() - DAY;
	const count = async (action) => {
		const r = await json(`${url}/api/v3/events/events/per_month/?action=${action}`, { headers });
		return (Array.isArray(r) ? r : []).reduce((n, p) => (Number(p.x_cord) >= since ? n + (Number(p.y_cord) || 0) : n), 0);
	};
	const [ok, failed] = await Promise.all([count("login"), count("login_failed")]);
	return { ok, failed };
}

module.exports = {
	kind: "authentik",
	label: "authentik",
	match: /^(?!.*(outpost|ldap|radius|proxy|worker|postgres|redis|[-_]db\b)).*authentik/,
	repo: "goauthentik/authentik",
	ttl: 60000,
	fields: [
		{
			key: "token",
			label: L("API-Token", "API token"),
			help: L("Admin-Oberfläche → Verzeichnis → Tokens und App-Passwörter → Erstellen (Zweck: API-Token). Für die Versionsprüfung braucht der Benutzer Admin-Rechte.", "Admin interface → Directory → Tokens and App passwords → Create (intent: API token). The version check needs a user with admin rights."),
			secret: true
		}
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("API token missing");
		const headers = { Authorization: `Bearer ${secrets.token}` };
		const [users, events, version] = await Promise.all([
			json(`${url}/api/v3/core/users/?page_size=1&is_active=true`, { headers }),
			logins(url, json, headers),
			json(`${url}/api/v3/admin/version/`, { headers }).catch(() => null)
		]);
		if (!users || !users.pagination) throw new Error("Unexpected answer from authentik");
		const outdated = !!(version && version.outdated && version.version_latest_valid !== false);
		const warnings = [];
		if (outdated) warnings.push(`authentik ${version.version_current} is outdated (latest ${version.version_latest})`);
		// many failed logins next to few successful ones look like someone guessing passwords
		if (events.failed >= 20 && events.failed > events.ok * 2) warnings.push(`${events.failed} failed authentik logins in 24 h`);
		return {
			metrics: [
				{ value: Number(users.pagination.count) || 0, label: L("Benutzer", "Users") },
				{ value: events.ok, label: L("Logins 24 h", "Logins 24 h") },
				{ value: events.failed, label: L("fehlgeschlagen", "failed"), warn: events.failed >= 20 && events.failed > events.ok * 2 },
				{ value: version ? version.version_current : null, label: "Version", warn: outdated }
			],
			warnings,
			summary: outdated ? `Update to ${version.version_latest} available` : null
		};
	}
};
