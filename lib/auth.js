"use strict";
// Optional password protection (env PASSWORD). Sessions are long-lived cookies.
const crypto = require("node:crypto");
const path = require("node:path");
const { readJSON, writeJSON } = require("./util");
const { UserError } = require("./errors");

const COOKIE = "homebento_session";
const MAX_SESSIONS = 50;
const MAX_FAILS = 10; // per address and 10 minutes

class Auth {
	constructor(password, dataDir) {
		this.password = password || "";
		this.file = path.join(dataDir, "sessions.json");
		this.sessions = readJSON(this.file, []);
		this.fails = new Map();
	}

	get enabled() {
		return this.password !== "";
	}

	token(req) {
		const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`).exec(req.headers.cookie || "");
		return m ? m[1] : null;
	}

	check(req) {
		if (!this.enabled) return true;
		const t = this.token(req);
		return !!t && this.sessions.includes(hash(t));
	}

	// Returns the Set-Cookie header for a new session.
	login(password, address) {
		const now = Date.now();
		const recent = (this.fails.get(address) || []).filter((t) => now - t < 10 * 60 * 1000);
		if (recent.length >= MAX_FAILS) throw new UserError("Too many attempts. Please wait a few minutes.");
		if (!equal(String(password || ""), this.password)) {
			recent.push(now);
			this.fails.set(address, recent);
			throw new UserError("Wrong password");
		}
		this.fails.delete(address);
		const t = crypto.randomBytes(32).toString("hex");
		this.sessions.push(hash(t));
		this.sessions = this.sessions.slice(-MAX_SESSIONS);
		writeJSON(this.file, this.sessions, 0o600);
		return `${COOKIE}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
	}

	logout(req) {
		const t = this.token(req);
		if (t) {
			this.sessions = this.sessions.filter((s) => s !== hash(t));
			writeJSON(this.file, this.sessions, 0o600);
		}
		return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
	}
}

// Only hashes are stored, so the sessions file is useless to whoever reads it.
function hash(t) {
	return crypto.createHash("sha256").update(t).digest("hex");
}

function equal(a, b) {
	const x = crypto.createHash("sha256").update(a).digest();
	const y = crypto.createHash("sha256").update(b).digest();
	return crypto.timingSafeEqual(x, y);
}

module.exports = { Auth };
