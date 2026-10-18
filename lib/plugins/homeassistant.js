"use strict";
// Home Assistant: entities from the REST API with a long-lived access token
// (Profile → Security → Long-lived access tokens). Optionally a list of entities to show.
const L = (de, en) => ({ de, en });

const BAD = new Set(["unavailable", "unknown"]);

function nameOf(e) {
	return (e.attributes && e.attributes.friendly_name) || e.entity_id;
}

function valueOf(e) {
	const unit = e.attributes && e.attributes.unit_of_measurement;
	return unit ? `${e.state} ${unit}` : e.state;
}

function statusOf(e) {
	if (e.state === "unavailable") return "bad";
	if (e.state === "unknown") return "warn";
	return "ok";
}

module.exports = {
	kind: "homeassistant",
	label: "Home Assistant",
	match: /home.?assistant|\bhass\b/,
	repo: "home-assistant/core",
	ttl: 15000,
	fields: [
		{ key: "token", label: L("Zugriffstoken", "Access token"), help: L("Profil → Sicherheit → Langlebige Zugriffstoken", "Profile → Security → Long-lived access tokens"), secret: true },
		{ key: "entities", label: L("Entitäten", "Entities"), help: L("Optional, durch Komma getrennt, z. B. sensor.wohnzimmer_temperatur, light.kueche", "Optional, comma separated, e.g. sensor.living_room_temperature, light.kitchen") }
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Token missing");
		const headers = { Authorization: `Bearer ${secrets.token}` };
		await json(`${url}/api/`, { headers });
		const [config, states] = await Promise.all([json(`${url}/api/config`, { headers }), json(`${url}/api/states`, { headers })]);
		if (!Array.isArray(states)) throw new Error("Unexpected answer from Home Assistant");
		const wanted = String(secrets.entities || "")
			.split(",")
			.map((x) => x.trim())
			.filter(Boolean);
		const byId = new Map(states.map((e) => [e.entity_id, e]));
		const lightsOn = states.filter((e) => e.entity_id.startsWith("light.") && e.state === "on").length;
		const metrics = [
			{ value: states.length, label: L("Entitäten", "Entities") },
			{ value: lightsOn, label: L("Lichter an", "Lights on") }
		];
		const warnings = [];
		let items;
		if (wanted.length) {
			const chosen = wanted.map((id) => byId.get(id) || { entity_id: id, state: "unavailable", missing: true });
			for (const e of chosen.slice(0, 2)) metrics.push({ value: e.missing ? "–" : valueOf(e), label: nameOf(e), warn: BAD.has(e.state) });
			items = chosen.map((e) => ({ title: nameOf(e), sub: e.missing ? "not found" : valueOf(e), status: e.missing ? "bad" : statusOf(e) }));
			for (const e of chosen) {
				if (e.missing) warnings.push(`${e.entity_id} not found`);
				else if (e.state === "unavailable") warnings.push(`${nameOf(e)} is unavailable`);
			}
		} else {
			items = states
				.filter((e) => /^(light|switch)\./.test(e.entity_id) && e.state === "on")
				.sort((a, b) => nameOf(a).localeCompare(nameOf(b)))
				.map((e) => ({ title: nameOf(e), sub: e.state, status: "ok" }));
		}
		return {
			metrics,
			items,
			warnings,
			summary: [config.location_name, config.version].filter(Boolean).join(" · ") || null
		};
	}
};
