"use strict";
// NZBGet: speed, what is left and whether downloading is paused (JSON-RPC status), plus the queue
// (listgroups). Login: ControlUsername / ControlPassword from Settings → Security.
const L = (de, en) => ({ de, en });

const speed = (bps) => (bps >= 1e6 || !bps ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);
// NZBGet counts in MiB; shown in decimal units like the speeds
const size = (mib) => {
	const b = (Number(mib) || 0) * 1048576;
	return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`;
};

module.exports = {
	kind: "nzbget",
	label: "NZBGet",
	match: /nzbget/,
	repo: "nzbgetcom/nzbget",
	ttl: 5000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("ControlUsername (Standard: nzbget)", "ControlUsername (default: nzbget)") },
		{ key: "password", label: L("Passwort", "Password"), help: "ControlPassword", secret: true }
	],
	async fetch({ url, secrets, json }) {
		const headers = secrets.username || secrets.password ? { Authorization: `Basic ${Buffer.from(`${secrets.username || ""}:${secrets.password || ""}`).toString("base64")}` } : {};
		const rpc = async (method) => {
			const r = await json(`${url}/jsonrpc`, { method: "POST", headers, body: { jsonrpc: "2.0", method, params: [], id: 1 } });
			if (r.error) throw new Error(`NZBGet: ${r.error.message || r.error}`);
			return r.result;
		};
		const [st, groups] = await Promise.all([rpc("status"), rpc("listgroups").catch(() => [])]);
		const paused = !!(st.DownloadPaused || st.Download2Paused);
		const queue = Array.isArray(groups) ? groups : [];
		return {
			metrics: [
				{ value: speed(st.DownloadRate || 0), label: "↓ Download" },
				{ value: size(st.RemainingSizeMB), label: L("verbleibend", "Left") },
				{ value: queue.length, label: L("Warteschlange", "Queue") },
				{ value: paused ? L("Pausiert", "Paused") : L("Läuft", "Running"), label: L("Status", "State"), warn: paused }
			],
			items: queue.map((g) => ({ title: g.NZBName, sub: [g.FileSizeMB ? `${Math.round((1 - (g.RemainingSizeMB || 0) / g.FileSizeMB) * 100)} %` : "", size(g.RemainingSizeMB), g.Status].filter(Boolean).join(" · "), status: /PAUSED/.test(g.Status || "") ? "warn" : /FAIL|WARNING/.test(g.Status || "") ? "bad" : "ok" })),
			summary: paused ? "Paused" : null
		};
	}
};
