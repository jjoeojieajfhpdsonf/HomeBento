"use strict";
// FRITZ!Box: internet connection, external IP, line speed and current traffic.
// With a login: TR-064 (SOAP on port 49000, or 49443 for https) with HTTP digest auth —
// WANCommonInterfaceConfig (line speed, byte counters; the rate is the difference to the
// last call) and WANIPConnection / WANPPPConnection (state, uptime, external IP).
// Without a login: the IGD UPnP endpoints (/igdupnp/control/…), which need
// "Transmit status information over UPnP" and already report the current rates.
const crypto = require("node:crypto");
const L = (de, en) => ({ de, en });

const challenges = new Map(); // base + user -> last digest challenge (saves a round trip)
const samples = new Map(); // base + login -> { at, rx, tx } of the last call

// The TR-064 address: the URL as entered when it names a special port, otherwise port 49000/49443.
function apiBase(url) {
	const u = new URL(url);
	if (u.port && u.port !== "80" && u.port !== "443") return url;
	return `${u.protocol}//${u.hostname}:${u.protocol === "https:" ? 49443 : 49000}`;
}

function parseChallenge(header) {
	const h = [].concat(header || []).find((x) => /^\s*digest\s/i.test(x));
	if (!h) return null;
	const out = {};
	for (const [, k, quoted, plain] of h.replace(/^\s*digest\s+/i, "").matchAll(/([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g)) out[k.toLowerCase()] = quoted !== undefined ? quoted : plain;
	return out.nonce ? { ...out, nc: 0 } : null;
}

// RFC 7616 digest response (MD5 or SHA-256, qop=auth or none)
function digest(ch, method, uri, user, password) {
	const alg = String(ch.algorithm || "MD5").toUpperCase();
	const hashName = alg.startsWith("SHA-256") ? "sha256" : "md5";
	const H = (s) => crypto.createHash(hashName).update(s).digest("hex");
	const cnonce = crypto.randomBytes(8).toString("hex");
	let ha1 = H(`${user}:${ch.realm}:${password}`);
	if (alg.endsWith("-SESS")) ha1 = H(`${ha1}:${ch.nonce}:${cnonce}`);
	const ha2 = H(`${method}:${uri}`);
	const qop = ch.qop && ch.qop.split(",").map((q) => q.trim()).includes("auth") ? "auth" : null;
	ch.nc += 1;
	const nc = ch.nc.toString(16).padStart(8, "0");
	const response = qop ? H(`${ha1}:${ch.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${ch.nonce}:${ha2}`);
	const parts = [`username="${user}"`, `realm="${ch.realm}"`, `nonce="${ch.nonce}"`, `uri="${uri}"`, `response="${response}"`, `algorithm=${ch.algorithm || "MD5"}`];
	if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
	if (ch.opaque !== undefined) parts.push(`opaque="${ch.opaque}"`);
	return `Digest ${parts.join(", ")}`;
}

function envelope(serviceType, action) {
	return `<?xml version="1.0" encoding="utf-8"?><s:Envelope s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/" xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action} xmlns:u="${serviceType}"></u:${action}></s:Body></s:Envelope>`;
}

// One SOAP action. Resolves { NewX: "value", … }.
async function soap(request, base, path, serviceType, action, login) {
	const url = `${base}${path}`;
	const uri = new URL(url).pathname;
	const body = envelope(serviceType, action);
	const headers = { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${serviceType}#${action}"` };
	const ckey = login ? `${base}|${login.user}` : null;
	const send = () => {
		const h = { ...headers };
		if (login && challenges.has(ckey)) h.Authorization = digest(challenges.get(ckey), "POST", uri, login.user, login.password);
		return request(url, { method: "POST", headers: h, body, timeout: 10000 });
	};
	let r = await send();
	if (!r.status) throw new Error(r.error);
	if (r.status === 401 && login) {
		const ch = parseChallenge(r.headers["www-authenticate"]);
		if (!ch) throw new Error("FRITZ!Box asks for an unknown login method");
		challenges.set(ckey, ch);
		r = await send();
	}
	if (!r.status) throw new Error(r.error);
	if (r.status === 401 || r.status === 403) {
		if (ckey) challenges.delete(ckey);
		throw new Error(login ? "Access denied (check user and password)" : "Access denied");
	}
	const text = r.body.toString("utf8");
	if (r.status >= 400) {
		const code = /<errorCode>(\d+)<\/errorCode>/.exec(text);
		if (code && code[1] === "606") throw new Error("Access denied (the FRITZ!Box user needs the right “FRITZ!Box settings”)");
		if (code && (code[1] === "401" || code[1] === "714" || code[1] === "820")) throw Object.assign(new Error(`${action} not available`), { soft: true });
		if (r.status === 404) throw Object.assign(new Error("not found"), { notFound: true });
		throw new Error(code ? `${action} failed (UPnP error ${code[1]})` : `HTTP ${r.status}`);
	}
	const out = {};
	for (const [, name, value] of text.matchAll(/<(New[\w-]+)>([^<]*)<\/\1>/g)) out[name] = value;
	return out;
}

function mbit(bitsPerSec) {
	const v = Number(bitsPerSec) / 1e6;
	return v >= 10 ? String(Math.round(v)) : v.toFixed(1);
}

function rate(bytesPerSec) {
	const bits = Math.max(0, Number(bytesPerSec) || 0) * 8;
	if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbit/s`;
	if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbit/s`;
	return `${Math.round(bits / 1e3)} kbit/s`;
}

function duration(sec) {
	sec = Math.max(0, Math.floor(Number(sec) || 0));
	const d = Math.floor(sec / 86400);
	const h = Math.floor((sec % 86400) / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}

// TR-064 with a login
async function tr064(request, base, login, sampleDelay) {
	const DSL = "urn:dslforum-org:service:";
	const common = (action) => soap(request, base, "/upnp/control/wancommonifconfig1", `${DSL}WANCommonInterfaceConfig:1`, action, login);
	const soft = (p) => p.catch((err) => (err.soft || err.notFound ? null : Promise.reject(err)));
	const bytes = async () => {
		const [s, r] = await Promise.all([common("GetTotalBytesSent"), common("GetTotalBytesReceived")]);
		return { at: Date.now(), tx: Number(s.NewTotalBytesSent), rx: Number(r.NewTotalBytesReceived) };
	};
	const [link, ip, ppp, first] = await Promise.all([
		common("GetCommonLinkProperties"),
		soft(soap(request, base, "/upnp/control/wanipconnection1", `${DSL}WANIPConnection:1`, "GetStatusInfo", login)),
		soft(soap(request, base, "/upnp/control/wanpppconn1", `${DSL}WANPPPConnection:1`, "GetStatusInfo", login)),
		soft(bytes())
	]);
	// DSL with PPPoE uses WANPPPConnection, cable and fibre WANIPConnection
	const conn = [ppp, ip].find((c) => c && c.NewConnectionStatus === "Connected") || ip || ppp;
	const connPath = conn === ppp ? ["/upnp/control/wanpppconn1", `${DSL}WANPPPConnection:1`] : ["/upnp/control/wanipconnection1", `${DSL}WANIPConnection:1`];
	const ext = conn ? await soft(soap(request, base, connPath[0], connPath[1], "GetExternalIPAddress", login)) : null;

	let down = null;
	let up = null;
	if (first) {
		const key = `${base}|${login.user}`;
		let prev = samples.get(key);
		let now = first;
		if (!prev || now.at - prev.at > 10 * 60000) {
			prev = first;
			await new Promise((r) => setTimeout(r, sampleDelay));
			now = await bytes();
		}
		const dt = (now.at - prev.at) / 1000;
		// the counters are 32 bit and wrap around
		const diff = (a, b) => (a - b + 2 ** 32) % 2 ** 32;
		if (dt > 0) {
			down = diff(now.rx, prev.rx) / dt;
			up = diff(now.tx, prev.tx) / dt;
		}
		samples.set(key, now);
	}
	return {
		status: conn ? conn.NewConnectionStatus : link.NewPhysicalLinkStatus === "Up" ? "Connected" : link.NewPhysicalLinkStatus || "Unconfigured",
		uptime: conn ? Number(conn.NewUptime) : null,
		ip: ext ? ext.NewExternalIPAddress : null,
		maxDown: Number(link.NewLayer1DownstreamMaxBitRate) || 0,
		maxUp: Number(link.NewLayer1UpstreamMaxBitRate) || 0,
		access: link.NewWANAccessType || null,
		down,
		up
	};
}

// IGD UPnP without a login
async function igd(request, base) {
	const IGD = "urn:schemas-upnp-org:service:";
	const conn = (action) => soap(request, base, "/igdupnp/control/WANIPConn1", `${IGD}WANIPConnection:1`, action, null);
	const common = (action) => soap(request, base, "/igdupnp/control/WANCommonIFC1", `${IGD}WANCommonInterfaceConfig:1`, action, null);
	let status, ext, link, addon;
	try {
		[status, ext, link, addon] = await Promise.all([conn("GetStatusInfo"), conn("GetExternalIPAddress").catch(() => null), common("GetCommonLinkProperties"), common("GetAddonInfos").catch(() => null)]);
	} catch (err) {
		if (err.notFound || err.soft || /HTTP 50/.test(err.message)) throw new Error("No status over UPnP: enter a login, or turn on “Transmit status information over UPnP” (Home Network → Network → Network Settings)");
		throw err;
	}
	return {
		status: status.NewConnectionStatus || "Unconfigured",
		uptime: Number(status.NewUptime),
		ip: ext ? ext.NewExternalIPAddress : null,
		maxDown: Number(link.NewLayer1DownstreamMaxBitRate) || 0,
		maxUp: Number(link.NewLayer1UpstreamMaxBitRate) || 0,
		access: link.NewWANAccessType || null,
		down: addon ? Number(addon.NewByteReceiveRate) : null,
		up: addon ? Number(addon.NewByteSendRate) : null
	};
}

module.exports = {
	kind: "fritzbox",
	label: "FRITZ!Box",
	match: /^(?!.*exporter).*fritz/,
	ttl: 30000,
	sampleDelay: 1000, // TR-064, first call: wait this long for a second byte sample
	fields: [
		{
			key: "username",
			label: L("Benutzer", "User"),
			help: L(
				"System → FRITZ!Box-Benutzer (Recht «FRITZ!Box Einstellungen»); Heimnetz → Netzwerk → Netzwerkeinstellungen → «Zugriff für Anwendungen zulassen». Ohne Login: dort «Statusinformationen über UPnP übertragen» einschalten.",
				"System → FRITZ!Box Users (right “FRITZ!Box settings”); Home Network → Network → Network Settings → “Allow access for applications”. Without a login: turn on “Transmit status information over UPnP” there."
			)
		},
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	apiBase,
	parseChallenge,
	digest,
	async fetch({ url, secrets, request }) {
		const base = apiBase(url);
		const d = secrets.password ? await tr064(request, base, { user: secrets.username || "", password: secrets.password }, module.exports.sampleDelay) : await igd(request, base);
		const online = d.status === "Connected";
		return {
			metrics: [
				{ value: online ? L("Online", "Online") : d.status === "Connecting" ? L("Verbindet", "Connecting") : L("Offline", "Offline"), label: "Internet", warn: !online },
				{ value: d.down !== null && Number.isFinite(d.down) ? rate(d.down) : null, label: "↓" },
				{ value: d.up !== null && Number.isFinite(d.up) ? rate(d.up) : null, label: "↑" },
				{ value: d.maxDown || d.maxUp ? `${mbit(d.maxDown)}/${mbit(d.maxUp)} Mbit/s` : null, label: L("Leitung", "Line") }
			],
			warnings: online ? [] : [`FRITZ!Box internet connection: ${d.status}`],
			summary: [d.ip ? `IP ${d.ip}` : null, online && d.uptime ? `online ${duration(d.uptime)}` : null, d.access].filter(Boolean).join(" · ") || null
		};
	}
};
