"use strict";
// The network plugins (Pi-hole, AdGuard Home, Traefik, wg-easy, Nginx Proxy Manager, UniFi)
// against a small fake server that answers like their APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, json } = require("../lib/util");
const PLUGINS = require("../lib/plugins");

const DAY = 86400000;
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const sqlDate = (t) => new Date(t).toISOString().replace("T", " ").slice(0, 19);
let base;
let server;
const seen = [];

test.before(async () => {
	server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const url = new URL(req.url, "http://x");
			const p = url.pathname;
			seen.push(`${req.method} ${p}`);
			const body = raw ? JSON.parse(raw) : {};
			const send = (v, status = 200, headers = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers });
				res.end(JSON.stringify(v));
			};
			// Pi-hole v6
			if (p === "/ph6/api/auth" && req.method === "POST") {
				if (body.password === "web-pw" || body.password === "app-pw") return send({ session: { valid: true, totp: false, sid: "sid123", csrf: "c", validity: 1800, message: "app-password correct" }, took: 0.01 });
				return send({ session: { valid: false, totp: false, sid: null, validity: -1, message: "password incorrect" }, took: 0.01 }, 401);
			}
			if (p.startsWith("/ph6/api/")) {
				if (req.headers["x-ftl-sid"] !== "sid123") return send({ error: { key: "unauthorized", message: "Unauthorized", hint: null }, took: 0 }, 401);
				if (p === "/ph6/api/stats/summary") return send({ queries: { total: 24000, blocked: 3000, percent_blocked: 12.5, unique_domains: 900, forwarded: 15000, cached: 6000 }, clients: { active: 12, total: 20 }, gravity: { domains_being_blocked: 150000, last_update: 1700000000 }, took: 0.002 });
				if (p === "/ph6/api/dns/blocking") return send({ blocking: "disabled", timer: null, took: 0 });
			}
			// Pi-hole v5 (no /api/auth)
			if (p === "/ph5/admin/api.php" && url.searchParams.has("summaryRaw")) {
				if (url.searchParams.get("auth") !== "v5-token") return send([]);
				return send({ domains_being_blocked: 90000, dns_queries_today: 5000, ads_blocked_today: 500, ads_percentage_today: 10, unique_domains: 300, status: "enabled", gravity_last_updated: { absolute: 1700000000 } });
			}
			// AdGuard Home
			if (p.startsWith("/agh/control/")) {
				if (req.headers.authorization !== basic("admin", "agh-pw")) return send({}, 401);
				if (p === "/agh/control/stats") return send({ time_units: "hours", num_dns_queries: 2000, num_blocked_filtering: 500, num_replaced_safebrowsing: 0, num_replaced_parental: 0, avg_processing_time: 0.01, top_blocked_domains: [{ "ads.example.com": 120 }, { "track.example.net": 80 }] });
				if (p === "/agh/control/status") return send({ dns_addresses: ["192.168.1.2"], dns_port: 53, http_port: 80, protection_enabled: false, running: true, version: "v0.107.52", language: "en" });
			}
			// Traefik
			if (p === "/traefik/api/overview") return send({ http: { routers: { total: 12, warnings: 0, errors: 1 }, services: { total: 10, warnings: 0, errors: 0 }, middlewares: { total: 4, warnings: 0, errors: 0 } }, tcp: { routers: { total: 1, warnings: 0, errors: 0 }, services: { total: 1, warnings: 0, errors: 0 } }, udp: { routers: { total: 0, warnings: 0, errors: 0 }, services: { total: 0, warnings: 0, errors: 0 } }, features: {}, providers: ["Docker"] });
			if (p === "/traefik/api/version") return send({ Version: "3.1.4", Codename: "comte" });
			if (p === "/traefik/api/http/routers") return send([{ name: "app@docker", rule: "Host(`app.home`)", status: "enabled", service: "app" }, { name: "broken@docker", rule: "Host(`x.home`)", status: "disabled", error: ["the service \"missing@docker\" does not exist"], service: "missing" }]);
			// wg-easy v14
			if (p === "/wg14/api/session" && req.method === "POST") {
				if (body.password !== "wg-pw") return send({ error: "Incorrect Password" }, 401);
				return send({ success: true }, 200, { "Set-Cookie": ["connect.sid=s%3Aabc; Path=/; HttpOnly"] });
			}
			if (p === "/wg14/api/wireguard/client") {
				if (req.headers.cookie !== "connect.sid=s%3Aabc") return send({ error: "Not Logged In" }, 401);
				return send([
					{ id: "1", name: "Phone", enabled: true, address: "10.8.0.2", latestHandshakeAt: new Date(Date.now() - 30000).toISOString(), transferRx: 1_500_000_000, transferTx: 300_000_000 },
					{ id: "2", name: "Laptop", enabled: true, address: "10.8.0.3", latestHandshakeAt: new Date(Date.now() - 3600000).toISOString(), transferRx: 200_000_000, transferTx: 0 },
					{ id: "3", name: "Old", enabled: false, address: "10.8.0.4", latestHandshakeAt: null, transferRx: null, transferTx: null }
				]);
			}
			// wg-easy v15
			if (p === "/wg15/api/client") {
				if (req.headers.authorization !== basic("joel", "wg15-pw")) return send({ statusCode: 401, message: "Not logged in" }, 401);
				return send([{ id: 1, name: "Tablet", enabled: true, ipv4Address: "10.8.0.5", latestHandshakeAt: new Date(Date.now() - 60000).toISOString(), transferRx: 5000, transferTx: 7000 }]);
			}
			// Nginx Proxy Manager
			if (p === "/npm/api/tokens" && req.method === "POST") {
				if (body.identity !== "me@home.lan" || body.secret !== "npm-pw") return send({ error: { code: 401, message: "Invalid email or password" } }, 401);
				return send({ token: "jwt-token", expires: new Date(Date.now() + DAY).toISOString() });
			}
			if (p.startsWith("/npm/api/nginx/")) {
				if (req.headers.authorization !== "Bearer jwt-token") return send({ error: { code: 401, message: "Unauthorized" } }, 401);
				if (p === "/npm/api/nginx/proxy-hosts")
					return send([
						{ id: 1, domain_names: ["jellyfin.home.lan"], forward_scheme: "http", forward_host: "10.0.0.5", forward_port: 8096, enabled: true, certificate_id: 1, meta: { nginx_online: true, nginx_err: null } },
						{ id: 2, domain_names: ["old.home.lan"], forward_scheme: "http", forward_host: "10.0.0.6", forward_port: 80, enabled: false, certificate_id: 0, meta: { nginx_online: true, nginx_err: null } },
						{ id: 3, domain_names: ["cloud.home.lan"], forward_scheme: "https", forward_host: "10.0.0.7", forward_port: 443, enabled: 1, certificate_id: 2, meta: { nginx_online: true, nginx_err: null } }
					]);
				if (p === "/npm/api/nginx/certificates")
					return send([
						{ id: 1, provider: "letsencrypt", nice_name: "jellyfin.home.lan", domain_names: ["jellyfin.home.lan"], expires_on: sqlDate(Date.now() + 5 * DAY + 3600000) },
						{ id: 2, provider: "letsencrypt", nice_name: "cloud.home.lan", domain_names: ["cloud.home.lan"], expires_on: new Date(Date.now() + 60 * DAY).toISOString() }
					]);
			}
			// UniFi OS
			const health = [
				{ subsystem: "wlan", num_user: 20, num_guest: 2, num_iot: 0, num_ap: 3, num_adopted: 3, num_disabled: 0, num_disconnected: 1, num_pending: 0, status: "warning" },
				{ subsystem: "wan", num_gw: 1, num_adopted: 1, wan_ip: "203.0.113.7", status: "ok" },
				{ subsystem: "www", status: "ok" },
				{ subsystem: "lan", num_user: 10, num_guest: 0, num_sw: 2, num_adopted: 2, num_disconnected: 0, lan_ip: "192.168.1.1", status: "ok" },
				{ subsystem: "vpn", status: "unknown" }
			];
			if (p === "/udm/") return send({}, 200, { "X-CSRF-Token": "csrf" });
			if (p === "/udm/api/auth/login" && req.method === "POST") {
				if (body.username !== "local" || body.password !== "uni-pw") return send({ code: "AUTHENTICATION_FAILED_INVALID_CREDENTIALS", message: "Invalid username or password" }, 401);
				return send({ username: "local" }, 200, { "Set-Cookie": "TOKEN=jwt; path=/; samesite=strict; secure; httponly", "X-CSRF-Token": "csrf" });
			}
			if (p === "/udm/proxy/network/api/s/default/stat/health") {
				if (req.headers.cookie !== "TOKEN=jwt" && req.headers["x-api-key"] !== "uni-key") return send({ error: { code: 401, message: "Unauthorized" } }, 401);
				return send({ meta: { rc: "ok" }, data: health });
			}
			// classic UniFi controller
			if (p === "/ctl/") {
				res.writeHead(302, { Location: "/manage" });
				return res.end();
			}
			if (p === "/ctl/api/login" && req.method === "POST") {
				if (body.username !== "admin" || body.password !== "ctl-pw") return send({ meta: { rc: "error", msg: "api.err.Invalid" }, data: [] }, 400);
				return send({ meta: { rc: "ok" }, data: [] }, 200, { "Set-Cookie": ["unifises=abc; Path=/; Secure; HttpOnly", "csrf_token=def; Path=/; Secure"] });
			}
			if (p === "/ctl/api/s/default/stat/health") {
				if (req.headers.cookie !== "unifises=abc; csrf_token=def") return send({ meta: { rc: "error", msg: "api.err.LoginRequired" }, data: [] }, 401);
				return send({ meta: { rc: "ok" }, data: health.slice(0, 2) });
			}
			send({ error: "not found" }, 404);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const run = (kind, path, secrets) => PLUGINS[kind].fetch({ url: base + path, secrets, service: {}, request, json });
const metric = (r, en) => r.metrics.find((m) => (m.label.en || m.label) === en);
const count = (line) => seen.filter((x) => x === line).length;

test("the network plugins are loaded and describe themselves", () => {
	for (const kind of ["pihole", "adguard", "traefik", "wgeasy", "nginxproxymanager", "unifi"]) {
		const p = PLUGINS[kind];
		assert.ok(p, kind);
		assert.ok(p.match instanceof RegExp);
		assert.ok(p.fields.filter((f) => /password|apiKey/.test(f.key)).every((f) => f.secret), `${kind}: secret fields`);
	}
	assert.ok(PLUGINS.pihole.match.test("pihole/pihole:latest"));
	assert.ok(PLUGINS.adguard.match.test("adguard/adguardhome"));
	assert.ok(PLUGINS.wgeasy.match.test("ghcr.io/wg-easy/wg-easy:15"));
	assert.ok(PLUGINS.nginxproxymanager.match.test("jc21/nginx-proxy-manager:latest"));
});

test("Pi-hole v6: logs in once, then reuses the session", async () => {
	const r = await run("pihole", "/ph6", { password: "app-pw" });
	assert.equal(metric(r, "Queries today").value, 24000);
	assert.equal(metric(r, "blocked").value, 3000);
	assert.equal(r.metrics[2].value, "12.5 %");
	const blocking = metric(r, "Blocking");
	assert.equal(blocking.value.en, "Off");
	assert.equal(blocking.warn, true);
	assert.deepEqual(r.warnings, ["Pi-hole blocking is disabled"]);
	await run("pihole", "/ph6", { password: "app-pw" });
	assert.equal(count("POST /ph6/api/auth"), 1);
});

test("Pi-hole v6: wrong password and missing password", async () => {
	await assert.rejects(run("pihole", "/ph6", { password: "nope" }), /Access denied/);
	await assert.rejects(run("pihole", "/ph6", {}), /Password missing/);
});

test("Pi-hole v5: falls back to api.php with the API token", async () => {
	const r = await run("pihole", "/ph5", { password: "v5-token" });
	assert.equal(r.metrics[0].value, 5000);
	assert.equal(r.metrics[1].value, 500);
	assert.equal(r.metrics[2].value, "10.0 %");
	assert.equal(r.metrics[3].value.en, "On");
	assert.ok(!r.metrics[3].warn);
	await assert.rejects(run("pihole", "/ph5", { password: "wrong" }), /Access denied/);
});

test("AdGuard Home: queries, blocked and protection off", async () => {
	const r = await run("adguard", "/agh", { username: "admin", password: "agh-pw" });
	assert.deepEqual(r.metrics.map((m) => (m.value && m.value.en) || m.value), [2000, 500, "25.0 %", "Off"]);
	assert.equal(r.metrics[3].warn, true);
	assert.deepEqual(r.warnings, ["AdGuard Home protection is off"]);
	assert.deepEqual(r.items[0], { title: "ads.example.com", sub: "120×", status: "ok" });
	assert.equal(r.summary, "Version 0.107.52");
	await assert.rejects(run("adguard", "/agh", { username: "admin", password: "wrong" }), /Access denied/);
	await assert.rejects(run("adguard", "/agh", { username: "admin" }), /Password missing/);
});

test("Traefik: totals, errors and the broken router", async () => {
	const r = await run("traefik", "/traefik", {});
	assert.deepEqual(r.metrics.map((m) => m.value), [13, 11, 1, "3.1.4"]);
	assert.equal(r.metrics[2].warn, true);
	assert.equal(r.items.length, 1);
	assert.equal(r.items[0].title, "broken@docker");
	assert.equal(r.items[0].status, "bad");
	assert.match(r.warnings[0], /^broken@docker: the service/);
	assert.equal(count("GET /traefik/api/tcp/routers"), 0); // no errors there
});

test("wg-easy v14: session login, connected clients and traffic", async () => {
	const r = await run("wgeasy", "/wg14", { password: "wg-pw" });
	assert.deepEqual(r.metrics.map((m) => m.value), [3, 1, "2.0 GB"]);
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["Phone", "ok"], ["Laptop", "warn"], ["Old", "bad"]]);
	assert.equal(r.summary, "Phone connected");
	await run("wgeasy", "/wg14", { password: "wg-pw" });
	assert.equal(count("POST /wg14/api/session"), 1);
	await assert.rejects(run("wgeasy", "/wg14", { password: "wrong" }), /Access denied/);
});

test("wg-easy v15: basic auth on /api/client", async () => {
	const r = await run("wgeasy", "/wg15", { username: "joel", password: "wg15-pw" });
	assert.deepEqual(r.metrics.map((m) => m.value), [1, 1, "12 KB"]);
	assert.equal(r.items[0].sub.startsWith("10.8.0.5"), true);
	await assert.rejects(run("wgeasy", "/wg15", { username: "joel", password: "wrong" }), /Access denied/);
	await assert.rejects(run("wgeasy", "/wg15", { password: "wg15-pw" }), /Username missing/);
});

test("Nginx Proxy Manager: hosts, expiring certificates, disabled hosts", async () => {
	const r = await run("nginxproxymanager", "/npm", { username: "me@home.lan", password: "npm-pw" });
	assert.deepEqual(r.metrics.map((m) => m.value), [3, 1, 1, 2]);
	assert.equal(r.metrics[1].warn, true);
	assert.deepEqual(r.warnings, ["Certificate jellyfin.home.lan expires in 5 days"]);
	assert.equal(r.items[0].status, "warn");
	assert.equal(r.items.find((i) => i.title === "old.home.lan").sub, "disabled");
	assert.equal(r.items.find((i) => i.title === "cloud.home.lan").status, "ok");
	await run("nginxproxymanager", "/npm", { username: "me@home.lan", password: "npm-pw" });
	assert.equal(count("POST /npm/api/tokens"), 1);
	await assert.rejects(run("nginxproxymanager", "/npm", { username: "me@home.lan", password: "wrong" }), /Access denied/);
	await assert.rejects(run("nginxproxymanager", "/npm", { username: "me@home.lan" }), /Password missing/);
});

test("UniFi OS: login, clients, devices and alerts", async () => {
	const r = await run("unifi", "/udm", { username: "local", password: "uni-pw" });
	assert.deepEqual(r.metrics.map((m) => m.value), [32, 6, 2, 20]);
	assert.equal(r.metrics[2].warn, true);
	assert.deepEqual(r.warnings, ["UniFi WiFi: warning", "1 UniFi device(s) offline"]);
	assert.equal(r.summary, "WAN 203.0.113.7");
	assert.ok(!r.items.some((i) => i.title === "VPN"));
	await assert.rejects(run("unifi", "/udm", { username: "local", password: "wrong" }), /Access denied/);
	const k = await run("unifi", "/udm", { apiKey: "uni-key" });
	assert.equal(k.metrics[0].value, 32);
});

test("UniFi classic controller: /api/login with cookies", async () => {
	const r = await run("unifi", "/ctl", { username: "admin", password: "ctl-pw" });
	assert.deepEqual(r.metrics.map((m) => m.value), [22, 4, 2, 20]);
	assert.equal(count("POST /ctl/api/auth/login"), 0);
	await assert.rejects(run("unifi", "/ctl", { username: "admin", password: "wrong" }), /Access denied/);
});
