"use strict";
// Deluge: speeds and torrents through the Web UI's JSON-RPC (/json). Logs in with the Web UI
// password (auth.login) and keeps the session cookie until Deluge forgets it.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const speed = (bps) => (bps >= 1e6 || !bps ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);
const cookies = new Map(); // address + password hash -> session cookie (a changed password logs in anew)
const keyOf = (url, password) => `${url} ${crypto.createHash("sha256").update(password).digest("hex").slice(0, 16)}`;
let seq = 0;

async function call(request, url, method, params, cookie) {
	const headers = { "Content-Type": "application/json", Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) };
	const r = await request(`${url}/json`, { method: "POST", headers, body: JSON.stringify({ method, params, id: ++seq }) });
	if (!r.status) throw new Error(r.error);
	if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the password)");
	if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
	let x;
	try {
		x = JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error("Unexpected answer (not JSON)");
	}
	return { x, headers: r.headers };
}

async function login(request, url, password) {
	const { x, headers } = await call(request, url, "auth.login", [password]);
	if (x.result !== true) throw new Error("Login failed (check the password)");
	const set = [].concat(headers["set-cookie"] || []);
	const c = set.map((s) => s.split(";")[0]).find((s) => /^_session_id=/.test(s)) || (set[0] && set[0].split(";")[0]);
	if (!c) throw new Error("Login failed (no session cookie)");
	cookies.set(keyOf(url, password), c);
	return c;
}

module.exports = {
	kind: "deluge",
	label: "Deluge",
	match: /deluge/,
	repo: "deluge-torrent/deluge",
	ttl: 5000,
	fields: [{ key: "password", label: L("Passwort", "Password"), help: L("Passwort der Weboberfläche (Standard: deluge)", "Web UI password (default: deluge)"), secret: true }],
	async fetch({ url, secrets, request }) {
		if (!secrets.password) throw new Error("Password missing");
		const keys = ["name", "progress", "download_payload_rate", "upload_payload_rate", "state"];
		let cookie = cookies.get(keyOf(url, secrets.password)) || (await login(request, url, secrets.password));
		let { x } = await call(request, url, "web.update_ui", [keys, {}], cookie);
		// error code 1: not authenticated (session expired or Deluge restarted) → log in again once
		if (x.error && x.error.code === 1) {
			cookie = await login(request, url, secrets.password);
			({ x } = await call(request, url, "web.update_ui", [keys, {}], cookie));
		}
		if (x.error) throw new Error(`Deluge: ${x.error.message || "error"}`);
		const res = x.result || {};
		if (res.connected === false) throw new Error("The Web UI is not connected to a Deluge daemon");
		const torrents = Object.values(res.torrents || {});
		const stats = res.stats || {};
		const count = (state) => torrents.filter((t) => t.state === state).length;
		const errors = torrents.filter((t) => t.state === "Error");
		const down = stats.download_rate ?? torrents.reduce((s, t) => s + (t.download_payload_rate || 0), 0);
		const up = stats.upload_rate ?? torrents.reduce((s, t) => s + (t.upload_payload_rate || 0), 0);
		return {
			metrics: [
				{ value: speed(down), label: "↓ Download" },
				{ value: speed(up), label: "↑ Upload" },
				{ value: count("Downloading"), label: L("lädt", "Downloading") },
				{ value: count("Seeding"), label: L("verteilt", "Seeding") }
			],
			items: torrents
				.filter((t) => t.state !== "Seeding" || t.progress < 100)
				.sort((a, b) => (b.download_payload_rate || 0) - (a.download_payload_rate || 0))
				.slice(0, 20)
				.map((t) => ({ title: t.name, sub: [`${Math.round(t.progress || 0)} %`, t.download_payload_rate ? speed(t.download_payload_rate) : "", t.state].filter(Boolean).join(" · "), status: t.state === "Error" ? "bad" : t.state === "Paused" ? "warn" : "ok" })),
			warnings: errors.map((t) => `${t.name}: error`)
		};
	}
};
