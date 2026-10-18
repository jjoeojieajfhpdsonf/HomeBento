"use strict";
// Tailscale Serve against a fake tailscaled local API on a unix socket.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Tailscale, targetFor } = require("../lib/tailscale");

const DNS = "homeserver.tail1234.ts.net";
let config;
let etag;
let server;
let sock;

test.before(async () => {
	sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ts-")), "tailscaled.sock");
	// a site set up by hand on 443 that must survive every change
	config = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:8090" } } } } };
	etag = "v1";
	server = http.createServer((req, res) => {
		assert.equal(req.headers.host, "local-tailscaled.sock");
		const send = (status, body, headers = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(body === undefined ? "" : JSON.stringify(body));
		};
		if (req.url === "/localapi/v0/status") return send(200, { BackendState: "Running", Self: { DNSName: `${DNS}.` }, CurrentTailnet: { Name: "joel" }, CertDomains: [DNS] });
		if (req.url === "/localapi/v0/serve-config" && req.method === "GET") return send(200, config, { Etag: etag });
		if (req.url === "/localapi/v0/serve-config" && req.method === "POST") {
			if (req.headers["if-match"] !== etag) return send(412, undefined);
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				config = JSON.parse(body);
				etag = `v${Number(etag.slice(1)) + 1}`;
				send(200, undefined);
			});
			return;
		}
		send(404, undefined);
	});
	await new Promise((r) => server.listen(sock, r));
});
test.after(() => server.close());

test("target: same port on this machine, https services with their own certificate", () => {
	assert.deepEqual(targetFor("http://192.168.0.31:8096"), { port: 8096, target: "http://127.0.0.1:8096" });
	assert.deepEqual(targetFor("https://192.168.0.31:9443"), { port: 9443, target: "https+insecure://127.0.0.1:9443" });
});

test("add and remove a service, the hand-made entry stays", async () => {
	const ts = new Tailscale(sock);
	assert.equal(ts.available, true);
	const url = await ts.add(8096, "http://127.0.0.1:8096");
	assert.equal(url, `https://${DNS}:8096`);
	assert.deepEqual(config.Web[`${DNS}:8096`], { Handlers: { "/": { Proxy: "http://127.0.0.1:8096" } } });
	assert.deepEqual(config.TCP["8096"], { HTTPS: true });
	assert.deepEqual(config.Web[`${DNS}:443`].Handlers["/"].Proxy, "http://127.0.0.1:8090");
	const { list, status } = await ts.mappings();
	assert.equal(status.dnsName, DNS);
	assert.deepEqual(list.map((m) => `${m.port} ${m.url}`), [`443 https://${DNS}`, `8096 https://${DNS}:8096`]);
	assert.equal(await ts.remove(8096), true);
	assert.equal(config.Web[`${DNS}:8096`], undefined);
	assert.equal(config.TCP["8096"], undefined);
	assert.ok(config.Web[`${DNS}:443`], "443 untouched");
});

test("a port that serves something else is not taken over", async () => {
	const ts = new Tailscale(sock);
	await assert.rejects(ts.add(443, "http://127.0.0.1:9999"), /already used/);
	assert.equal(config.Web[`${DNS}:443`].Handlers["/"].Proxy, "http://127.0.0.1:8090");
});

test("no socket: not available", () => {
	assert.equal(new Tailscale(path.join(os.tmpdir(), "nope.sock")).available, false);
});
