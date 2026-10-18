"use strict";
// ntfy: whether the server is healthy (/v1/health) and how many messages it has sent (/v1/stats).
// Both are public. An access token (ntfy → Account → Access tokens) is optional; when set, it is
// checked against /v1/account and the user is shown.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "ntfy",
	label: "ntfy",
	match: /^(?!.*(alertmanager|bridge|gotify|relay)).*\bntfy/,
	repo: "binwiederhier/ntfy",
	ttl: 60000,
	fields: [{ key: "token", label: L("Zugriffs-Token", "Access token"), help: L("Optional: ntfy → Konto → Zugriffs-Tokens (tk_…)", "Optional: ntfy → Account → Access tokens (tk_…)"), secret: true }],
	async fetch({ url, secrets, request, json }) {
		const headers = secrets.token ? { Authorization: `Bearer ${secrets.token}` } : {};
		// /v1/health answers 503 with { healthy: false } when the server is not healthy
		const h = await request(`${url}/v1/health`, { headers: { Accept: "application/json", ...headers }, timeout: 10000 });
		if (!h.status) throw new Error(h.error);
		if (h.status === 401 || h.status === 403) throw new Error(secrets.token ? "Access denied (check the access token)" : "Access token missing");
		let health = null;
		try {
			health = JSON.parse(h.body.toString("utf8"));
		} catch {
			// handled below
		}
		if (!health || typeof health.healthy !== "boolean") throw new Error(h.status === 404 ? "No ntfy health endpoint (ntfy too old?)" : "Unexpected answer from ntfy");
		const [stats, account] = await Promise.all([json(`${url}/v1/stats`, { headers }).catch(() => null), secrets.token ? json(`${url}/v1/account`, { headers }) : null]);
		const ok = health.healthy;
		const rate = stats && typeof stats.messages_rate === "number" ? stats.messages_rate : null;
		return {
			metrics: [
				{ value: ok ? "OK" : L("Gestört", "Unhealthy"), label: L("Zustand", "Health"), warn: !ok },
				{ value: stats && typeof stats.messages === "number" ? stats.messages : null, label: L("Nachrichten", "Messages") },
				{ value: rate !== null ? `${rate < 10 ? rate.toFixed(2) : Math.round(rate)}/s` : null, label: L("Rate", "Rate") }
			],
			warnings: ok ? [] : ["ntfy reports itself as unhealthy"],
			summary: account && account.username && account.username !== "*" ? account.username : null
		};
	}
};
