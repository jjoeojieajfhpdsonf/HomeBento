"use strict";
// Transmission: speeds and torrents over the RPC interface (/transmission/rpc). The first call is
// answered with 409 and a session id, which every further call has to send along.
const L = (de, en) => ({ de, en });

const speed = (bps) => (bps >= 1e6 || !bps ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);
const sessions = new Map(); // rpc address -> X-Transmission-Session-Id
// 0 stopped, 1 check wait, 2 checking, 3 download wait, 4 downloading, 5 seed wait, 6 seeding
const STATE = ["stopped", "queued (check)", "checking", "queued", "downloading", "queued (seed)", "seeding"];

async function rpc(request, rpcUrl, auth, method, args) {
	const body = JSON.stringify(args ? { method, arguments: args } : { method });
	for (let attempt = 0; attempt < 2; attempt++) {
		const headers = { "Content-Type": "application/json", Accept: "application/json", ...auth };
		if (sessions.has(rpcUrl)) headers["X-Transmission-Session-Id"] = sessions.get(rpcUrl);
		const r = await request(rpcUrl, { method: "POST", headers, body });
		if (!r.status) throw new Error(r.error);
		if (r.status === 409 && r.headers["x-transmission-session-id"]) {
			sessions.set(rpcUrl, r.headers["x-transmission-session-id"]);
			continue;
		}
		if (r.status === 401 || r.status === 403) throw new Error("Access denied (check user and password)");
		if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
		let x;
		try {
			x = JSON.parse(r.body.toString("utf8"));
		} catch {
			throw new Error("Unexpected answer (not JSON)");
		}
		if (x.result !== "success") throw new Error(`Transmission: ${x.result || "error"}`);
		return x.arguments || {};
	}
	throw new Error("Transmission keeps asking for a new session id");
}

module.exports = {
	kind: "transmission",
	label: "Transmission",
	match: /transmission/,
	repo: "transmission/transmission",
	ttl: 5000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur wenn die Fernsteuerung ein Passwort hat", "Only if remote access has a password") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, request }) {
		const auth = secrets.username ? { Authorization: `Basic ${Buffer.from(`${secrets.username}:${secrets.password || ""}`).toString("base64")}` } : {};
		const rpcUrl = /\/rpc$/.test(url) ? url : `${url}/transmission/rpc`;
		const stats = await rpc(request, rpcUrl, auth, "session-stats");
		const t = await rpc(request, rpcUrl, auth, "torrent-get", { fields: ["name", "percentDone", "rateDownload", "status", "error", "errorString"] });
		const torrents = t.torrents || [];
		const broken = torrents.filter((x) => x.error);
		const shown = torrents.filter((x) => x.status === 4 || x.status === 3 || x.error || x.percentDone < 1).sort((a, b) => (b.rateDownload || 0) - (a.rateDownload || 0));
		return {
			metrics: [
				{ value: speed(stats.downloadSpeed || 0), label: "↓ Download" },
				{ value: speed(stats.uploadSpeed || 0), label: "↑ Upload" },
				{ value: stats.activeTorrentCount ?? 0, label: L("aktiv", "Active") },
				{ value: stats.torrentCount ?? torrents.length, label: L("gesamt", "Total") }
			],
			items: shown.slice(0, 20).map((x) => ({ title: x.name, sub: [`${Math.round((x.percentDone || 0) * 100)} %`, x.rateDownload ? speed(x.rateDownload) : "", x.error ? x.errorString : STATE[x.status] || ""].filter(Boolean).join(" · "), status: x.error ? "bad" : x.status === 0 ? "warn" : "ok" })),
			warnings: broken.map((x) => `${x.name}: ${x.errorString || "error"}`)
		};
	}
};
