"use strict";
// Syncthing: folders, connected devices and sync progress from the REST API with the API key
// (Actions → Settings → General → API Key).
const L = (de, en) => ({ de, en });

const MAX_FOLDERS = 30; // folder states are asked one request each
const STUCK = 30 * 60000; // below 100 % for this long → warn
const behind = new Map(); // service → since when sync is below 100 %

module.exports = {
	kind: "syncthing",
	label: "Syncthing",
	match: /syncthing/,
	repo: "syncthing/syncthing",
	ttl: 30000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Syncthing → Aktionen → Einstellungen → Allgemein → API-Schlüssel", "Syncthing → Actions → Settings → General → API Key"), secret: true }],
	async fetch({ url, secrets, service, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const headers = { "X-API-Key": secrets.apiKey };
		const [status, conns, completion, folders, sysErr] = await Promise.all([
			json(`${url}/rest/system/status`, { headers }),
			json(`${url}/rest/system/connections`, { headers }),
			json(`${url}/rest/db/completion`, { headers }),
			json(`${url}/rest/config/folders`, { headers }),
			json(`${url}/rest/system/error`, { headers }).catch(() => null)
		]);
		if (!status || !status.myID || !conns || typeof conns.connections !== "object" || !Array.isArray(folders)) throw new Error("Unexpected answer from Syncthing");
		const states = await Promise.all(folders.slice(0, MAX_FOLDERS).map((f) => (f.paused ? null : json(`${url}/rest/db/status?folder=${encodeURIComponent(f.id)}`, { headers }).catch(() => null))));

		const devices = Object.entries(conns.connections || {}).filter(([id]) => id !== status.myID);
		const connected = devices.filter(([, c]) => c && c.connected).length;
		const pct = completion && typeof completion.completion === "number" ? Math.floor(completion.completion * 10) / 10 : null;

		const key = (service && service.id) || url;
		if (pct === null || pct >= 100) behind.delete(key);
		else if (!behind.has(key)) behind.set(key, Date.now());
		const stuck = behind.has(key) && Date.now() - behind.get(key) > STUCK;

		const list = folders.map((f, i) => {
			const st = states[i];
			const errors = st ? Math.max(Number(st.errors) || 0, Number(st.pullErrors) || 0) : 0; // pullErrors: older name of errors
			const state = f.paused ? "paused" : st ? st.state || "unknown" : st === undefined ? "" : "unknown"; // "": not asked (too many folders)
			const need = st && st.globalBytes > 0 && st.needBytes > 0 ? Math.floor((1 - st.needBytes / st.globalBytes) * 100) : null;
			return { name: f.label || f.id, id: f.id, state, errors, need, shared: Array.isArray(f.devices) ? f.devices.filter((d) => d.deviceID !== status.myID).length : 0 };
		});
		const folderErrors = list.reduce((a, f) => a + f.errors, 0);
		const systemErrors = sysErr && Array.isArray(sysErr.errors) ? sysErr.errors.length : 0;
		const errors = folderErrors + systemErrors;
		const bad = (f) => f.errors > 0 || f.state === "error";
		return {
			metrics: [
				{ value: list.length, label: L("Ordner", "Folders") },
				{ value: `${connected}/${devices.length}`, label: L("Geräte verbunden", "Devices connected") },
				{ value: pct !== null ? `${pct} %` : null, label: L("synchron", "in sync"), warn: stuck },
				{ value: errors, label: L("Fehler", "Errors"), warn: errors > 0 }
			],
			items: list
				.sort((a, b) => bad(b) - bad(a) || a.name.localeCompare(b.name))
				.map((f) => ({
					title: f.name,
					sub: [f.state === "syncing" && f.need !== null ? `syncing ${f.need} %` : f.state, f.errors ? `${f.errors} errors` : "", `${f.shared} device${f.shared === 1 ? "" : "s"}`].filter(Boolean).join(" · "),
					status: bad(f) ? "bad" : f.state === "idle" || f.state === "" ? "ok" : "warn"
				})),
			warnings: [
				...list.filter(bad).map((f) => `Folder ${f.name}: ${f.errors ? `${f.errors} file(s) failed to sync` : "error"}`),
				...(systemErrors ? sysErr.errors.slice(-3).map((e) => String(e.message || "").slice(0, 160)) : []),
				...(stuck ? [`Sync stuck at ${pct} % for more than 30 min`] : [])
			],
			summary: errors ? `${errors} error(s)` : stuck ? `Sync at ${pct} %` : null
		};
	}
};
