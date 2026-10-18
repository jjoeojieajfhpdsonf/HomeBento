"use strict";
// Bazarr: missing subtitles of episodes and movies, throttled providers and health issues (/api/badges).
// API key: Settings → General → Security → API Key.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "bazarr",
	label: "Bazarr",
	match: /bazarr/,
	repo: "morpheus65535/bazarr",
	ttl: 5 * 60000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Einstellungen → Allgemein → Sicherheit → API-Schlüssel", "Settings → General → Security → API Key"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const h = { headers: { "X-API-KEY": secrets.apiKey } };
		const [b, status] = await Promise.all([json(`${url}/api/badges`, h), json(`${url}/api/system/status`, h).catch(() => null)]);
		const providers = Number(b.providers) || 0;
		// "status" in current versions, "health" in some older ones
		const health = Number(b.status ?? b.health) || 0;
		const warnings = [];
		if (providers) warnings.push(`${providers} subtitle provider(s) throttled`);
		if (health) warnings.push(`${health} health issue(s)`);
		const version = status && status.data && status.data.bazarr_version;
		return {
			metrics: [
				{ value: Number(b.episodes) || 0, label: L("Episoden ohne Untertitel", "Episodes missing subs") },
				{ value: Number(b.movies) || 0, label: L("Filme ohne Untertitel", "Movies missing subs") },
				{ value: providers, label: L("Anbieter gedrosselt", "Providers throttled"), warn: providers > 0 },
				{ value: health, label: L("Probleme", "Health issues"), warn: health > 0 }
			],
			warnings,
			summary: version ? `v${String(version).replace(/^v/, "")}` : null
		};
	}
};
