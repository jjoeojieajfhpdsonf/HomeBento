"use strict";
// Karakeep (formerly Hoarder): bookmarks, favourites, lists and tags from /api/v1/users/me/stats.
// Needs an API key (Karakeep → User settings → API Keys).
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "karakeep",
	label: "Karakeep",
	match: /^(?!.*(meili|chrome|browser|redis)).*(karakeep|hoarder)/,
	repo: "karakeep-app/karakeep",
	ttl: 300000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Karakeep → Benutzereinstellungen → API-Schlüssel", "Karakeep → User settings → API Keys"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		let s;
		try {
			s = await json(`${url}/api/v1/users/me/stats`, { headers: { Authorization: `Bearer ${secrets.apiKey}` } });
		} catch (err) {
			if (err.message === "HTTP 404") throw new Error("This Karakeep version has no statistics API, please update it");
			throw err;
		}
		if (!s || typeof s.numBookmarks !== "number") throw new Error("Unexpected answer from Karakeep");
		return {
			metrics: [
				{ value: s.numBookmarks, label: L("Lesezeichen", "Bookmarks") },
				{ value: s.numFavorites ?? null, label: L("Favoriten", "Favourites") },
				{ value: s.numLists ?? null, label: L("Listen", "Lists") },
				{ value: s.numTags ?? null, label: "Tags" }
			],
			summary: typeof s.numArchived === "number" ? `${s.numArchived} archived` : null
		};
	}
};
