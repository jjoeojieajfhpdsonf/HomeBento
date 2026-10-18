"use strict";
// What's Up Docker (WUD): watched containers and which have a newer image, from /api/containers.
// No login by default; basic auth when WUD_AUTH_BASIC_* is set.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "whatsupdocker",
	label: "What's Up Docker",
	match: /what.?s.?up.?docker|\bwud\b/,
	repo: "getwud/wud",
	ttl: 5 * 60000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur nötig, wenn WUD_AUTH_BASIC_… gesetzt ist", "Only if WUD_AUTH_BASIC_… is set") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const login = secrets.username || secrets.password;
		const headers = login ? { Authorization: `Basic ${Buffer.from(`${secrets.username || ""}:${secrets.password || ""}`).toString("base64")}` } : {};
		let r;
		try {
			r = await json(`${url}/api/containers`, { headers });
		} catch (err) {
			if (!login && /Access denied/.test(err.message)) throw new Error("Login missing");
			throw err;
		}
		if (!Array.isArray(r)) throw new Error("Unexpected answer from What's Up Docker");
		const all = r.map((c) => {
			const image = c.image || {};
			const tag = (image.tag && image.tag.value) || "";
			const kind = c.updateKind || {};
			const from = kind.localValue || tag;
			const to = kind.remoteValue || (c.result && c.result.tag) || "";
			return {
				name: c.displayName || c.name || c.id || "?",
				update: Boolean(c.updateAvailable),
				error: c.error && c.error.message ? String(c.error.message) : null,
				sub: c.updateAvailable && to && from !== to && kind.kind !== "digest" ? `${from} → ${to}` : c.updateAvailable ? "new image" : [image.name, tag].filter(Boolean).join(":")
			};
		});
		const updates = all.filter((c) => c.update);
		const errors = all.filter((c) => c.error);
		const rank = (c) => (c.error ? 0 : c.update ? 1 : 2);
		return {
			metrics: [
				{ value: all.length, label: L("Container", "Containers") },
				{ value: updates.length, label: L("Updates", "Updates") },
				...(errors.length ? [{ value: errors.length, label: L("Fehler", "errors"), warn: true }] : [])
			],
			items: all
				.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
				.map((c) => ({ title: c.name, sub: c.error ? c.error.slice(0, 120) : c.sub, status: c.error ? "bad" : c.update ? "warn" : "ok" })),
			summary: updates.length ? `${updates.length} update${updates.length === 1 ? "" : "s"} available` : null
		};
	}
};
