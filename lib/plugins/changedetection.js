"use strict";
// changedetection.io: watched pages, changes not looked at yet and watches that fail, from
// GET /api/v1/watch with the API key (Settings → API → API access key) in the x-api-key header.
// When API access is set to need no key, the key may stay empty.
const L = (de, en) => ({ de, en });

function host(u) {
	try {
		return new URL(u).host;
	} catch {
		return String(u || "");
	}
}

module.exports = {
	kind: "changedetection",
	label: "changedetection.io",
	match: /^(?!.*(playwright|chrome|browser|sockpuppet|selenium)).*change.?detection/,
	repo: "dgtlmoon/changedetection.io",
	ttl: 60000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("changedetection.io → Settings → API → API-Zugriffsschlüssel", "changedetection.io → Settings → API → API access key"), secret: true }],
	async fetch({ url, secrets, json }) {
		const headers = secrets.apiKey ? { "x-api-key": secrets.apiKey } : {};
		let r;
		try {
			r = await json(`${url}/api/v1/watch`, { headers });
		} catch (err) {
			if (!secrets.apiKey && /Access denied/.test(err.message)) throw new Error("API key missing");
			throw err;
		}
		if (!r || typeof r !== "object" || Array.isArray(r)) throw new Error("Unexpected answer from changedetection.io");
		const watches = Object.entries(r)
			.filter(([, w]) => w && typeof w === "object")
			.map(([uuid, w]) => ({
				uuid,
				name: w.title || w.url || uuid,
				url: w.url || "",
				changed: Number(w.last_changed) > 0 && !w.viewed,
				error: w.last_error ? String(w.last_error) : null
			}));
		const changed = watches.filter((w) => w.changed);
		const failing = watches.filter((w) => w.error);
		const rank = (w) => (w.error ? 0 : w.changed ? 1 : 2);
		return {
			metrics: [
				{ value: watches.length, label: L("Überwacht", "Watched") },
				{ value: changed.length, label: L("geändert", "changed") },
				{ value: failing.length, label: L("Fehler", "errors"), warn: failing.length > 0 }
			],
			items: watches
				.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
				.map((w) => ({ title: w.name, sub: w.error ? w.error.slice(0, 120) : host(w.url), status: w.error ? "bad" : w.changed ? "warn" : "ok" })),
			warnings: failing.map((w) => `${w.name}: ${w.error.slice(0, 120)}`),
			summary: changed.length ? `${changed.length} unviewed change${changed.length === 1 ? "" : "s"}` : null
		};
	}
};
