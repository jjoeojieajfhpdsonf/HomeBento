"use strict";
// OpenWrt: load, memory, uptime and the WAN interface through ubus JSON-RPC (POST /ubus,
// needs the package uhttpd-mod-ubus, which LuCI installs). Login with session.login, then
// "system info", "system board" and "network.interface.wan status". The session is kept and
// renewed when ubus answers "Access denied".
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const NO_SESSION = "00000000000000000000000000000000";
const sessions = new Map(); // url + login hash -> ubus_rpc_session
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;

function duration(sec) {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

class Denied extends Error {}

// One ubus call. Resolves the data object; throws Denied when the session is not (or no longer) valid.
async function call(url, json, session, object, method, args = {}) {
	const r = await json(`${url}/ubus`, { method: "POST", body: { jsonrpc: "2.0", id: 1, method: "call", params: [session, object, method, args] } });
	if (r && r.error) {
		if (r.error.code === -32002) throw new Denied("Access denied");
		throw new Error(`ubus ${object} ${method}: ${r.error.message || r.error.code}`);
	}
	if (!r || !Array.isArray(r.result)) throw new Error("Unexpected answer from ubus");
	const [code, data] = r.result;
	if (code === 6) throw new Denied("Access denied");
	if (code !== 0) throw new Error(`ubus ${object} ${method} failed (code ${code})`);
	return data || {};
}

async function login(url, json, username, password) {
	try {
		const data = await call(url, json, NO_SESSION, "session", "login", { username, password });
		if (!data.ubus_rpc_session) throw new Error("Login failed");
		return data.ubus_rpc_session;
	} catch (err) {
		if (err instanceof Denied) throw new Error("Access denied (check user and password)");
		if (/HTTP 404/.test(err.message)) throw new Error("No ubus on this address (install uhttpd-mod-ubus)");
		throw err;
	}
}

async function load(url, json, session, wanName) {
	const [info, board, wan] = await Promise.all([
		call(url, json, session, "system", "info"),
		call(url, json, session, "system", "board").catch((err) => {
			if (err instanceof Denied) return null; // the user may not read the board info
			throw err;
		}),
		call(url, json, session, `network.interface.${wanName}`, "status").catch((err) => {
			if (err instanceof Denied || /not found|code 4\b/i.test(err.message)) return null; // no such interface or no right
			throw err;
		})
	]);
	return { info, board, wan };
}

module.exports = {
	kind: "openwrt",
	label: "OpenWrt",
	match: /openwrt/,
	repo: "openwrt/openwrt",
	ttl: 30000,
	fields: [
		{ key: "username", label: L("Benutzer", "User"), help: L("Meist root (LuCI-Login). Andere Benutzer brauchen eine rpcd-ACL für system und network.interface.", "Usually root (the LuCI login). Other users need an rpcd ACL for system and network.interface.") },
		{ key: "password", label: L("Passwort", "Password"), secret: true },
		{ key: "wan", label: L("WAN-Schnittstelle", "WAN interface"), help: L("Optional, Standard: wan", "Optional, default: wan") }
	],
	async fetch({ url, secrets, json }) {
		const username = secrets.username || "root";
		if (!secrets.password) throw new Error("Password missing");
		const wanName = (secrets.wan || "wan").trim();
		if (!/^[\w.-]+$/.test(wanName)) throw new Error("Invalid WAN interface name");
		const key = keyOf(url, username, secrets.password);
		let data = null;
		if (sessions.has(key)) {
			try {
				data = await load(url, json, sessions.get(key), wanName);
			} catch (err) {
				sessions.delete(key);
				if (!(err instanceof Denied)) throw err;
			}
		}
		if (!data) {
			const session = await login(url, json, username, secrets.password);
			sessions.set(key, session);
			try {
				data = await load(url, json, session, wanName);
			} catch (err) {
				if (err instanceof Denied) throw new Error("Access denied (the user may not read the system info)");
				throw err;
			}
		}
		const { info, board, wan } = data;
		const mem = info.memory || {};
		const free = mem.available !== undefined ? mem.available : (mem.free || 0) + (mem.buffered || 0) + (mem.cached || 0);
		const ram = mem.total ? Math.round(((mem.total - free) / mem.total) * 100) : null;
		const loadAvg = Array.isArray(info.load) ? (info.load[0] / 65536).toFixed(2) : null;
		const ip = wan && Array.isArray(wan["ipv4-address"]) && wan["ipv4-address"][0] ? wan["ipv4-address"][0].address : null;
		const release = board && board.release ? `OpenWrt ${board.release.version || ""}`.trim() : null;
		return {
			metrics: [
				{ value: loadAvg, label: L("Last", "Load") },
				{ value: ram !== null ? `${ram} %` : null, label: "RAM", warn: ram > 90 },
				{ value: wan ? (wan.up ? L("Online", "Online") : L("Offline", "Offline")) : null, label: "WAN", warn: !!wan && !wan.up },
				{ value: info.uptime !== undefined ? duration(info.uptime) : null, label: L("Laufzeit", "Uptime") }
			],
			items: wan ? [{ title: `WAN (${wanName})`, sub: [wan.proto, ip, wan.up && wan.uptime ? duration(wan.uptime) : wan.up ? "" : "down"].filter(Boolean).join(" · "), status: wan.up ? "ok" : "bad" }] : [],
			warnings: wan && !wan.up ? [`OpenWrt WAN (${wanName}) is down`] : [],
			summary: [board && board.model, release, ip ? `WAN ${ip}` : null].filter(Boolean).join(" · ") || null
		};
	}
};
