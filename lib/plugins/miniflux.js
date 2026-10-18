"use strict";
// Miniflux: unread entries (/v1/feeds/counters) and feeds, feeds that fail to update become warnings.
// Needs an API key (Miniflux → Settings → API Keys), sent as X-Auth-Token.
const L = (de, en) => ({ de, en });

const sum = (o) => Object.values(o || {}).reduce((a, n) => a + (Number(n) || 0), 0);

module.exports = {
	kind: "miniflux",
	label: "Miniflux",
	match: /^(?!.*(postgres|[-_ ]db\b)).*miniflux/,
	repo: "miniflux/v2",
	ttl: 120000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Miniflux → Einstellungen → API-Schlüssel", "Miniflux → Settings → API Keys"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { "X-Auth-Token": secrets.apiKey };
		const [counters, feeds] = await Promise.all([json(`${url}/v1/feeds/counters`, { headers }), json(`${url}/v1/feeds`, { headers })]);
		if (!counters || typeof counters.unreads !== "object" || !Array.isArray(feeds)) throw new Error("Unexpected answer from Miniflux");
		const unreads = counters.unreads || {};
		const list = feeds.map((f) => ({
			title: f.title || f.site_url || String(f.id),
			unread: Number(unreads[f.id]) || 0,
			error: !f.disabled && f.parsing_error_count > 0 ? f.parsing_error_message || `${f.parsing_error_count} errors` : null,
			disabled: !!f.disabled
		}));
		const failing = list.filter((f) => f.error);
		return {
			metrics: [
				{ value: sum(unreads), label: L("ungelesen", "unread") },
				{ value: list.filter((f) => !f.disabled).length, label: "Feeds" },
				{ value: failing.length, label: L("fehlerhaft", "failing"), warn: failing.length > 0 }
			],
			items: list
				.filter((f) => f.error || f.unread > 0)
				.sort((a, b) => !!b.error - !!a.error || b.unread - a.unread || a.title.localeCompare(b.title))
				.map((f) => ({ title: f.title, sub: f.error || `${f.unread} unread`, status: f.error ? "bad" : "ok" })),
			warnings: failing.map((f) => `Feed ${f.title}: ${f.error}`),
			summary: failing.length ? `${failing.length} feed${failing.length > 1 ? "s" : ""} failing` : null
		};
	}
};
