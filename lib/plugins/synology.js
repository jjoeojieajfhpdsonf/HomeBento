"use strict";
// Synology DiskStation (DSM): CPU and RAM (SYNO.Core.System.Utilization), volumes and disks
// (SYNO.Storage.CGI.Storage) and uptime (SYNO.DSM.Info) through the DSM Web API. SYNO.API.Auth
// with account and password gives a session id (sid), which is kept and reused; after a session
// error HomeBento logs in again. Storage and utilization need an account in the administrators
// group, and 2-step verification must be off for that account.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const APIS = ["SYNO.API.Auth", "SYNO.Core.System.Utilization", "SYNO.Storage.CGI.Storage", "SYNO.DSM.Info"];
const SESSION_CODES = new Set([106, 107, 119]); // timeout, interrupted by another login, sid not found
const sessions = new Map(); // url + login hash -> sid
const infos = new Map(); // url -> SYNO.API.Info answer
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;

const LOGIN_ERRORS = {
	400: "Access denied (check account and password)",
	401: "This DSM account is disabled",
	402: "Access denied (the account may not use this DiskStation)",
	403: "2-step verification is on: use an account without it",
	404: "2-step verification is on: use an account without it",
	406: "2-step verification is enforced: use an account without it",
	407: "Too many failed logins: this IP address is blocked in DSM",
	408: "The password has expired: change it in DSM",
	409: "The password has expired: change it in DSM",
	410: "The password must be changed: log in to DSM once"
};

function uptime(sec) {
	if (!(sec >= 0)) return null;
	if (sec >= 86400) return `${Math.floor(sec / 86400)} d`;
	if (sec >= 3600) return `${Math.floor(sec / 3600)} h`;
	return `${Math.floor(sec / 60)} min`;
}

function size(bytes) {
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let v = Number(bytes);
	if (!(v >= 0)) return null;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// Where each API lives (entry.cgi on DSM 6/7, auth.cgi etc. on older ones) and its versions.
async function apiInfo(url, json) {
	if (infos.has(url)) return infos.get(url);
	const r = await json(`${url}/webapi/query.cgi?api=SYNO.API.Info&version=1&method=query&query=${APIS.join(",")}`);
	if (!r || r.success !== true || !r.data || !r.data["SYNO.API.Auth"]) throw new Error("No DSM Web API found at this address");
	infos.set(url, r.data);
	return r.data;
}

async function login(url, info, account, passwd, request) {
	const auth = info["SYNO.API.Auth"];
	const version = Math.min(Number(auth.maxVersion) || 3, 6);
	const form = new URLSearchParams({ api: "SYNO.API.Auth", version: String(version), method: "login", account, passwd, session: "HomeBento", format: "sid" }).toString();
	const r = await request(`${url}/webapi/${auth.path || "entry.cgi"}`, { method: "POST", body: form, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, timeout: 15000 });
	if (!r.status) throw new Error(r.error);
	if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
	let body;
	try {
		body = JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error("Unexpected answer (not JSON)");
	}
	if (body.success !== true) {
		const code = body.error && body.error.code;
		throw new Error(LOGIN_ERRORS[code] || `DSM login failed (code ${code})`);
	}
	if (!body.data || !body.data.sid) throw new Error("DSM sent no session id");
	return body.data.sid;
}

// One API call; throws { session: true } when the sid is no longer valid.
async function call(url, info, sid, api, method, version, json, extra = "") {
	const meta = info[api];
	if (!meta) return null; // API not available on this DSM
	const v = Math.min(Number(meta.maxVersion) || version, version);
	const r = await json(`${url}/webapi/${meta.path}?api=${api}&version=${v}&method=${method}${extra}&_sid=${encodeURIComponent(sid)}`);
	if (r && r.success === true) return r.data || {};
	const code = r && r.error && r.error.code;
	if (SESSION_CODES.has(code)) {
		const e = new Error("DSM session expired");
		e.session = true;
		throw e;
	}
	if (code === 105) throw new Error("Permission denied: the DSM account must be in the administrators group");
	throw new Error(`DSM answered with error ${code || "?"} for ${api}`);
}

async function load(url, info, sid, json) {
	const [util, storage, dsm] = await Promise.all([
		call(url, info, sid, "SYNO.Core.System.Utilization", "get", 1, json),
		call(url, info, sid, "SYNO.Storage.CGI.Storage", "load_info", 1, json),
		call(url, info, sid, "SYNO.DSM.Info", "getinfo", 2, json).catch((err) => {
			if (err.session) throw err;
			return null;
		})
	]);
	return { util, storage, dsm };
}

module.exports = {
	kind: "synology",
	label: "Synology DiskStation",
	match: /synology|diskstation/,
	ttl: 60000,
	fields: [
		{
			key: "account",
			label: L("Benutzername", "User name"),
			help: L(
				"Ein DSM-Konto in der Gruppe «administrators» (für Speicher und Auslastung nötig), ohne 2-Faktor-Anmeldung. Adresse z. B. https://nas:5001",
				"A DSM account in the “administrators” group (needed for storage and utilization), without 2-step verification. Address e.g. https://nas:5001"
			)
		},
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	uptime,
	async fetch({ url, secrets, request, json }) {
		const account = secrets.account || "";
		const password = secrets.password || "";
		if (!account || !password) throw new Error("User name or password missing");
		const info = await apiInfo(url, json);
		const key = keyOf(url, account, password);
		let data;
		if (sessions.has(key)) {
			try {
				data = await load(url, info, sessions.get(key), json);
			} catch (err) {
				sessions.delete(key);
				if (!err.session) throw err;
				// session expired: log in again below
			}
		}
		if (!data) {
			const sid = await login(url, info, account, password, request);
			sessions.set(key, sid);
			data = await load(url, info, sid, json);
		}
		const { util, storage, dsm } = data;
		if (!storage || !Array.isArray(storage.volumes)) throw new Error("Unexpected answer from DSM (no volumes)");

		const volumes = storage.volumes.map((v) => {
			const total = Number(v.size && v.size.total);
			const used = Number(v.size && v.size.used);
			const pct = total > 0 ? Math.round((used / total) * 100) : null;
			const status = String(v.status || "unknown").toLowerCase();
			const name = v.display_name || (v.vol_path ? v.vol_path.replace(/^\//, "") : "") || String(v.id || "volume").replace(/_/g, " ");
			return { name, status, pct, free: total > 0 ? size(total - used) : null, healthy: status === "normal" };
		});
		const disks = (Array.isArray(storage.disks) ? storage.disks : []).map((d) => {
			const smart = String(d.smart_status || "").toLowerCase();
			const st = String(d.status || "").toLowerCase();
			const bad = st === "crashed" || /fail|abnormal/.test(smart);
			const warn = !bad && ((st && st !== "normal") || smart === "attention" || d.exceed_bad_sector_thr === true || d.below_remain_life_thr === true);
			return { name: d.name || d.id || "disk", sub: [d.model ? String(d.model).trim() : "", st || "", typeof d.temp === "number" && d.temp > 0 ? `${d.temp} °C` : ""].filter(Boolean).join(" · "), status: bad ? "bad" : warn ? "warn" : "ok" };
		});

		const cpu = util && util.cpu ? Math.round((Number(util.cpu.user_load) || 0) + (Number(util.cpu.system_load) || 0) + (Number(util.cpu.other_load) || 0)) : null;
		const mem = util && util.memory ? (util.memory.real_usage !== undefined ? Math.round(Number(util.memory.real_usage)) : Number(util.memory.total_real) > 0 ? Math.round(100 - (100 * Number(util.memory.avail_real || 0)) / Number(util.memory.total_real)) : null) : null;
		const fullest = volumes.reduce((m, v) => (v.pct !== null && (m === null || v.pct > m) ? v.pct : m), null);
		const sick = volumes.filter((v) => !v.healthy);
		const rank = { bad: 0, warn: 1, ok: 2 };

		return {
			metrics: [
				{ value: fullest !== null ? `${fullest} %` : null, label: L("Volume belegt", "Volume used"), warn: fullest >= 90 || sick.length > 0 },
				{ value: cpu !== null ? `${cpu} %` : null, label: "CPU", warn: cpu > 90 },
				{ value: mem !== null && !isNaN(mem) ? `${mem} %` : null, label: "RAM", warn: mem > 90 },
				{ value: dsm ? uptime(Number(dsm.uptime)) : null, label: L("Laufzeit", "Uptime") }
			].filter((m) => m.value !== null),
			items: [
				...volumes.map((v) => ({ title: v.name, sub: [v.status, v.pct !== null ? `${v.pct} %` : "", v.free ? `${v.free} free` : ""].filter(Boolean).join(" · "), status: v.status === "crashed" ? "bad" : !v.healthy || v.pct >= 90 ? "warn" : "ok" })),
				...disks.sort((a, b) => rank[a.status] - rank[b.status]).map((d) => ({ title: d.name, sub: d.sub, status: d.status }))
			],
			warnings: [...sick.map((v) => `${v.name} is ${v.status}`), ...disks.filter((d) => d.status === "bad").map((d) => `${d.name} is failing`)],
			summary: dsm && (dsm.model || dsm.version_string) ? [dsm.model, dsm.version_string].filter(Boolean).join(" · ") : null
		};
	}
};
