"use strict";
// Linkwarden: links, collections and tags. The number of links is the sum over all collections.
// Needs an access token (Linkwarden → Settings → Access Tokens).
const L = (de, en) => ({ de, en });

// Linkwarden wraps lists as { response: [...] } (newer versions: { data: { tags: [...] } } for tags)
const unwrap = (r, key) => (Array.isArray(r) ? r : r && Array.isArray(r.response) ? r.response : r && r.data && Array.isArray(r.data[key]) ? r.data[key] : null);

module.exports = {
	kind: "linkwarden",
	label: "Linkwarden",
	match: /^(?!.*(postgres|meili|[-_ ]db\b)).*linkwarden/,
	repo: "linkwarden/linkwarden",
	ttl: 300000,
	fields: [{ key: "token", label: L("Zugriffstoken", "Access token"), help: L("Linkwarden → Einstellungen → Zugriffstokens", "Linkwarden → Settings → Access Tokens"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Access token missing");
		const headers = { Authorization: `Bearer ${secrets.token}` };
		const [c, t] = await Promise.all([json(`${url}/api/v1/collections`, { headers }), json(`${url}/api/v1/tags`, { headers })]);
		const collections = unwrap(c, "collections");
		const tags = unwrap(t, "tags");
		if (!collections) throw new Error("Unexpected answer from Linkwarden");
		const count = (x) => (x._count && x._count.links) || 0;
		return {
			metrics: [
				{ value: collections.reduce((a, x) => a + count(x), 0), label: "Links" },
				{ value: collections.length, label: L("Sammlungen", "Collections") },
				{ value: tags ? tags.length : null, label: "Tags" }
			],
			items: collections
				.map((x) => ({ name: x.name || String(x.id), links: count(x) }))
				.sort((a, b) => b.links - a.links || a.name.localeCompare(b.name))
				.map((x) => ({ title: x.name, sub: `${x.links} links`, status: "ok" }))
		};
	}
};
