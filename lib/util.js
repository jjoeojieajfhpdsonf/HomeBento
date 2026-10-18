"use strict";
const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const crypto = require("node:crypto");

// HTTP(S) request without dependencies. Never rejects: resolves
// { status, headers, body, ms } or { status: 0, error, ms }.
// `insecure` accepts self-signed certificates (common for services at home).
function request(url, { method = "GET", headers = {}, body, timeout = 10000, maxBytes = 5_000_000, insecure = false, redirects = 0, socketPath } = {}) {
	const started = Date.now();
	return new Promise((resolve) => {
		let u;
		try {
			u = new URL(url);
		} catch (err) {
			resolve({ status: 0, error: "Invalid address", ms: 0 });
			return;
		}
		const lib = u.protocol === "https:" ? https : http;
		const data = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
		const opts = {
			method,
			timeout,
			socketPath,
			rejectUnauthorized: !insecure,
			headers: { "User-Agent": "HomeBento", ...(data ? { "Content-Length": data.length } : {}), ...headers }
		};
		const req = lib.request(u, opts, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
				res.resume();
				resolve(request(new URL(res.headers.location, url).toString(), { method, headers, timeout, maxBytes, insecure, redirects: redirects - 1 }));
				return;
			}
			const chunks = [];
			let size = 0;
			res.on("data", (c) => {
				size += c.length;
				if (size > maxBytes) req.destroy(new Error("Response too large"));
				else chunks.push(c);
			});
			res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), ms: Date.now() - started }));
			res.on("error", (err) => resolve({ status: 0, error: err.message, ms: Date.now() - started }));
		});
		req.on("timeout", () => req.destroy(new Error("Timeout")));
		req.on("error", (err) => resolve({ status: 0, error: friendlyError(err), ms: Date.now() - started }));
		if (data) req.write(data);
		req.end();
	});
}

// JSON request: resolves the parsed body, throws with a readable message otherwise.
async function json(url, opts = {}) {
	const r = await request(url, { ...opts, headers: { Accept: "application/json", ...(opts.body !== undefined && typeof opts.body !== "string" ? { "Content-Type": "application/json" } : {}), ...opts.headers } });
	if (!r.status) throw new Error(r.error);
	if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the API key or login)");
	if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
	try {
		return JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error("Unexpected answer (not JSON)");
	}
}

function friendlyError(err) {
	const code = err.code || "";
	if (code === "ECONNREFUSED") return "Connection refused";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Address not found";
	if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "Host unreachable";
	if (code === "ECONNRESET") return "Connection reset";
	if (/certificate|self.signed|CERT/i.test(err.message)) return "Certificate not trusted";
	return err.message || String(err);
}

// Writes a file atomically (temp file + rename) so a crash never leaves half a file.
function writeAtomic(file, text, mode) {
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, text, mode ? { mode } : undefined);
	fs.renameSync(tmp, file);
}

function readJSON(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJSON(file, value, mode) {
	writeAtomic(file, JSON.stringify(value, null, "\t"), mode);
}

const id = () => crypto.randomBytes(5).toString("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { request, json, writeAtomic, readJSON, writeJSON, id, sleep };
