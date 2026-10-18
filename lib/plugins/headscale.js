"use strict";
// Headscale: nodes (online / total) and users from /api/v1/node and /api/v1/user with an API key
// as bearer token. Versions before 0.23 call nodes "machines" (/api/v1/machine).
const L = (de, en) => ({ de, en });

// "0001-01-01T00:00:00Z" and null mean "never expires"
const expired = (n) => {
	const t = n.expiry ? Date.parse(n.expiry) : NaN;
	return Number.isFinite(t) && t > 0 && t < Date.now();
};

function ago(iso) {
	const t = Date.parse(iso);
	if (!Number.isFinite(t) || t <= 0) return "";
	const min = Math.max(0, Math.round((Date.now() - t) / 60000));
	if (min < 60) return `${min} min ago`;
	if (min < 2880) return `${Math.round(min / 60)} h ago`;
	return `${Math.round(min / 1440)} d ago`;
}

module.exports = {
	kind: "headscale",
	label: "Headscale",
	match: /^(?!.*[-_/](ui|admin|webui|postgres|db)\b).*headscale/,
	repo: "juanfont/headscale",
	ttl: 30000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("headscale apikeys create --expiration 999d", "headscale apikeys create --expiration 999d"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { Authorization: `Bearer ${secrets.apiKey}` };
		let nodes;
		try {
			const r = await json(`${url}/api/v1/node`, { headers });
			nodes = r && r.nodes;
		} catch (err) {
			if (!/HTTP 404/.test(err.message)) throw err;
			const r = await json(`${url}/api/v1/machine`, { headers });
			nodes = r && r.machines;
		}
		if (!Array.isArray(nodes)) throw new Error("Unexpected answer from Headscale");
		const users = await json(`${url}/api/v1/user`, { headers }).then((r) => (r && Array.isArray(r.users) ? r.users : null), () => null);
		const online = nodes.filter((n) => n.online);
		const old = nodes.filter(expired);
		return {
			metrics: [
				{ value: `${online.length}/${nodes.length}`, label: L("Nodes online", "Nodes online") },
				{ value: users ? users.length : null, label: L("Benutzer", "Users") },
				{ value: old.length, label: L("abgelaufen", "expired"), warn: old.length > 0 }
			],
			items: nodes
				.map((n) => ({ n, name: n.givenName || n.name || String(n.id) }))
				.sort((a, b) => !!b.n.online - !!a.n.online || a.name.localeCompare(b.name))
				.map(({ n, name }) => ({
					title: name,
					sub: [n.user && (n.user.displayName || n.user.name), Array.isArray(n.ipAddresses) ? n.ipAddresses.find((ip) => !ip.includes(":")) || n.ipAddresses[0] : "", expired(n) ? "key expired" : n.online ? "" : ago(n.lastSeen)].filter(Boolean).join(" · "),
					status: expired(n) ? "bad" : n.online ? "ok" : "warn"
				})),
			warnings: old.map((n) => `Headscale node ${n.givenName || n.name} has an expired key`)
		};
	}
};
