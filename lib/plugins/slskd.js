"use strict";
// slskd (Soulseek): whether it is connected to the Soulseek server, active and queued downloads and
// uploads and the shared files, from /api/v0/application and /api/v0/transfers/{downloads,uploads}.
// API key: slskd.yml → web.authentication.api_keys (sent as X-API-Key); none is needed when the web
// authentication is off.
const L = (de, en) => ({ de, en });

function speed(bps) {
	const u = ["B/s", "KB/s", "MB/s", "GB/s"];
	let i = 0;
	let v = Number(bps) || 0;
	while (v >= 1000 && i < u.length - 1) (v /= 1000), i++;
	return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

// [{ username, directories: [{ directory, files: [transfer] }] }] -> flat list of transfers
const flatten = (users) => (Array.isArray(users) ? users : []).flatMap((u) => (u.directories || []).flatMap((d) => (d.files || []).map((f) => ({ ...f, username: f.username || u.username }))));
// states are flags as text, e.g. "InProgress", "Queued, Remotely" or "Completed, Succeeded"
const isActive = (t) => /InProgress|Initializing/.test(t.state || "");
const isQueued = (t) => /Queued|Requested/.test(t.state || "") && !/Completed/.test(t.state || "");
const fileName = (p) => String(p || "?").split(/[\\/]/).pop();

module.exports = {
	kind: "slskd",
	label: "slskd",
	match: /slskd/,
	repo: "slskd/slskd",
	ttl: 15000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("slskd.yml → web.authentication.api_keys (leer lassen, wenn die Anmeldung aus ist)", "slskd.yml → web.authentication.api_keys (leave empty if authentication is off)"), secret: true }],
	async fetch({ url, secrets, request, json }) {
		const headers = secrets.apiKey ? { "X-API-Key": secrets.apiKey } : {};
		const get = async (path) => {
			try {
				return await json(`${url}/api/v0/${path}`, { headers });
			} catch (err) {
				if (!secrets.apiKey && /Access denied/.test(err.message)) throw new Error("API key missing");
				throw err;
			}
		};
		const [app, downloads, uploads] = await Promise.all([get("application"), get("transfers/downloads"), get("transfers/uploads")]);
		if (!app || !app.server) throw new Error("Unexpected answer from slskd");
		const down = flatten(downloads);
		const up = flatten(uploads);
		const active = [...down.filter(isActive).map((t) => ({ ...t, dir: "↓" })), ...up.filter(isActive).map((t) => ({ ...t, dir: "↑" }))];
		const connected = !!(app.server.isConnected || /Connected/.test(app.server.state || "")) && !/Disconnected/.test(app.server.state || "");
		const queued = down.filter(isQueued).length;
		const rate = (list) => list.filter(isActive).reduce((a, t) => a + (Number(t.averageSpeed) || 0), 0);
		const files = app.shares && app.shares.files;
		return {
			metrics: [
				{ value: connected ? L("Verbunden", "Connected") : L("Getrennt", "Disconnected"), label: "Soulseek", warn: !connected },
				{ value: down.filter(isActive).length, label: L("Downloads aktiv", "Downloads active") },
				{ value: up.filter(isActive).length, label: L("Uploads aktiv", "Uploads active") },
				{ value: speed(rate(down)), label: L("Download", "Download") }
			],
			items: active.map((t) => ({
				title: fileName(t.filename),
				sub: [`${t.dir} ${t.username || "?"}`, t.size > 0 ? `${Math.round((100 * (Number(t.bytesTransferred) || 0)) / t.size)} %` : "", t.averageSpeed ? speed(t.averageSpeed) : ""].filter(Boolean).join(" · "),
				status: "ok"
			})),
			warnings: connected ? [] : ["slskd is not connected to the Soulseek server"],
			summary: [queued ? `${queued} queued` : "", files != null ? `${Number(files).toLocaleString("en-US")} shared files` : ""].filter(Boolean).join(" · ") || null
		};
	}
};
