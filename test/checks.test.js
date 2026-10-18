"use strict";
// The check types against local servers: HTTP, TCP, a tiny fake DNS server over UDP,
// a TLS server with a certificate made by openssl at test time, and ping to 127.0.0.1.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const dgram = require("node:dgram");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const checks = require("../lib/checks");

let base;
let server;

test.before(async () => {
	server = http.createServer((req, res) => {
		if (req.url === "/page") return res.end("<html><body>Welcome to the NAS</body></html>");
		if (req.url === "/teapot") return res.writeHead(418).end("short and stout");
		if (req.url === "/locked") return res.writeHead(401).end("login");
		if (req.url === "/broken") return res.writeHead(500).end("oops");
		if (req.url === "/hop") return res.writeHead(302, { Location: "/page" }).end();
		if (req.url === "/loop") return res.writeHead(302, { Location: "/loop" }).end();
		if (req.url === "/big") {
			res.write("x".repeat(3 * 1024 * 1024));
			return res.end("needle");
		}
		res.writeHead(404).end("not here");
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test("http: up, keyword found, missing and absent", async () => {
	const up = await checks.http(`${base}/page`);
	assert.equal(up.status, "up");
	assert.equal(up.code, 200);
	assert.equal(typeof up.ms, "number");
	assert.equal((await checks.http(`${base}/page`, { keyword: "welcome to" })).status, "up");
	const missing = await checks.http(`${base}/page`, { keyword: "Error" });
	assert.equal(missing.status, "down");
	assert.equal(missing.error, 'Text "Error" not found');
	assert.equal((await checks.http(`${base}/page`, { keyword: "Error", keywordAbsent: true })).status, "up");
	const present = await checks.http(`${base}/page`, { keyword: "nas", keywordAbsent: true });
	assert.equal(present.status, "down");
	assert.equal(present.error, 'Text "nas" found');
	// only the first 2 MB are read, without failing the check
	const big = await checks.http(`${base}/big`, { keyword: "needle" });
	assert.equal(big.status, "down");
	assert.equal(big.error, 'Text "needle" not found');
});

test("http: status codes, server errors and redirects", async () => {
	assert.equal((await checks.http(`${base}/locked`)).status, "up");
	assert.equal((await checks.http(`${base}/locked`, { codes: "200-299,401" })).status, "up");
	const teapot = await checks.http(`${base}/teapot`, { codes: "200-299,401" });
	assert.equal(teapot.status, "down");
	assert.equal(teapot.code, 418);
	assert.equal(teapot.error, "HTTP 418");
	const broken = await checks.http(`${base}/broken`);
	assert.deepEqual([broken.status, broken.code, broken.error], ["down", 500, "HTTP 500"]);
	const hop = await checks.http(`${base}/hop`, { keyword: "welcome" });
	assert.deepEqual([hop.status, hop.code], ["up", 200]);
	const loop = await checks.http(`${base}/loop`, { codes: "200" });
	assert.deepEqual([loop.status, loop.code], ["down", 302]);
	assert.equal((await checks.http("ftp://example.com")).error, "Invalid address");
});

test("tcp: open port up, closed port down quickly", async () => {
	const srv = net.createServer((s) => s.end());
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const port = srv.address().port;
	const open = await checks.tcp("127.0.0.1", port, { timeout: 2000 });
	assert.equal(open.status, "up");
	assert.equal(typeof open.ms, "number");
	await new Promise((r) => srv.close(r));
	const t0 = Date.now();
	const closed = await checks.tcp("127.0.0.1", port, { timeout: 5000 });
	assert.equal(closed.status, "down");
	assert.equal(closed.error, "Connection refused");
	assert.ok(Date.now() - t0 < 1000);
	assert.equal((await checks.tcp("127.0.0.1", 70000)).error, "Invalid address");
});

// A fake DNS server: answers A queries for nas.home with 192.168.1.10, NXDOMAIN for other names.
function fakeDns() {
	const sock = dgram.createSocket("udp4");
	sock.on("message", (q, rinfo) => {
		let i = 12;
		const labels = [];
		while (q[i]) {
			labels.push(q.subarray(i + 1, i + 1 + q[i]).toString());
			i += q[i] + 1;
		}
		const question = q.subarray(12, i + 5);
		const qtype = q.readUInt16BE(i + 1);
		const known = labels.join(".").toLowerCase() === "nas.home";
		const answer = known && qtype === 1 ? Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 192, 168, 1, 10]) : Buffer.alloc(0);
		const head = Buffer.alloc(12);
		q.copy(head, 0, 0, 2);
		head.writeUInt16BE(known ? 0x8180 : 0x8183, 2);
		head.writeUInt16BE(1, 4);
		head.writeUInt16BE(answer.length ? 1 : 0, 6);
		sock.send(Buffer.concat([head, question, answer]), rinfo.port, rinfo.address);
	});
	return new Promise((r) => sock.bind(0, "127.0.0.1", () => r(sock)));
}

test("dns: answers, expected value, missing names", async () => {
	const sock = await fakeDns();
	const server = `127.0.0.1:${sock.address().port}`;
	try {
		const ok = await checks.dns("nas.home", { server });
		assert.equal(ok.status, "up");
		assert.equal(ok.detail, "192.168.1.10");
		assert.equal((await checks.dns("nas.home", { server, expect: "192.168.1.10" })).status, "up");
		const wrong = await checks.dns("nas.home", { server, expect: "192.168.1.99" });
		assert.equal(wrong.status, "down");
		assert.match(wrong.error, /Expected "192.168.1.99", got 192.168.1.10/);
		const none = await checks.dns("nas.home", { server, type: "AAAA" });
		assert.deepEqual([none.status, none.error], ["down", "No answer"]);
		const unknown = await checks.dns("missing.home", { server });
		assert.deepEqual([unknown.status, unknown.error], ["down", "Name not found"]);
		assert.equal((await checks.dns("a;b", { server })).error, "Invalid name");
		assert.equal((await checks.dns("nas.home", { server, type: "ANY" })).status, "down");
	} finally {
		sock.close();
	}
});

test("certificate: self-signed certificate of a local TLS server", async (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-cert-"));
	const key = path.join(dir, "key.pem");
	const crt = path.join(dir, "cert.pem");
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "30", "-subj", "/CN=localhost"], { stdio: "ignore" });
	} catch {
		fs.rmSync(dir, { recursive: true, force: true });
		return t.skip("openssl not available");
	}
	const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (req, res) => res.end("hi"));
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const port = srv.address().port;
	try {
		const r = await checks.certificate(`https://localhost:${port}/x`, { timeout: 3000 });
		assert.equal(r.status, "up");
		assert.equal(r.cert.subject, "localhost");
		assert.equal(r.cert.selfSigned, true);
		assert.equal(r.cert.valid, false);
		assert.ok(r.cert.daysLeft >= 29 && r.cert.daysLeft <= 30, `daysLeft ${r.cert.daysLeft}`);
		assert.ok(r.cert.validTo > Date.now());
		assert.equal((await checks.certificate(`127.0.0.1:${port}`)).status, "up");
		// self-signed is accepted by default, refused when insecure is false
		assert.equal((await checks.http(`https://127.0.0.1:${port}/`, { insecure: true })).status, "up");
		assert.equal((await checks.http(`https://127.0.0.1:${port}/`)).error, "Certificate not trusted");
	} finally {
		await new Promise((r) => srv.close(r));
		fs.rmSync(dir, { recursive: true, force: true });
	}
	const closed = await checks.certificate(`127.0.0.1:${port}`, { timeout: 2000 });
	assert.deepEqual([closed.status, closed.error], ["down", "Connection refused"]);
});

test("ping: 127.0.0.1 answers", async (t) => {
	const r = await checks.ping("127.0.0.1", { timeout: 2000 });
	if (r.note) return t.skip(`ping not permitted here (${r.note})`);
	assert.equal(r.status, "up");
	assert.equal(typeof r.ms, "number");
});

test("ping: falls back to TCP without a ping command", async () => {
	// port 80/443/22 on 127.0.0.1 either accept or refuse: both prove the host is there
	const r = await checks.ping("127.0.0.1", { timeout: 2000, command: "/nonexistent/ping" });
	assert.equal(r.status, "up");
	assert.match(r.note, /checked with TCP/);
});

test("host validation keeps options and shell syntax out of the ping command", async () => {
	for (const bad of ["-c", "a;b", "a b", "$(id)", "a|b", "", "x".repeat(300)]) {
		assert.equal(checks.validHost(bad), false, bad);
		assert.deepEqual(await checks.ping(bad), { status: "down", ms: null, error: "Invalid host" });
	}
	for (const good of ["nas", "nas.home", "my_db", "192.168.0.1", "::1", "fritz.box."]) assert.equal(checks.validHost(good), true, good);
});

test("parseTarget and run", async () => {
	const p = checks.parseTarget;
	assert.deepEqual(p({ url: "http://nas:5000" }), { type: "http", url: "http://nas:5000" });
	assert.deepEqual(p({ checkType: "tcp", checkTarget: "192.168.0.1:22" }), { type: "tcp", host: "192.168.0.1", port: 22 });
	assert.deepEqual(p({ checkType: "tcp", url: "https://nas" }), { type: "tcp", host: "nas", port: 443 });
	assert.deepEqual(p({ checkType: "tcp", url: "http://nas:8080/x", checkTarget: "22" }), { type: "tcp", host: "nas", port: 22 });
	assert.deepEqual(p({ checkType: "tcp", checkTarget: "[fd00::1]:53" }), { type: "tcp", host: "fd00::1", port: 53 });
	assert.equal(p({ checkType: "tcp", checkTarget: "nas" }).error, "Port missing");
	assert.deepEqual(p({ checkType: "ping", url: "http://[fd00::2]:8080/" }), { type: "ping", host: "fd00::2" });
	assert.deepEqual(p({ checkType: "ping", checkTarget: "router", url: "http://nas" }), { type: "ping", host: "router" });
	assert.deepEqual(p({ checkType: "dns", checkTarget: "nas.home", dnsServer: "192.168.1.2", dnsExpect: "192.168.1.10" }), { type: "dns", name: "nas.home", server: "192.168.1.2", recordType: "A", expect: "192.168.1.10" });
	assert.match(p({ checkType: "smtp", url: "http://x" }).error, /Unknown check type/);

	assert.deepEqual(await checks.run({ name: "no address" }), { status: "unknown", ms: null });
	assert.equal((await checks.run({ url: `${base}/page` })).status, "up");
	const kw = await checks.run({ url: `${base}/page`, checkType: "keyword", keyword: "missing" });
	assert.equal(kw.error, 'Text "missing" not found');
	assert.equal((await checks.run({ url: `${base}/teapot`, codes: "200-299" })).status, "down");
	const port = new URL(base).port;
	assert.equal((await checks.run({ url: "http://example.invalid", checkType: "tcp", checkTarget: `127.0.0.1:${port}` })).status, "up");
	assert.equal((await checks.run({ checkType: "tcp", checkTarget: "nas" })).error, "Port missing");
});
