"use strict";
// Stash: scenes, images, performers and their size from the GraphQL API (POST /graphql, query
// "stats"). API key: Stash → Settings → Security → API Key (sent as the ApiKey header); not needed
// when Stash has no login.
const L = (de, en) => ({ de, en });

const QUERY = "{ stats { scene_count scenes_size scenes_duration image_count images_size gallery_count performer_count studio_count tag_count } }";

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	b = Number(b) || 0;
	while (b >= 1000 && i < u.length - 1) (b /= 1000), i++;
	return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

// seconds -> "12 h" / "3 d"
function hours(sec) {
	const h = (Number(sec) || 0) / 3600;
	return h >= 48 ? `${Math.round(h / 24)} d` : `${Math.round(h)} h`;
}

module.exports = {
	kind: "stash",
	label: "Stash",
	match: /stashapp|(?:^|[\s/])stash(?=$|[\s:])/,
	repo: "stashapp/stash",
	ttl: 300000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Stash → Einstellungen → Sicherheit → API-Schlüssel (leer lassen ohne Anmeldung)", "Stash → Settings → Security → API Key (leave empty without a login)"), secret: true }],
	async fetch({ url, secrets, json }) {
		let r;
		try {
			r = await json(`${url}/graphql`, { method: "POST", body: { query: QUERY }, headers: secrets.apiKey ? { ApiKey: secrets.apiKey } : {} });
		} catch (err) {
			if (!secrets.apiKey && /Access denied/.test(err.message)) throw new Error("API key missing");
			throw err;
		}
		if (r && Array.isArray(r.errors) && r.errors.length) throw new Error(`Stash: ${r.errors[0].message || "query failed"}`);
		const s = r && r.data && r.data.stats;
		if (!s) throw new Error("Unexpected answer from Stash");
		const n = (k) => Number(s[k]) || 0;
		return {
			metrics: [
				{ value: n("scene_count"), label: L("Szenen", "Scenes") },
				{ value: n("image_count"), label: L("Bilder", "Images") },
				{ value: n("performer_count"), label: L("Darsteller", "Performers") },
				{ value: fmtBytes(n("scenes_size") + n("images_size")), label: L("Grösse", "Size") }
			],
			summary: [s.scenes_duration ? `${hours(s.scenes_duration)} of video` : "", `${n("gallery_count")} galleries`, `${n("studio_count")} studios`, `${n("tag_count")} tags`].filter(Boolean).join(" · ")
		};
	}
};
