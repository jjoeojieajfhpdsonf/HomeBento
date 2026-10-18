"use strict";
// Grafana: health and version from /api/health (no login); dashboards and firing alerts with a
// service account token (Administration → Service accounts → Add token, role Viewer is enough).
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "grafana",
	label: "Grafana",
	match: /^(?!.*(loki|promtail|alloy|agent|tempo|mimir|pyroscope|oncall|renderer|k6|beyla)).*grafana/,
	repo: "grafana/grafana",
	ttl: 30000,
	fields: [{ key: "token", label: L("Service-Account-Token", "Service account token"), help: L("Optional: Verwaltung → Service-Accounts → Token hinzufügen", "Optional: Administration → Service accounts → Add token"), secret: true }],
	async fetch({ url, secrets, request, json }) {
		// /api/health answers 503 with { database: "failing" } when the database is down
		const h = await request(`${url}/api/health`, { headers: { Accept: "application/json" } });
		if (!h.status) throw new Error(h.error);
		let health;
		try {
			health = JSON.parse(h.body.toString("utf8"));
		} catch {
			throw new Error(h.status === 200 ? "Unexpected answer (not JSON)" : `HTTP ${h.status}`);
		}
		const dbOk = health.database === "ok";
		const warnings = dbOk ? [] : [`Grafana database: ${health.database || "unknown"}`];
		const metrics = [];
		let items;
		if (secrets.token) {
			const headers = { Authorization: `Bearer ${secrets.token}` };
			const [dashboards, alerts] = await Promise.all([
				json(`${url}/api/search?type=dash-db&limit=5000`, { headers }),
				json(`${url}/api/alertmanager/grafana/api/v2/alerts?active=true&silenced=false&inhibited=false`, { headers })
			]);
			const firing = (Array.isArray(alerts) ? alerts : []).filter((a) => !a.status || a.status.state === "active");
			const name = (a) => (a.labels && a.labels.alertname) || "Alert";
			const detail = (a) => (a.annotations && (a.annotations.summary || a.annotations.description)) || "";
			metrics.push({ value: Array.isArray(dashboards) ? dashboards.length : 0, label: "Dashboards" });
			metrics.push({ value: firing.length, label: L("Alarme aktiv", "Firing alerts"), warn: firing.length > 0 });
			items = firing.map((a) => ({ title: name(a), sub: detail(a), status: "bad" }));
			for (const a of firing) warnings.push(`${name(a)} is firing${detail(a) ? `: ${detail(a)}` : ""}`);
		}
		metrics.push({ value: health.version || "–", label: "Version" });
		metrics.push({ value: dbOk ? "ok" : health.database || "–", label: L("Datenbank", "Database"), warn: !dbOk });
		return { metrics, items, warnings, summary: dbOk ? null : "Database failing" };
	}
};
