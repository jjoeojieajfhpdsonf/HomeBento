"use strict";
// Notifications: sends a message to ntfy, Gotify, Telegram, Pushover, Discord, Slack,
// a generic webhook or by e-mail (a small SMTP client on node:net / node:tls).
// send() resolves { ok: true } or throws an Error whose message is meant for the user.
const net = require("node:net");
const tls = require("node:tls");
const crypto = require("node:crypto");
const { request } = require("./util");

const L = (de, en) => ({ de, en });
const TIMEOUT = 15000;
// Fixed API addresses; tests pass their own with send(channel, msg, { api }).
const API = { telegram: "https://api.telegram.org", pushover: "https://api.pushover.net" };

const CHANNELS = {
	ntfy: {
		label: "ntfy",
		fields: [
			{ key: "url", label: L("Adresse mit Thema", "URL with topic"), placeholder: "https://ntfy.sh/mein-thema", secret: false },
			{ key: "token", label: L("Zugriffstoken", "Access token"), placeholder: "tk_…", secret: true, optional: true }
		]
	},
	gotify: {
		label: "Gotify",
		fields: [
			{ key: "url", label: L("Server-Adresse", "Server URL"), placeholder: "https://gotify.example.com", secret: false },
			{ key: "token", label: L("App-Token", "App token"), help: L("Gotify → Apps → App erstellen", "Gotify → Apps → Create application"), secret: true }
		]
	},
	telegram: {
		label: "Telegram",
		fields: [
			{ key: "token", label: L("Bot-Token", "Bot token"), placeholder: "123456789:AAH…", help: L("Von @BotFather", "From @BotFather"), secret: true },
			{ key: "chatId", label: L("Chat-ID", "Chat ID"), placeholder: "123456789", help: L("Zuerst dem Bot schreiben; die ID nennt z. B. @userinfobot", "Message the bot first; @userinfobot tells you the ID"), secret: false }
		]
	},
	pushover: {
		label: "Pushover",
		fields: [
			{ key: "user", label: L("Benutzerschlüssel", "User key"), secret: true },
			{ key: "token", label: L("App-Token", "App token"), help: L("pushover.net → Create an Application", "pushover.net → Create an Application"), secret: true }
		]
	},
	discord: {
		label: "Discord",
		fields: [{ key: "url", label: L("Webhook-Adresse", "Webhook URL"), placeholder: "https://discord.com/api/webhooks/…", help: L("Kanal → Einstellungen → Integrationen → Webhooks", "Channel → Settings → Integrations → Webhooks"), secret: true }]
	},
	slack: {
		label: "Slack",
		fields: [{ key: "url", label: L("Webhook-Adresse", "Webhook URL"), placeholder: "https://hooks.slack.com/services/…", help: L("Slack-App mit „Incoming Webhooks“", "Slack app with “Incoming Webhooks”"), secret: true }]
	},
	webhook: {
		label: "Webhook",
		fields: [
			{ key: "url", label: L("Adresse", "URL"), placeholder: "https://example.com/hook", help: L("Erhält JSON: title, text, level, url, at", "Receives JSON: title, text, level, url, at"), secret: false },
			{ key: "headerName", label: L("Header-Name", "Header name"), placeholder: "Authorization", secret: false, optional: true },
			{ key: "headerValue", label: L("Header-Wert", "Header value"), secret: true, optional: true }
		]
	},
	email: {
		label: L("E-Mail", "E-mail"),
		fields: [
			{ key: "host", label: L("SMTP-Server", "SMTP server"), placeholder: "smtp.example.com", secret: false },
			{ key: "port", label: L("Port", "Port"), placeholder: "587", help: L("465 = TLS, 587 = STARTTLS, 25 = unverschlüsselt", "465 = TLS, 587 = STARTTLS, 25 = unencrypted"), secret: false, optional: true },
			{
				key: "security",
				type: "select",
				label: L("Verschlüsselung", "Encryption"),
				options: [
					{ value: "auto", label: L("Automatisch (nach Port)", "Automatic (from the port)") },
					{ value: "tls", label: "TLS" },
					{ value: "starttls", label: "STARTTLS" },
					{ value: "none", label: L("Keine", "None") }
				],
				secret: false,
				optional: true
			},
			{ key: "user", label: L("Benutzername", "Username"), secret: false, optional: true },
			{ key: "password", label: L("Passwort", "Password"), secret: true, optional: true },
			{ key: "from", label: L("Absender", "From"), placeholder: "HomeBento <homebento@example.com>", secret: false },
			{ key: "to", label: L("Empfänger", "To"), placeholder: "ich@example.com, du@example.com", help: L("Mehrere mit Komma trennen", "Separate several with commas"), secret: false },
			{ key: "insecure", type: "checkbox", label: L("Selbst signierte Zertifikate erlauben", "Allow self-signed certificates"), secret: false, optional: true }
		]
	}
};

const TAGS = { down: "warning", warn: "warning", up: "white_check_mark" };
const COLORS = { down: 0xe5484d, up: 0x30a46c, warn: 0xf5a524 };
const BLUE = 0x3b82f6;

const oneLine = (s) => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();
const need = (v, what) => {
	const s = oneLine(v);
	if (!s) throw new Error(`${what} missing`);
	return s;
};
const httpUrl = (v, what = "URL") => {
	const s = need(v, what);
	if (!/^https?:\/\/[^/]/i.test(s)) throw new Error(`${what} must start with http:// or https://`);
	return s;
};
// Only http(s) links are passed on; anything else is dropped.
const link = (v) => {
	try {
		const u = new URL(v);
		return /^https?:$/.test(u.protocol) ? u.href : "";
	} catch {
		return "";
	}
};
const parse = (body) => {
	try {
		return JSON.parse(body.toString("utf8"));
	} catch {
		return null;
	}
};
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const JSON_HEADERS = { "Content-Type": "application/json" };

// RFC 2047: non-ASCII text as UTF-8 base64 encoded words of at most 75 characters.
function encodeWords(s, sep = "\r\n ") {
	if (/^[\x20-\x7e]*$/.test(s)) return s;
	const words = [];
	let cur = "";
	for (const ch of s) {
		if (Buffer.byteLength(cur + ch) > 45) {
			words.push(cur);
			cur = "";
		}
		cur += ch;
	}
	if (cur) words.push(cur);
	return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(sep);
}

// A failed HTTP answer as a readable error. `hint` is shown for 401 / 403.
function check(r, hint = "check the token") {
	if (!r.status) throw new Error(r.error);
	if (r.status >= 200 && r.status < 300) return r;
	if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} – ${hint}`);
	const j = parse(r.body);
	let why = j && [j.errorDescription, j.message, j.description, j.error].find((x) => typeof x === "string");
	if (!why && !j) {
		const text = r.body.toString("utf8").trim();
		if (text.length < 200 && !text.startsWith("<")) why = text;
	}
	throw new Error(`HTTP ${r.status}${why ? ` – ${cut(oneLine(why), 200)}` : ""}`);
}

const post = (url, o, headers, body) => request(url, { method: "POST", headers, body, timeout: o.timeout });

const SENDERS = {
	async ntfy(c, m, o) {
		const headers = {
			"Content-Type": "text/plain; charset=utf-8",
			Title: encodeWords(m.title, " "),
			Tags: TAGS[m.level] || "information_source",
			Priority: m.level === "down" ? "high" : "default"
		};
		if (m.url) headers.Click = m.url;
		if (oneLine(c.token)) headers.Authorization = `Bearer ${oneLine(c.token)}`;
		check(await post(httpUrl(c.url), o, headers, m.text || m.title));
	},

	async gotify(c, m, o) {
		const url = `${httpUrl(c.url).replace(/\/+$/, "")}/message`;
		const body = {
			title: m.title,
			message: m.text || m.title,
			priority: m.level === "down" ? 8 : m.level === "warn" ? 5 : 3,
			extras: m.url ? { "client::notification": { click: { url: m.url } } } : undefined
		};
		// The token goes in a header rather than ?token= so it stays out of proxy logs.
		check(await post(url, o, { ...JSON_HEADERS, "X-Gotify-Key": need(c.token, "App token") }, body));
	},

	async telegram(c, m, o) {
		const token = need(c.token, "Bot token");
		if (!/^[\w:-]+$/.test(token)) throw new Error("Telegram: the bot token looks wrong");
		const text = [`<b>${esc(cut(m.title, 200))}</b>`, m.text && esc(cut(m.text, 3500)), m.url && esc(m.url)].filter(Boolean).join("\n");
		const body = { chat_id: need(c.chatId, "Chat ID"), text, parse_mode: "HTML", disable_web_page_preview: true };
		const r = await post(`${o.api.telegram}/bot${token}/sendMessage`, o, JSON_HEADERS, body);
		if (!r.status) throw new Error(`Telegram: ${r.error}`);
		const j = parse(r.body);
		if (r.status === 200 && j && j.ok) return;
		if (r.status === 401 || r.status === 404) throw new Error("Telegram: unauthorized – check the bot token");
		throw new Error(`Telegram: ${((j && j.description) || `HTTP ${r.status}`).replace(/^Bad Request: /, "")}`);
	},

	async pushover(c, m, o) {
		const form = { token: need(c.token, "App token"), user: need(c.user, "User key"), title: cut(m.title, 250), message: cut(m.text || m.title, 1024), priority: m.level === "down" ? "1" : "0" };
		if (m.url) form.url = m.url;
		const r = await post(`${o.api.pushover}/1/messages.json`, o, { "Content-Type": "application/x-www-form-urlencoded" }, new URLSearchParams(form).toString());
		if (!r.status) throw new Error(`Pushover: ${r.error}`);
		const j = parse(r.body);
		if (r.status === 200 && j && j.status === 1) return;
		const errors = j && Array.isArray(j.errors) ? j.errors.join(", ") : "";
		throw new Error(`Pushover: ${errors || `HTTP ${r.status}`}`);
	},

	async discord(c, m, o) {
		const embed = { title: cut(m.title, 256), description: m.text ? cut(m.text, 4000) : undefined, color: COLORS[m.level] || BLUE, url: m.url || undefined, timestamp: new Date().toISOString() };
		check(await post(httpUrl(c.url, "Webhook URL"), o, JSON_HEADERS, { embeds: [embed] }), "check the webhook URL");
	},

	async slack(c, m, o) {
		const text = [`*${esc(m.title)}*`, m.text && esc(m.text), m.url && `<${m.url}>`].filter(Boolean).join("\n");
		check(await post(httpUrl(c.url, "Webhook URL"), o, JSON_HEADERS, { text }), "check the webhook URL");
	},

	async webhook(c, m, o) {
		const headers = { ...JSON_HEADERS };
		const name = oneLine(c.headerName);
		if (name) {
			if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(name)) throw new Error("Invalid header name");
			headers[name] = oneLine(c.headerValue);
		}
		const body = { title: m.title, text: m.text, level: m.level, url: m.url || null, at: new Date().toISOString() };
		check(await post(httpUrl(c.url), o, headers, body), "check the URL and the header");
	},

	email: (c, m, o) => smtpSend(c, m, o)
};

// channel = { type, ...fields }, msg = { title, text, level, url? }.
// opts.api overrides the Telegram / Pushover addresses (tests), opts.timeout the 15 s.
async function send(channel, msg, opts = {}) {
	const type = channel && channel.type;
	if (!Object.hasOwn(SENDERS, type)) throw new Error(`Unknown channel type: ${type}`);
	const m = {
		title: oneLine(msg && msg.title) || "HomeBento",
		text: msg && msg.text != null ? String(msg.text).trim() : "",
		level: (msg && msg.level) || "info",
		url: msg && msg.url ? link(msg.url) : ""
	};
	await SENDERS[type](channel, m, { timeout: opts.timeout || TIMEOUT, api: { ...API, ...opts.api } });
	return { ok: true };
}

// ---- SMTP ----

function address(s) {
	const m = /<([^<>]*)>\s*$/.exec(s);
	const a = (m ? m[1] : s).trim();
	if (!/^[^\s<>@,;"]+@[^\s<>@,;"]+$/.test(a)) throw new Error(`Invalid e-mail address: ${cut(s, 100)}`);
	return a;
}

// "Name <a@b>" for a header, the name quoted or encoded as needed.
function mailbox(s) {
	const a = address(s);
	const name = s.includes("<") ? s.slice(0, s.lastIndexOf("<")).trim().replace(/^"(.*)"$/, "$1") : "";
	if (!name) return a;
	if (!/^[\x20-\x7e]*$/.test(name)) return `${encodeWords(name, " ")} <${a}>`;
	return /[()<>[\]:;@\\,."]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}" <${a}>` : `${name} <${a}>`;
}

// The whole message (headers, body, dot-stuffed, CRLF) and its transfer encoding.
function buildMessage({ from, to, subject, text, eightBit }) {
	const clean = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "").replace(/\r\n?/g, "\n");
	const lines = clean.split("\n");
	const short = lines.every((l) => Buffer.byteLength(l) <= 998);
	const encoding = /^[\x00-\x7f]*$/.test(clean) && short ? "7bit" : eightBit && short ? "8bit" : "base64";
	const body = encoding === "base64" ? Buffer.from(lines.join("\r\n")).toString("base64").match(/.{1,76}/g) || [] : lines;
	const head = [
		`From: ${mailbox(from)}`,
		`To: ${to.map(mailbox).join(", ")}`,
		`Subject: ${encodeWords(subject)}`,
		`Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
		`Message-ID: <${crypto.randomBytes(8).toString("hex")}.${Date.now()}@${address(from).split("@")[1]}>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		`Content-Transfer-Encoding: ${encoding}`,
		"Auto-Submitted: auto-generated"
	];
	const all = [...head, "", ...body].map((l) => (l.startsWith(".") ? `.${l}` : l));
	return { data: Buffer.from(`${all.join("\r\n")}\r\n`), encoding };
}

function friendly(err) {
	const code = err.code || "";
	const text = err.message || String(err);
	if (code === "ECONNREFUSED") return "connection refused";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "server not found";
	if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "host unreachable";
	if (code === "ECONNRESET") return "connection reset";
	if (/certificate|self.signed|CERT_/i.test(text + code)) return "certificate not trusted (allow self-signed certificates if it is your own server)";
	if (/wrong version number|packet length too long|unknown protocol/i.test(text)) return "TLS handshake failed – check the port and the encryption setting";
	return text;
}

const failed = (r, what) => new Error(`${what} (${r.code} ${r.lines.join(" ").trim()})`);

// One SMTP connection: reads replies strictly (multi-line "250-…" included) one at a time.
class Smtp {
	constructor({ host, port, tlsNow, insecure, timeout }) {
		this.host = host;
		this.insecure = insecure;
		this.secure = tlsNow;
		this.replies = [];
		this.lines = [];
		this.buf = "";
		this.wait = null;
		this.error = null;
		this.closed = false;
		this.onData = (d) => this.parse(d.toString("latin1"));
		this.timer = setTimeout(() => this.fail(new Error("timeout")), timeout);
		this.attach(tlsNow ? tls.connect({ host, port, ...this.tlsOptions() }) : net.connect({ host, port }));
	}

	tlsOptions() {
		return { servername: net.isIP(this.host) ? undefined : this.host, rejectUnauthorized: !this.insecure };
	}

	attach(socket) {
		this.socket = socket;
		socket.on("data", this.onData);
		socket.on("error", (err) => this.fail(err));
		socket.on("close", () => this.fail(new Error("the server closed the connection")));
	}

	// STARTTLS accepted: continue on an encrypted socket. Writes wait for the handshake,
	// and a failed handshake reaches fail(), which rejects the next read.
	upgrade() {
		this.socket.removeListener("data", this.onData);
		this.attach(tls.connect({ socket: this.socket, ...this.tlsOptions() }));
		this.secure = true;
	}

	parse(chunk) {
		this.buf += chunk;
		if (this.buf.length > 65536) return this.fail(new Error("answer from the server too long"));
		let i;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i).replace(/\r$/, "");
			this.buf = this.buf.slice(i + 1);
			const m = /^(\d{3})([ -]|$)(.*)$/.exec(line);
			if (!m || (this.lines.length && m[1] !== this.lines[0].code)) return this.fail(new Error(`unexpected answer from the server: ${cut(line, 100)}`));
			this.lines.push({ code: m[1], text: m[3] });
			if (m[2] === "-") continue;
			const reply = { code: Number(m[1]), lines: this.lines.map((l) => l.text) };
			this.lines = [];
			if (this.wait) {
				const w = this.wait;
				this.wait = null;
				w.resolve(reply);
			} else this.replies.push(reply);
		}
	}

	read() {
		if (this.replies.length) return Promise.resolve(this.replies.shift());
		if (this.error) return Promise.reject(this.error);
		return new Promise((resolve, reject) => (this.wait = { resolve, reject }));
	}

	cmd(line) {
		if (this.error) return Promise.reject(this.error);
		this.socket.write(`${line}\r\n`);
		return this.read();
	}

	// Sends `line` (or only reads when null) and requires one of `codes`.
	async expect(line, codes, what) {
		const r = await (line === null ? this.read() : this.cmd(line));
		if (!codes.includes(r.code)) throw failed(r, what);
		return r;
	}

	// EHLO (HELO for old servers); returns the extensions, e.g. AUTH → ["PLAIN", "LOGIN"].
	async hello() {
		const a = (this.socket.localAddress || "").replace(/^::ffff:/, "");
		const name = !a ? "localhost" : net.isIPv6(a) ? `[IPv6:${a}]` : `[${a}]`;
		const r = await this.cmd(`EHLO ${name}`);
		if (r.code !== 250) {
			await this.expect(`HELO ${name}`, [250], "the server rejected HELO");
			return new Map();
		}
		return new Map(r.lines.slice(1).map((l) => {
			const [k, ...rest] = l.trim().toUpperCase().split(/[\s=]+/);
			return [k, rest];
		}));
	}

	// AUTH PLAIN, or AUTH LOGIN when the server only offers that (or refuses PLAIN).
	async auth(ext, user, pass) {
		const mechs = ext.get("AUTH") || [];
		const b64 = (s) => Buffer.from(s).toString("base64");
		if (mechs.length && !mechs.includes("PLAIN") && !mechs.includes("LOGIN")) throw new Error(`no supported login method (server offers ${mechs.join(", ")})`);
		if (!mechs.length || mechs.includes("PLAIN")) {
			const r = await this.cmd(`AUTH PLAIN ${b64(`\0${user}\0${pass}`)}`);
			if (r.code === 235) return;
			if (!mechs.includes("LOGIN") || ![500, 501, 502, 504].includes(r.code)) throw failed(r, "authentication failed");
		}
		await this.expect("AUTH LOGIN", [334], "authentication failed");
		await this.expect(b64(user), [334], "authentication failed");
		await this.expect(b64(pass), [235], "authentication failed");
	}

	fail(err) {
		if (this.error || this.closed) return;
		this.error = err;
		clearTimeout(this.timer);
		this.socket.destroy();
		if (this.wait) {
			this.wait.reject(err);
			this.wait = null;
		}
	}

	close() {
		this.closed = true;
		clearTimeout(this.timer);
		this.socket.destroy();
	}
}

async function smtpSend(c, m, o) {
	const host = need(c.host, "SMTP server");
	const mode = ["auto", "tls", "starttls", "none"].includes(c.security) ? c.security : "auto";
	const port = Number(c.port) || (mode === "tls" ? 465 : 587);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
	const tlsNow = mode === "tls" || (mode === "auto" && port === 465);
	const insecure = c.insecure === true || c.insecure === "true" || c.insecure === "on";
	const user = oneLine(c.user);
	const pass = c.password == null ? "" : String(c.password);
	const from = need(c.from, "Sender");
	const to = oneLine(c.to).split(",").map((s) => s.trim()).filter(Boolean);
	if (!to.length) throw new Error("Recipient missing");
	const sender = address(from);
	const rcpts = to.map(address);
	const text = [m.text || m.title, m.url].filter(Boolean).join("\n\n");

	const s = new Smtp({ host, port, tlsNow, insecure, timeout: o.timeout });
	try {
		await s.expect(null, [220], "the server refused the connection");
		let ext = await s.hello();
		if (!tlsNow && (mode === "starttls" || (mode === "auto" && ext.has("STARTTLS")))) {
			if (!ext.has("STARTTLS")) throw new Error("the server does not offer STARTTLS");
			await s.expect("STARTTLS", [220], "STARTTLS failed");
			s.upgrade();
			ext = await s.hello();
		}
		if (user) {
			if (!s.secure && mode !== "none") throw new Error("the server offers no encryption – choose “None” to send the password unencrypted anyway");
			await s.auth(ext, user, pass);
		}
		const { data, encoding } = buildMessage({ from, to, subject: m.title, text, eightBit: ext.has("8BITMIME") });
		await s.expect(`MAIL FROM:<${sender}>${encoding === "8bit" ? " BODY=8BITMIME" : ""}`, [250], "sender rejected");
		for (const r of rcpts) await s.expect(`RCPT TO:<${r}>`, [250, 251], `recipient ${r} rejected`);
		await s.expect("DATA", [354], "the server refused the message");
		s.socket.write(data);
		await s.expect(".", [250], "the server refused the message");
		await s.cmd("QUIT").catch(() => {});
	} catch (err) {
		throw new Error(`SMTP: ${friendly(err)}`);
	} finally {
		s.close();
	}
}

// ---- Texts for monitor events ----

// ev = { kind, name, detail, value } → { title, text, level } in German ("de") or English.
function format(ev = {}, lang = "en") {
	const de = lang === "de";
	const t = (a, b) => (de ? a : b);
	const name = ev.name || "?";
	const v = typeof ev.value === "number" ? Math.round(ev.value) : ev.value;
	const has = v != null && v !== "";
	const pct = de ? `${v} %` : `${v}%`;
	const out = (title, level, text = ev.detail) => ({ title, text: text ? String(text) : "", level, ...(ev.url ? { url: ev.url } : {}) });
	switch (ev.kind) {
		case "down":
			return out(t(`${name} läuft nicht`, `${name} is down`), "down");
		case "up":
			return out(t(`${name} läuft wieder`, `${name} is back up`), "up");
		case "slow":
			return out(t(`${name} antwortet langsam`, `${name} is slow`) + (has ? ` (${v} ms)` : ""), "warn");
		case "cert":
			if (has && v < 0) return out(t(`Zertifikat von ${name} ist abgelaufen`, `Certificate for ${name} has expired`), "down");
			if (!has) return out(t(`Zertifikat von ${name} läuft bald ab`, `Certificate for ${name} expires soon`), "warn");
			if (v === 0) return out(t(`Zertifikat von ${name} läuft heute ab`, `Certificate for ${name} expires today`), "warn");
			return out(t(`Zertifikat von ${name} läuft in ${v} ${v === 1 ? "Tag" : "Tagen"} ab`, `Certificate for ${name} expires in ${v} ${v === 1 ? "day" : "days"}`), "warn");
		case "disk":
			return out(t(`Speicher ${name} zu ${pct} voll`, `Storage ${name} is ${pct} full`), "warn");
		case "temp":
			return out(t(`CPU-Temperatur ${v} °C`, `CPU temperature ${v} °C`), "warn");
		case "memory":
			return out(t(`Arbeitsspeicher zu ${pct} belegt`, `Memory ${pct} used`), "warn");
		case "restarts":
			return out(t(`Container ${name} startet ständig neu`, `Container ${name} keeps restarting`), "warn", ev.detail || (has ? t(`${v} Neustarts`, `${v} restarts`) : ""));
		case "test":
			return out(t("Test von HomeBento", "Test from HomeBento"), "test", ev.detail || t("Wenn du das liest, kommen die Benachrichtigungen an.", "If you can read this, notifications work."));
		default:
			return out(name, "info");
	}
}

module.exports = { CHANNELS, send, format, API };
