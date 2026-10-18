"use strict";
// The ways a service can be checked: HTTP (optionally with a keyword and allowed status codes),
// TCP port, ping, DNS answer and TLS certificate. Every check resolves (never rejects)
// { status: "up"|"slow"|"down"|"unknown", ms, error?, code?, detail?, note?, cert? }.
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const tls = require("node:tls");
const { execFile } = require("node:child_process");
const { Resolver } = require("node:dns/promises");

const SLOW_MS = 2000;
const DAY = 86400000;
const KEYWORD_BYTES = 2 * 1024 * 1024;
const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "PTR"];

const speed = (ms) => (ms > SLOW_MS ? "slow" : "up");

// A hostname (labels of letters, digits, "-" and "_") or an IP address – never anything a
// command could read as an option or a shell as syntax.
function validHost(h) {
	if (typeof h !== "string" || !h || h.length > 253 || h.startsWith("-")) return false;
	if (net.isIP(h)) return true;
	return /^[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*\.?$/i.test(h);
}

function friendly(err) {
	const code = (err && err.code) || "";
	if (code === "ECONNREFUSED") return "Connection refused";
	if (code === "ETIMEDOUT" || code === "ETIMEOUT") return "Timeout";
	if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EHOSTDOWN") return "Host unreachable";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "Address not found";
	if (code === "ECONNRESET") return "Connection reset";
	if (/certificate|self.signed|CERT/i.test((err && err.message) || "")) return "Certificate not trusted";
	return (err && err.message) || String(err);
}

// "https://host:8443/x", "host:22", "[::1]:22" or "host" -> { host, port }; null if unusable.
function hostPort(target, defaultPort) {
	const t = String(target || "").trim();
	if (!t) return null;
	if (t.includes("://")) {
		let u;
		try {
			u = new URL(t);
		} catch {
			return null;
		}
		const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : u.protocol === "http:" ? 80 : defaultPort;
		return { host: u.hostname.replace(/^\[|\]$/g, ""), port };
	}
	let m = /^\[([^\]]+)\](?::(\d+))?$/.exec(t);
	if (m) return { host: m[1], port: m[2] ? Number(m[2]) : defaultPort };
	m = /^([^:]+):(\d+)$/.exec(t);
	if (m) return { host: m[1], port: Number(m[2]) };
	return { host: t, port: defaultPort };
}

// "200-299,401" -> (code) => boolean; null when nothing usable is given.
function codeMatcher(codes) {
	const ranges = [];
	for (const part of String(codes === undefined || codes === null ? "" : codes).split(",")) {
		const m = /^\s*(\d{3})\s*(?:-\s*(\d{3}))?\s*$/.exec(part);
		if (m) ranges.push([Number(m[1]), Number(m[2] || m[1])]);
	}
	return ranges.length ? (c) => ranges.some(([lo, hi]) => c >= lo && c <= hi) : null;
}

// GET with up to `hops` redirects; reads at most maxBytes of the body (then stops, no error).
// Resolves { code, body, ms } or { error, ms }.
function get(url, o, started = Date.now(), hops = 3) {
	return new Promise((resolve) => {
		let u;
		try {
			u = new URL(url);
		} catch {
			u = null;
		}
		if (!u || !/^https?:$/.test(u.protocol)) return resolve({ error: "Invalid address", ms: Date.now() - started });
		let done = false;
		let timer = null;
		const finish = (r) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve({ ...r, ms: Date.now() - started });
		};
		const lib = u.protocol === "https:" ? https : http;
		const req = lib.get(u, { rejectUnauthorized: !o.insecure, headers: { "User-Agent": "HomeBento", Accept: "*/*" } }, (res) => {
			res.on("error", (err) => finish({ error: friendly(err) }));
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
				done = true;
				clearTimeout(timer);
				res.resume();
				let next;
				try {
					next = new URL(res.headers.location, u).toString();
				} catch {
					return resolve({ error: "Invalid redirect", ms: Date.now() - started });
				}
				return resolve(get(next, o, started, hops - 1));
			}
			const chunks = [];
			let size = 0;
			const end = () => finish({ code: res.statusCode, body: Buffer.concat(chunks) });
			res.on("data", (c) => {
				chunks.push(c);
				size += c.length;
				if (size >= o.maxBytes) {
					end();
					req.destroy();
				}
			});
			res.on("end", end);
		});
		timer = setTimeout(() => req.destroy(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" })), Math.max(1, o.timeout - (Date.now() - started)));
		req.on("error", (err) => finish({ error: friendly(err) }));
	});
}

// HTTP(S) GET. Down on a network error, HTTP >= 500 (unless `codes` allows it), a code outside
// `codes`, or a missing keyword (a present one with keywordAbsent). Keywords ignore case.
async function http_(url, { keyword, keywordAbsent = false, codes, insecure = false, timeout = 10000 } = {}) {
	const kw = keyword === undefined || keyword === null ? "" : String(keyword);
	const r = await get(url, { insecure, timeout, maxBytes: kw ? KEYWORD_BYTES : 64 * 1024 });
	if (r.error) return { status: "down", ms: null, error: r.error };
	const res = { ms: r.ms, code: r.code };
	const allowed = codeMatcher(codes);
	if (allowed ? !allowed(r.code) : r.code >= 500) return { status: "down", ...res, error: `HTTP ${r.code}` };
	if (kw) {
		const found = r.body.toString("utf8").toLowerCase().includes(kw.toLowerCase());
		if (found === Boolean(keywordAbsent)) return { status: "down", ...res, error: `Text "${kw}" ${found ? "found" : "not found"}` };
	}
	return { status: speed(r.ms), ...res };
}

// TCP connect; up as soon as the connection opens, ms = connect time.
function tcp(host, port, { timeout = 10000 } = {}) {
	return new Promise((resolve) => {
		port = Number(port);
		if (!validHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) return resolve({ status: "down", ms: null, error: "Invalid address" });
		const started = Date.now();
		const sock = net.connect({ host, port });
		const finish = (r) => {
			clearTimeout(timer);
			sock.destroy();
			resolve(r);
		};
		const timer = setTimeout(() => finish({ status: "down", ms: null, error: "Timeout" }), timeout);
		sock.once("connect", () => {
			const ms = Date.now() - started;
			finish({ status: speed(ms), ms });
		});
		sock.once("error", (err) => finish({ status: "down", ms: null, error: friendly(err) }));
	});
}

// ICMP ping through the system's ping command (no shell). Without a usable ping (missing, or
// not permitted – e.g. Docker without CAP_NET_RAW) a TCP connect to 80/443/22 stands in;
// a refused connection also proves the host is there. `command` is meant for tests.
function ping(host, { timeout = 5000, command = "ping" } = {}) {
	if (!validHost(host)) return Promise.resolve({ status: "down", ms: null, error: "Invalid host" });
	const secs = String(Math.max(1, Math.round(timeout / 1000)));
	const mac = process.platform === "darwin";
	const v6 = net.isIPv6(host);
	let bin = command;
	let args;
	if (process.platform === "win32") args = ["-n", "1", "-w", String(timeout), host];
	else if (mac && v6) {
		if (command === "ping") bin = "ping6";
		args = ["-c", "1", host];
	} else args = ["-c", "1", mac ? "-t" : "-W", secs, host];
	return new Promise((resolve) => {
		execFile(bin, args, { timeout: timeout + 2000, windowsHide: true }, (err, stdout, stderr) => {
			const out = `${stdout || ""}\n${stderr || ""}`;
			const m = /time[=<]\s*([\d.]+)\s*ms/i.exec(out);
			if (m) {
				const ms = Math.round(Number(m[1]) * 10) / 10;
				return resolve({ status: speed(ms), ms });
			}
			const code = err && err.code;
			if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || /not permitted|permission denied|are you root/i.test(out)) return resolve(tcpPing(host, timeout));
			let error = "No answer";
			if (/unknown host|cannot resolve|not known|bad address|could not find host|no address/i.test(out)) error = "Address not found";
			else if (/unreachable|no route/i.test(out)) error = "Host unreachable";
			resolve({ status: "down", ms: null, error });
		});
	});
}

function tcpPing(host, timeout) {
	const ports = [80, 443, 22];
	const started = Date.now();
	return new Promise((resolve) => {
		const errors = [];
		let left = ports.length;
		let done = false;
		for (const port of ports) {
			tcp(host, port, { timeout }).then((r) => {
				if (done) return;
				if (r.status !== "down" || r.error === "Connection refused") {
					done = true;
					const ms = Date.now() - started;
					return resolve({ status: speed(ms), ms, note: `Ping not available, checked with TCP (port ${port})` });
				}
				errors.push(r.error);
				if (--left === 0) {
					const error = errors.find((e) => e === "Address not found" || e === "Host unreachable") || "No answer";
					resolve({ status: "down", ms: null, error, note: "Ping not available, checked with TCP (ports 80, 443, 22)" });
				}
			});
		}
	});
}

const DNS_ERRORS = { ENOTFOUND: "Name not found", ENODATA: "No answer", ETIMEOUT: "Timeout", ECANCELLED: "Timeout", ECONNREFUSED: "DNS server not reachable", ESERVFAIL: "Server failure", EREFUSED: "Query refused", EBADNAME: "Invalid name" };
const dnsText = (a) => String(a).trim().replace(/\.$/, "").toLowerCase();

// DNS lookup, optionally against a given server ("192.168.1.2", "10.0.0.1:5353", "[::1]:53").
// Up with the answers in `detail`; down without an answer or when `expect` isn't among them.
async function dns(name, { server, type = "A", expect, timeout = 5000 } = {}) {
	type = String(type || "A").toUpperCase();
	name = String(name || "").trim();
	if (!DNS_TYPES.includes(type)) return { status: "down", ms: null, error: `Unsupported record type ${type}` };
	if (!validHost(name)) return { status: "down", ms: null, error: "Invalid name" };
	const resolver = new Resolver({ timeout: Math.max(500, timeout), tries: 1 });
	if (server) {
		try {
			resolver.setServers([String(server).trim()]);
		} catch {
			return { status: "down", ms: null, error: "Invalid DNS server" };
		}
	}
	const started = Date.now();
	let timer;
	try {
		const query = type === "PTR" && net.isIP(name) ? resolver.reverse(name) : resolver.resolve(name, type);
		const stop = new Promise((_, reject) => (timer = setTimeout(() => reject(Object.assign(new Error("Timeout"), { code: "ETIMEOUT" })), timeout + 500)));
		const raw = await Promise.race([query, stop]);
		const answers = raw.map((a) => (typeof a === "string" ? a : Array.isArray(a) ? a.join("") : a.exchange !== undefined ? a.exchange : a.name !== undefined ? `${a.name}:${a.port}` : JSON.stringify(a)));
		const ms = Date.now() - started;
		if (!answers.length) return { status: "down", ms, error: "No answer" };
		const detail = answers.join(", ").slice(0, 300);
		if (expect !== undefined && expect !== null && String(expect).trim() && !answers.some((a) => dnsText(a) === dnsText(expect))) return { status: "down", ms, error: `Expected "${String(expect).trim()}", got ${detail}`, detail };
		return { status: speed(ms), ms, detail };
	} catch (err) {
		resolver.cancel();
		return { status: "down", ms: null, error: DNS_ERRORS[err.code] || friendly(err) };
	} finally {
		clearTimeout(timer);
	}
}

const dnName = (x, ...keys) => {
	for (const k of keys) if (x && x[k]) return String(x[k]);
	return "";
};
const sameDn = (a, b) => JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());

// TLS certificate of "https://host[:port]", "host:port" or "host" (port 443). Untrusted
// certificates are read too; `valid` says whether the system trusts it.
function certificate(target, { timeout = 10000 } = {}) {
	return new Promise((resolve) => {
		const t = hostPort(target, 443);
		if (!t || !validHost(t.host) || !Number.isInteger(t.port) || t.port < 1 || t.port > 65535) return resolve({ status: "down", ms: null, error: "Invalid address" });
		const started = Date.now();
		const opts = { host: t.host, port: t.port, rejectUnauthorized: false };
		if (!net.isIP(t.host)) opts.servername = t.host;
		const sock = tls.connect(opts);
		const finish = (r) => {
			clearTimeout(timer);
			sock.destroy();
			resolve(r);
		};
		const timer = setTimeout(() => finish({ status: "down", ms: null, error: "Timeout" }), timeout);
		sock.once("secureConnect", () => {
			const ms = Date.now() - started;
			const c = sock.getPeerCertificate();
			const validTo = c && Date.parse(c.valid_to);
			if (!validTo) return finish({ status: "down", ms, error: "No certificate" });
			const cert = {
				validTo,
				daysLeft: Math.floor((validTo - Date.now()) / DAY),
				issuer: dnName(c.issuer, "O", "CN"),
				subject: dnName(c.subject, "CN", "O"),
				selfSigned: sameDn(c.issuer, c.subject),
				valid: sock.authorized
			};
			if (!sock.authorized && sock.authorizationError) cert.reason = String(sock.authorizationError);
			finish({ status: "up", ms, cert });
		});
		sock.once("error", (err) => finish({ status: "down", ms: null, error: friendly(err) }));
	});
}

// What a service's check looks at:
// http/keyword -> { url }, tcp -> { host, port }, ping -> { host }, dns -> { name, server, recordType, expect }
// or { type, error } when nothing usable is configured. `checkTarget` wins over the service URL.
function parseTarget(s = {}) {
	const type = s.checkType || "http";
	const target = String(s.checkTarget || "").trim();
	const fromUrl = s.url ? hostPort(s.url, null) : null;
	if (type === "http" || type === "keyword") {
		const url = /^https?:\/\//i.test(target) ? target : s.url;
		return url ? { type, url } : { type, error: "No address to check" };
	}
	if (type === "tcp") {
		let hp = fromUrl;
		if (/^:?\d+$/.test(target)) hp = fromUrl && { host: fromUrl.host, port: Number(target.replace(":", "")) };
		else if (target) hp = hostPort(target, fromUrl && fromUrl.port);
		if (!hp || !hp.host) return { type, error: "No address to check" };
		if (!hp.port) return { type, error: "Port missing" };
		return { type, host: hp.host, port: hp.port };
	}
	if (type === "ping" || type === "dns") {
		const hp = target ? hostPort(target, null) : fromUrl;
		if (!hp || !hp.host) return { type, error: "No address to check" };
		if (type === "ping") return { type, host: hp.host };
		return { type, name: hp.host, server: s.dnsServer || undefined, recordType: s.dnsType || "A", expect: s.dnsExpect || undefined };
	}
	return { type, error: `Unknown check type "${type}"` };
}

// Runs the check configured for a service. Self-signed certificates are accepted unless
// service.insecure is false (services at home often have them).
async function run(s) {
	if (!s || (!s.url && !s.checkTarget)) return { status: "unknown", ms: null };
	const t = parseTarget(s);
	if (t.error) return { status: "down", ms: null, error: t.error };
	if (t.type === "tcp") return tcp(t.host, t.port, { timeout: 10000 });
	if (t.type === "ping") return ping(t.host, { timeout: 5000 });
	if (t.type === "dns") return dns(t.name, { server: t.server, type: t.recordType, expect: t.expect });
	const opts = { codes: s.codes, insecure: s.insecure !== false, timeout: 10000 };
	if (t.type === "keyword") Object.assign(opts, { keyword: s.keyword, keywordAbsent: Boolean(s.keywordAbsent) });
	return http_(t.url, opts);
}

module.exports = { http: http_, tcp, ping, dns, certificate, parseTarget, run, validHost, hostPort, SLOW_MS };
