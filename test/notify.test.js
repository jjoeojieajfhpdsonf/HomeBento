"use strict";
// Notifications against small fake servers: one HTTP server answers like ntfy, Gotify,
// Telegram, Pushover, Discord, Slack and a webhook; a net server speaks just enough SMTP.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { send, format, CHANNELS } = require("../lib/notify");

let base;
let server;
const seen = [];
const answers = {}; // path -> [status, body]

test.before(async () => {
	server = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const u = new URL(req.url, "http://x");
			seen.push({ method: req.method, path: u.pathname, search: u.search, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
			const [status, body] = answers[u.pathname] || [200, "{}"];
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(typeof body === "string" ? body : JSON.stringify(body));
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const last = () => seen[seen.length - 1];
const down = { title: "Jellyfin läuft nicht", text: "Connection refused", level: "down", url: "http://jellyfin.home:8096/" };
const api = () => ({ api: { telegram: base, pushover: base } });
const decodeWords = (s) => s.replace(/\r\n /g, " ").replace(/=\?UTF-8\?B\?([^?]*)\?=\s*/g, (_, b) => Buffer.from(b, "base64").toString("utf8")).trim();

test("CHANNELS: every type has a label and fields with German and English labels", () => {
	assert.deepEqual(Object.keys(CHANNELS), ["ntfy", "gotify", "telegram", "pushover", "discord", "slack", "webhook", "email"]);
	for (const [type, ch] of Object.entries(CHANNELS)) {
		assert.ok(ch.label, type);
		for (const f of ch.fields) {
			assert.ok(f.key && typeof f.secret === "boolean", `${type}.${f.key}`);
			const label = typeof f.label === "string" ? { de: f.label, en: f.label } : f.label;
			assert.ok(label.de && label.en, `${type}.${f.key}`);
		}
	}
	assert.equal(CHANNELS.email.fields.find((f) => f.key === "password").secret, true);
});

test("ntfy: text body, title, tags, priority, click and bearer token", async () => {
	assert.deepEqual(await send({ type: "ntfy", url: `${base}/alerts`, token: "tk_abc" }, down), { ok: true });
	const r = last();
	assert.equal(r.method, "POST");
	assert.equal(r.path, "/alerts");
	assert.equal(r.body, "Connection refused");
	assert.equal(decodeWords(r.headers.title), "Jellyfin läuft nicht");
	assert.equal(r.headers.tags, "warning");
	assert.equal(r.headers.priority, "high");
	assert.equal(r.headers.click, "http://jellyfin.home:8096/");
	assert.equal(r.headers.authorization, "Bearer tk_abc");

	await send({ type: "ntfy", url: `${base}/alerts` }, { title: "Jellyfin is back up", level: "up" });
	assert.equal(last().headers.title, "Jellyfin is back up");
	assert.equal(last().headers.tags, "white_check_mark");
	assert.equal(last().headers.priority, "default");
	assert.equal(last().headers.authorization, undefined);
	assert.equal(last().body, "Jellyfin is back up");

	answers["/locked"] = [403, { code: 40301, http: 403, error: "forbidden" }];
	await assert.rejects(send({ type: "ntfy", url: `${base}/locked` }, down), { message: "HTTP 403 – check the token" });
	answers["/gone"] = [500, { error: "internal error" }];
	await assert.rejects(send({ type: "ntfy", url: `${base}/gone` }, down), { message: "HTTP 500 – internal error" });
	await assert.rejects(send({ type: "ntfy", url: "ntfy.sh/x" }, down), /must start with http/);
	await assert.rejects(send({ type: "ntfy", url: "" }, down), { message: "URL missing" });
});

test("Gotify: JSON with priority and click URL, token in the header", async () => {
	await send({ type: "gotify", url: `${base}/gotify/`, token: "AppTok" }, down);
	const r = last();
	assert.equal(r.path, "/gotify/message");
	assert.equal(r.headers["x-gotify-key"], "AppTok");
	assert.deepEqual(JSON.parse(r.body), { title: "Jellyfin läuft nicht", message: "Connection refused", priority: 8, extras: { "client::notification": { click: { url: "http://jellyfin.home:8096/" } } } });
	await send({ type: "gotify", url: `${base}/gotify`, token: "AppTok" }, { title: "Disk", text: "92 %", level: "warn" });
	assert.equal(JSON.parse(last().body).priority, 5);
	assert.equal(JSON.parse(last().body).extras, undefined);
	answers["/bad/message"] = [401, { error: "Unauthorized", errorCode: 401, errorDescription: "you need to provide a valid access token" }];
	await assert.rejects(send({ type: "gotify", url: `${base}/bad`, token: "x" }, down), { message: "HTTP 401 – check the token" });
	await assert.rejects(send({ type: "gotify", url: base }, down), { message: "App token missing" });
});

test("Telegram: HTML message with escaped text, errors from the description", async () => {
	answers["/bot123:ABC-def/sendMessage"] = [200, { ok: true, result: { message_id: 1 } }];
	await send({ type: "telegram", token: "123:ABC-def", chatId: "-1001" }, { title: "A <b> & C", text: "x < y", level: "down", url: "http://a/?q=1&r=2" }, api());
	const r = last();
	assert.equal(r.path, "/bot123:ABC-def/sendMessage");
	assert.deepEqual(JSON.parse(r.body), { chat_id: "-1001", text: "<b>A &lt;b&gt; &amp; C</b>\nx &lt; y\nhttp://a/?q=1&amp;r=2", parse_mode: "HTML", disable_web_page_preview: true });

	answers["/bot123:ABC-def/sendMessage"] = [400, { ok: false, error_code: 400, description: "Bad Request: chat not found" }];
	await assert.rejects(send({ type: "telegram", token: "123:ABC-def", chatId: "1" }, down, api()), { message: "Telegram: chat not found" });
	answers["/bot9:bad/sendMessage"] = [401, { ok: false, error_code: 401, description: "Unauthorized" }];
	await assert.rejects(send({ type: "telegram", token: "9:bad", chatId: "1" }, down, api()), { message: "Telegram: unauthorized – check the bot token" });
	await assert.rejects(send({ type: "telegram", token: "1:a/../x", chatId: "1" }, down, api()), /token looks wrong/);
	answers["/bot1:ok/sendMessage"] = [200, { ok: true, result: {} }];
	await send({ type: "telegram", token: "1:ok", chatId: "1" }, down, api());
});

test("Pushover: form body with priority 1 for down, errors from the answer", async () => {
	answers["/1/messages.json"] = [200, { status: 1, request: "x" }];
	await send({ type: "pushover", user: "uKey", token: "aTok" }, down, api());
	const f = new URLSearchParams(last().body);
	assert.equal(last().headers["content-type"], "application/x-www-form-urlencoded");
	assert.equal(f.get("token"), "aTok");
	assert.equal(f.get("user"), "uKey");
	assert.equal(f.get("title"), "Jellyfin läuft nicht");
	assert.equal(f.get("message"), "Connection refused");
	assert.equal(f.get("priority"), "1");
	assert.equal(f.get("url"), "http://jellyfin.home:8096/");
	answers["/1/messages.json"] = [400, { user: "invalid", errors: ["user identifier is not a valid user, group, or subscribed user key"], status: 0 }];
	await assert.rejects(send({ type: "pushover", user: "bad", token: "aTok" }, down, api()), { message: "Pushover: user identifier is not a valid user, group, or subscribed user key" });
});

test("Discord, Slack and webhook", async () => {
	answers["/discord"] = [204, ""];
	await send({ type: "discord", url: `${base}/discord` }, down);
	const e = JSON.parse(last().body).embeds[0];
	assert.equal(e.title, "Jellyfin läuft nicht");
	assert.equal(e.description, "Connection refused");
	assert.equal(e.color, 0xe5484d);
	assert.equal(e.url, "http://jellyfin.home:8096/");
	await send({ type: "discord", url: `${base}/discord` }, { title: "Back", level: "up" });
	assert.equal(JSON.parse(last().body).embeds[0].color, 0x30a46c);
	answers["/discord-gone"] = [404, { message: "Unknown Webhook", code: 10015 }];
	await assert.rejects(send({ type: "discord", url: `${base}/discord-gone` }, down), { message: "HTTP 404 – Unknown Webhook" });

	answers["/slack"] = [200, "ok"];
	await send({ type: "slack", url: `${base}/slack` }, down);
	assert.deepEqual(JSON.parse(last().body), { text: "*Jellyfin läuft nicht*\nConnection refused\n<http://jellyfin.home:8096/>" });
	answers["/slack-bad"] = [400, "invalid_payload"];
	await assert.rejects(send({ type: "slack", url: `${base}/slack-bad` }, down), { message: "HTTP 400 – invalid_payload" });

	await send({ type: "webhook", url: `${base}/hook`, headerName: "X-Auth", headerValue: "hush" }, { title: "T", text: "x", level: "warn" });
	const r = last();
	assert.equal(r.headers["x-auth"], "hush");
	const b = JSON.parse(r.body);
	assert.deepEqual({ ...b, at: undefined }, { title: "T", text: "x", level: "warn", url: null, at: undefined });
	assert.ok(!Number.isNaN(Date.parse(b.at)));
	await assert.rejects(send({ type: "webhook", url: `${base}/hook`, headerName: "Bad Header" }, down), { message: "Invalid header name" });
	await assert.rejects(send({ type: "nope" }, down), { message: "Unknown channel type: nope" });
});

test("unreachable server and non-http links", async () => {
	const port = await closedPort();
	await assert.rejects(send({ type: "ntfy", url: `http://127.0.0.1:${port}/t` }, down), { message: "Connection refused" });
	await send({ type: "webhook", url: `${base}/hook` }, { title: "T", url: "javascript:alert(1)" });
	assert.equal(JSON.parse(last().body).url, null);
});

// ---- SMTP ----

const closedPort = () =>
	new Promise((resolve) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

// A fake SMTP server. Records each session: commands, raw DATA lines and the message.
async function fakeSmtp({ auth = "PLAIN LOGIN", eightBit = true, user = "joel", pass = "s3cret" } = {}) {
	const sessions = [];
	const srv = net.createServer((sock) => {
		const s = { commands: [], raw: [], message: null };
		sessions.push(s);
		let buf = "";
		let inData = false;
		let login = null;
		const say = (t) => sock.write(`${t}\r\n`);
		const check = (u, p) => say(u === user && p === pass ? "235 2.7.0 Authentication successful" : "535 5.7.8 Authentication credentials invalid");
		say("220-fake.smtp ESMTP\r\n220 ready");
		sock.on("data", (d) => {
			buf += d.toString("utf8");
			let i;
			while ((i = buf.indexOf("\r\n")) >= 0) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 2);
				if (inData) {
					if (line === ".") {
						inData = false;
						s.message = s.raw.map((l) => (l.startsWith(".") ? l.slice(1) : l)).join("\r\n");
						say("250 2.0.0 Ok: queued");
					} else s.raw.push(line);
					continue;
				}
				s.commands.push(line);
				if (login) {
					login.push(Buffer.from(line, "base64").toString());
					if (login.length === 1) say("334 UGFzc3dvcmQ6");
					else {
						check(login[0], login[1]);
						login = null;
					}
					continue;
				}
				const verb = line.split(" ")[0].toUpperCase();
				if (verb === "EHLO") {
					// split over two packets, as real servers sometimes do
					sock.write(`250-fake.smtp\r\n${eightBit ? "250-8BITMIME\r\n" : ""}`);
					setTimeout(() => say(`250-AUTH ${auth}\r\n250 SIZE 10240000`), 20);
				} else if (verb === "AUTH" && /^AUTH PLAIN /i.test(line) && auth.includes("PLAIN")) {
					const [, u, p] = Buffer.from(line.slice(11), "base64").toString().split("\0");
					check(u, p);
				} else if (verb === "AUTH" && /^AUTH LOGIN$/i.test(line) && auth.includes("LOGIN")) {
					login = [];
					say("334 VXNlcm5hbWU6");
				} else if (verb === "AUTH") say("504 5.5.4 Unrecognized authentication type");
				else if (verb === "MAIL" || verb === "RCPT") say("250 2.1.0 Ok");
				else if (verb === "DATA") {
					inData = true;
					say("354 End data with <CR><LF>.<CR><LF>");
				} else if (verb === "QUIT") {
					say("221 2.0.0 Bye");
					sock.end();
				} else say("502 5.5.2 Error: command not recognized");
			}
		});
		sock.on("error", () => {});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	return { port: srv.address().port, sessions, close: () => srv.close() };
}

const headersOf = (message) => {
	const head = message.slice(0, message.indexOf("\r\n\r\n")).replace(/\r\n[ \t]/g, " ");
	return Object.fromEntries(head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
};
const bodyOf = (message) => message.slice(message.indexOf("\r\n\r\n") + 4);
const mail = (port, extra = {}) => ({ type: "email", host: "127.0.0.1", port: String(port), security: "none", user: "joel", password: "s3cret", from: "HomeBento <homebento@example.com>", to: "a@example.com, B <b@example.com>", ...extra });

test("SMTP: AUTH PLAIN, MAIL/RCPT/DATA with headers, 8bit body and dot-stuffing", async () => {
	const smtp = await fakeSmtp();
	try {
		assert.deepEqual(await send(mail(smtp.port), { title: "Jellyfin läuft nicht", text: "Verbindung abgelehnt – Port 8096\n.Punkt am Zeilenanfang", level: "down", url: "http://jellyfin.home/" }), { ok: true });
		const s = smtp.sessions[0];
		assert.match(s.commands[0], /^EHLO \[127\.0\.0\.1\]$/);
		assert.equal(Buffer.from(s.commands[1].slice(11), "base64").toString(), "\0joel\0s3cret");
		assert.deepEqual(s.commands.slice(2), ["MAIL FROM:<homebento@example.com> BODY=8BITMIME", "RCPT TO:<a@example.com>", "RCPT TO:<b@example.com>", "DATA", "QUIT"]);
		assert.ok(s.raw.includes("..Punkt am Zeilenanfang"), "dot-stuffed on the wire");
		const h = headersOf(s.message);
		assert.equal(h.from, "HomeBento <homebento@example.com>");
		assert.equal(h.to, "a@example.com, B <b@example.com>");
		assert.match(h.subject, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
		assert.equal(decodeWords(h.subject), "Jellyfin läuft nicht");
		assert.ok(!Number.isNaN(Date.parse(h.date)));
		assert.match(h["message-id"], /^<[\w.]+@example\.com>$/);
		assert.equal(h["mime-version"], "1.0");
		assert.equal(h["content-type"], "text/plain; charset=utf-8");
		assert.equal(h["content-transfer-encoding"], "8bit");
		assert.equal(bodyOf(s.message), "Verbindung abgelehnt – Port 8096\r\n.Punkt am Zeilenanfang\r\n\r\nhttp://jellyfin.home/");
	} finally {
		smtp.close();
	}
});

test("SMTP: base64 without 8BITMIME, long subject in several encoded words, AUTH LOGIN fallback", async () => {
	const smtp = await fakeSmtp({ auth: "LOGIN", eightBit: false });
	try {
		const title = "Zertifikat von Nextcloud läuft in 9 Tagen ab – bitte rechtzeitig erneuern, sonst gibt es Ärger";
		await send(mail(smtp.port, { to: "a@example.com" }), { title, text: "Grüße\naus dem Keller", level: "warn" });
		const s = smtp.sessions[0];
		assert.equal(s.commands[1], "AUTH LOGIN");
		assert.equal(s.commands[4], "MAIL FROM:<homebento@example.com>");
		const subjectLines = s.raw.slice(s.raw.findIndex((l) => l.startsWith("Subject:"))).filter((l, i) => i === 0 || l.startsWith(" "));
		assert.ok(subjectLines.length > 1 && subjectLines.length < 6, "folded");
		for (const l of subjectLines) assert.ok(l.replace(/^Subject: /, "").trim().length <= 75);
		const h = headersOf(s.message);
		assert.equal(decodeWords(h.subject), title);
		assert.equal(h["content-transfer-encoding"], "base64");
		assert.equal(Buffer.from(bodyOf(s.message), "base64").toString("utf8"), "Grüße\r\naus dem Keller");
	} finally {
		smtp.close();
	}
});

test("SMTP: failed login reports the server's text, never the password", async () => {
	const smtp = await fakeSmtp();
	try {
		await assert.rejects(send(mail(smtp.port, { password: "wrong-pw" }), down), (err) => {
			assert.match(err.message, /^SMTP: authentication failed \(535 5\.7\.8 Authentication credentials invalid\)$/);
			assert.ok(!err.message.includes("wrong-pw"));
			return true;
		});
		assert.ok(!smtp.sessions[0].commands.some((c) => c.startsWith("MAIL")));
	} finally {
		smtp.close();
	}
});

test("SMTP: no password over an unencrypted connection unless chosen; plain relay without login", async () => {
	const smtp = await fakeSmtp();
	try {
		await assert.rejects(send(mail(smtp.port, { security: "auto" }), down), /SMTP: the server offers no encryption/);
		await assert.rejects(send(mail(smtp.port, { security: "starttls" }), down), { message: "SMTP: the server does not offer STARTTLS" });
		await send(mail(smtp.port, { security: "auto", user: "", password: "" }), { title: "Test from HomeBento", text: "plain ascii", level: "test" });
		const s = smtp.sessions[2];
		assert.ok(!s.commands.some((c) => c.startsWith("AUTH")));
		assert.equal(headersOf(s.message).subject, "Test from HomeBento");
		assert.equal(headersOf(s.message)["content-transfer-encoding"], "7bit");
	} finally {
		smtp.close();
	}
});

test("SMTP: refused connections, also with implicit TLS; bad input", async () => {
	const port = await closedPort();
	await assert.rejects(send(mail(port, { security: "tls" }), down), { message: "SMTP: connection refused" });
	await assert.rejects(send(mail(port, { security: "auto" }), down), { message: "SMTP: connection refused" });
	await assert.rejects(send(mail(port, { to: " , " }), down), { message: "Recipient missing" });
	await assert.rejects(send(mail(port, { to: "not-an-address" }), down), /Invalid e-mail address/);
	await assert.rejects(send(mail(port, { host: "" }), down), { message: "SMTP server missing" });
});

test("SMTP: a server that is not SMTP gives a clear error", async () => {
	const srv = net.createServer((sock) => sock.end("HTTP/1.1 400 Bad Request\r\n\r\n"));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	try {
		await assert.rejects(send(mail(srv.address().port), down), /^Error: SMTP: unexpected answer from the server: HTTP\/1\.1 400/);
	} finally {
		srv.close();
	}
});

test("format: monitor events in German and English", () => {
	assert.deepEqual(format({ kind: "down", name: "Jellyfin", detail: "Connection refused" }, "de"), { title: "Jellyfin läuft nicht", text: "Connection refused", level: "down" });
	assert.deepEqual(format({ kind: "down", name: "Jellyfin", detail: "Connection refused" }, "en"), { title: "Jellyfin is down", text: "Connection refused", level: "down" });
	assert.equal(format({ kind: "up", name: "Jellyfin" }, "de").title, "Jellyfin läuft wieder");
	assert.equal(format({ kind: "up", name: "Jellyfin" }, "en").level, "up");
	assert.equal(format({ kind: "slow", name: "Sonarr", value: 2345.6 }, "en").title, "Sonarr is slow (2346 ms)");
	assert.equal(format({ kind: "cert", name: "nas.home", value: 9 }, "de").title, "Zertifikat von nas.home läuft in 9 Tagen ab");
	assert.equal(format({ kind: "cert", name: "nas.home", value: 1 }, "en").title, "Certificate for nas.home expires in 1 day");
	assert.equal(format({ kind: "cert", name: "nas.home", value: -2 }, "de").level, "down");
	assert.equal(format({ kind: "disk", name: "/mnt/media", value: 92 }, "de").title, "Speicher /mnt/media zu 92 % voll");
	assert.equal(format({ kind: "disk", name: "/mnt/media", value: 92 }, "en").title, "Storage /mnt/media is 92% full");
	assert.equal(format({ kind: "temp", value: 84.2 }, "de").title, "CPU-Temperatur 84 °C");
	assert.equal(format({ kind: "memory", value: 91 }, "en").title, "Memory 91% used");
	assert.deepEqual(format({ kind: "restarts", name: "jellyfin", value: 5 }, "de"), { title: "Container jellyfin startet ständig neu", text: "5 Neustarts", level: "warn" });
	assert.equal(format({ kind: "test" }, "de").title, "Test von HomeBento");
	assert.equal(format({ kind: "test" }, "en").level, "test");
	assert.equal(format({ kind: "down", name: "X", url: "http://x" }).url, "http://x");
});
