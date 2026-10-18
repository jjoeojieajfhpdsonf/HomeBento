"use strict";
// OpenMediaVault: system info, mounted file systems and services through the JSON-RPC interface
// (/rpc.php). Session.login with user name and password gives a session cookie, which is kept
// and reused; after a 401 HomeBento logs in again. The RPC calls need an administrator.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const sessions = new Map(); // url + login hash -> cookie
const keyOf = (url, user, pw) => `${url}|${crypto.createHash("sha256").update(`${user}\n${pw}`).digest("hex")}`;
const SESSION_CODES = new Set([5001, 5002]); // session not authenticated / expired

function cookiesOf(r) {
	const h = r.headers["set-cookie"];
	return (Array.isArray(h) ? h : h ? [h] : []).map((c) => c.split(";")[0]).join("; ");
}

// 93784 → "1 d", 7300 → "2 h", 300 → "5 min"
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

async function rpc(url, cookie, service, method, params, request) {
	const r = await request(`${url}/rpc.php`, { method: "POST", body: { service, method, params, options: null }, headers: { "Content-Type": "application/json", Accept: "application/json", ...(cookie ? { Cookie: cookie } : {}) }, timeout: 15000 });
	if (!r.status) throw new Error(r.error);
	let body = null;
	try {
		body = JSON.parse(r.body.toString("utf8"));
	} catch {
		// not JSON: handled below
	}
	const error = body && body.error;
	if (r.status === 401 || (error && SESSION_CODES.has(error.code))) {
		const e = new Error("Access denied (check user name and password)");
		e.auth = true;
		throw e;
	}
	if (error) throw new Error(`OpenMediaVault: ${String(error.message || "error").slice(0, 160)}`);
	if (r.status !== 200 || !body) throw new Error(r.status === 200 ? "Unexpected answer (not JSON)" : `HTTP ${r.status}`);
	return { response: body.response, r };
}

async function login(url, username, password, request) {
	let res;
	try {
		res = await rpc(url, null, "Session", "login", { username, password }, request);
	} catch (err) {
		if (err.auth || /incorrect|password|authenticat/i.test(err.message)) throw new Error("Access denied (check user name and password)");
		throw err;
	}
	const ok = res.response && (res.response.authenticated === true || res.response.status === "authenticated");
	if (!ok) throw new Error("Access denied (check user name and password)");
	const cookie = cookiesOf(res.r);
	if (!cookie) throw new Error("OpenMediaVault sent no session cookie");
	return cookie;
}

async function load(url, cookie, request) {
	const [info, fs, svc] = await Promise.all([
		rpc(url, cookie, "System", "getInformation", null, request),
		rpc(url, cookie, "FileSystemMgmt", "enumerateMountedFilesystems", { includeroot: true }, request),
		rpc(url, cookie, "Services", "getStatus", null, request).catch((err) => {
			if (err.auth) throw err;
			return { response: null };
		})
	]);
	return { info: info.response, fs: fs.response, services: svc.response };
}

module.exports = {
	kind: "openmediavault",
	label: "OpenMediaVault",
	match: /openmediavault|\bomv\b/,
	ttl: 60000,
	fields: [
		{ key: "username", label: L("Benutzername", "User name"), help: L("Ein Administrator der Weboberfläche, z. B. admin", "An administrator of the web interface, e.g. admin") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	uptime,
	async fetch({ url, secrets, request }) {
		const username = secrets.username || "";
		const password = secrets.password || "";
		if (!username || !password) throw new Error("User name or password missing");
		const key = keyOf(url, username, password);
		let data;
		if (sessions.has(key)) {
			try {
				data = await load(url, sessions.get(key), request);
			} catch (err) {
				sessions.delete(key);
				if (!err.auth) throw err;
				// session expired: log in again below
			}
		}
		if (!data) {
			const cookie = await login(url, username, password, request);
			sessions.set(key, cookie);
			data = await load(url, cookie, request);
		}
		const { info, fs, services } = data;
		if (!info || typeof info !== "object" || Array.isArray(info) || !Array.isArray(fs)) throw new Error("Unexpected answer from OpenMediaVault");

		const disks = fs.map((f) => {
			const used = Number(f.percentage);
			const limit = Number(f.usagewarnthreshold) > 0 ? Number(f.usagewarnthreshold) : 85;
			return { name: f.label || f.mountpoint || f.devicefile || "?", mount: f.mountpoint || "", used: used >= 0 ? used : null, free: size(f.available), full: used >= limit };
		});
		const svcList = services && Array.isArray(services.data) ? services.data : null;
		const enabled = (svcList || []).filter((s) => s.enabled);
		const down = enabled.filter((s) => !s.running);
		const ram = Number(info.memTotal) > 0 ? Math.round((Number(info.memUsed) / Number(info.memTotal)) * 100) : null;
		const cpuRaw = info.cpuUtilization !== undefined ? info.cpuUtilization : info.cpuUsage;
		const cpu = cpuRaw !== undefined && cpuRaw !== null && !isNaN(Number(cpuRaw)) ? Math.round(Number(cpuRaw)) : null;
		const fullest = disks.reduce((m, d) => (d.used !== null && (m === null || d.used > m) ? d.used : m), null);
		const updates = Number(info.availablePkgUpdates !== undefined ? info.availablePkgUpdates : info.pkgUpdatesAvailable) || 0;

		const metrics = [
			svcList ? { value: `${enabled.length - down.length}/${enabled.length}`, label: L("Dienste aktiv", "Services running"), warn: down.length > 0 } : { value: uptime(Number(info.uptime)), label: L("Laufzeit", "Uptime") },
			{ value: fullest !== null ? `${fullest} %` : null, label: L("Speicher belegt", "Storage used"), warn: disks.some((d) => d.full) },
			{ value: cpu !== null ? `${cpu} %` : null, label: "CPU", warn: cpu > 90 },
			{ value: ram !== null ? `${ram} %` : null, label: "RAM", warn: ram > 90 }
		].filter((m) => m.value !== null);

		return {
			metrics,
			items: [
				...down.map((s) => ({ title: s.title || s.name, sub: "enabled but not running", status: "bad" })),
				...disks.sort((a, b) => b.full - a.full || (b.used || 0) - (a.used || 0)).map((d) => ({ title: d.name, sub: [d.mount !== d.name ? d.mount : "", d.used !== null ? `${d.used} %` : "", d.free ? `${d.free} free` : ""].filter(Boolean).join(" · "), status: d.full ? "warn" : "ok" }))
			],
			warnings: [...down.map((s) => `Service ${s.title || s.name} is not running`), ...disks.filter((d) => d.full).map((d) => `${d.name} is ${d.used} % full`)],
			summary: [info.version ? `OMV ${String(info.version).split(" ")[0]}` : "", updates ? `${updates} updates` : "", info.rebootRequired ? "reboot required" : ""].filter(Boolean).join(" · ") || null
		};
	}
};
