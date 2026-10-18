"use strict";
// Vaultwarden: alive check and version, both without a login.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "vaultwarden",
	label: "Vaultwarden",
	match: /vaultwarden|bitwarden.?rs/,
	repo: "dani-garcia/vaultwarden",
	ttl: 60000,
	fields: [],
	async fetch({ url, request, json }) {
		const alive = await request(`${url}/alive`, { headers: { Accept: "application/json" } });
		if (!alive.status) throw new Error(alive.error);
		if (alive.status !== 200) throw new Error(`Not alive (HTTP ${alive.status})`);
		let version = null;
		try {
			version = await json(`${url}/api/version`);
		} catch {
			version = (await json(`${url}/api/config`).catch(() => ({}))).version || null;
		}
		return {
			metrics: [
				{ value: "up", label: "Status" },
				{ value: `${alive.ms} ms`, label: L("Antwort", "Response") },
				{ value: typeof version === "string" ? version : "–", label: "Version" }
			]
		};
	}
};
