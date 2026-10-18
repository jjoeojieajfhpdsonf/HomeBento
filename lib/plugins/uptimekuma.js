"use strict";
// Uptime Kuma: monitors and their state from /metrics (Prometheus format), which needs an API key
// (Uptime Kuma → Settings → API Keys). The key is sent as the password of basic auth.
const L = (de, en) => ({ de, en });

function parseMetrics(text) {
	const out = [];
	for (const line of text.split("\n")) {
		const m = /^(\w+)\{([^}]*)\}\s+([\d.eE+-]+|NaN)/.exec(line);
		if (!m) continue;
		const labels = Object.fromEntries([...m[2].matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((x) => [x[1], x[2]]));
		out.push({ name: m[1], labels, value: Number(m[3]) });
	}
	return out;
}

module.exports = {
	kind: "uptimekuma",
	label: "Uptime Kuma",
	match: /uptime.?kuma/,
	repo: "louislam/uptime-kuma",
	ttl: 30000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Uptime Kuma → Einstellungen → API-Schlüssel", "Uptime Kuma → Settings → API Keys"), secret: true }],
	parseMetrics,
	async fetch({ url, secrets, request }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const r = await request(`${url}/metrics`, { headers: { Authorization: `Basic ${Buffer.from(`:${secrets.apiKey}`).toString("base64")}` }, timeout: 10000 });
		if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the API key)");
		if (r.status !== 200) throw new Error(r.error || `HTTP ${r.status}`);
		const rows = parseMetrics(r.body.toString("utf8"));
		const monitors = rows.filter((x) => x.name === "monitor_status").map((x) => {
			const rt = rows.find((y) => y.name === "monitor_response_time" && y.labels.monitor_name === x.labels.monitor_name);
			// 1 up, 0 down, 2 pending, 3 maintenance
			return { name: x.labels.monitor_name, status: x.value, ms: rt && rt.value > 0 ? Math.round(rt.value) : null };
		});
		const down = monitors.filter((m) => m.status === 0);
		return {
			metrics: [
				{ value: monitors.length, label: L("Monitore", "Monitors") },
				{ value: down.length, label: L("ausgefallen", "down"), warn: down.length > 0 },
				{ value: monitors.filter((m) => m.status === 3).length, label: L("Wartung", "Maintenance") }
			],
			items: monitors.sort((a, b) => (a.status === 0 ? -1 : 0) - (b.status === 0 ? -1 : 0) || a.name.localeCompare(b.name)).map((m) => ({ title: m.name, sub: m.ms !== null ? `${m.ms} ms` : "", status: m.status === 1 ? "ok" : m.status === 0 ? "bad" : "warn" })),
			warnings: down.map((m) => `${m.name} is down`),
			summary: down.length ? `${down.map((m) => m.name).join(", ")} down` : null
		};
	}
};
