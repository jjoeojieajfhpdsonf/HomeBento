"use strict";
// The network and security plugins (OPNsense, pfSense, OpenWrt, MikroTik, FRITZ!Box, Technitium,
// Caddy, CrowdSec, Headscale, authentik) against a small fake server that answers like their APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
const { request, json } = require("../lib/util");
const PLUGINS = require("../lib/plugins");

const HOUR = 3600000;
const DAY = 24 * HOUR;
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const md5 = (s) => crypto.createHash("md5").update(s).digest("hex");
let base;
let server;
const seen = [];
const state = { opnTraffic: 0, fbBytes: 0, owrtSession: 0, owrtValid: new Set() };

// checks an HTTP digest Authorization header like the FRITZ!Box does
function digestOk(header, method, user, password, realm, nonce) {
	if (!/^Digest /.test(header || "")) return false;
	const p = Object.fromEntries([...header.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)].map((m) => [m[1], m[2] !== undefined ? m[2] : m[3]]));
	if (p.username !== user || p.realm !== realm || p.nonce !== nonce) return false;
	const ha1 = md5(`${user}:${realm}:${password}`);
	const ha2 = md5(`${method}:${p.uri}`);
	return p.response === md5(`${ha1}:${nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
}

function soapAnswer(action, values) {
	const inner = Object.entries(values)
		.map(([k, v]) => `<${k}>${v}</${k}>`)
		.join("");
	return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${inner}</u:${action}Response></s:Body></s:Envelope>`;
}

test.before(async () => {
	server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			const url = new URL(req.url, "http://x");
			const p = url.pathname;
			const q = url.searchParams;
			seen.push(`${req.method} ${p}`);
			const send = (v, status = 200, headers = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers });
				res.end(JSON.stringify(v));
			};
			const xml = (text, status = 200, headers = {}) => {
				res.writeHead(status, { "Content-Type": "text/xml", ...headers });
				res.end(text);
			};
			let body = {};
			try {
				body = raw && raw.startsWith("{") ? JSON.parse(raw) : {};
			} catch {}

			// OPNsense
			if (p.startsWith("/opn/api/")) {
				if (req.headers.authorization !== basic("opn-key", "opn-secret")) return send({ status: 401, message: "Authentication Failed" }, 401);
				if (p === "/opn/api/diagnostics/activity/getActivity")
					return send({ headers: ["last pid: 1234;  load averages:  0.10,  0.12,  0.09  up 3+01:02:03  10:00:00", "45 processes:  1 running, 44 sleeping", "CPU: 10.0% user,  0.0% nice,  2.5% system,  0.0% interrupt, 87.5% idle", "Mem: 300M Active, 1000M Inact, 500M Wired, 6000M Free"], details: [] });
				if (p === "/opn/api/diagnostics/system/systemResources") return send({ memory: { total: "8000000000", total_frmt: "7629", used: 2000000000, used_frmt: "1907" } });
				if (p === "/opn/api/diagnostics/traffic/interface") {
					const n = state.opnTraffic++;
					// 2 s apart: 2.5 MB down (10 Mbit/s), 625 kB up (2.5 Mbit/s)
					return send({ interfaces: { wan: { inbytes: String(1e9 + n * 2.5e6), outbytes: String(5e8 + n * 625000), name: "WAN" }, lan: { inbytes: "1", outbytes: "1", name: "LAN" } }, time: 1700000000 + n * 2 });
				}
				if (p === "/opn/api/core/system/status")
					return send({ metadata: { system: { status: "WARNING" } }, subsystems: { Firmware: { title: "Firmware", message: "An <b>update</b> is available", status: "WARNING", statusCode: 0, isBanner: false }, System: { title: "System", message: "No pending messages", status: "OK", statusCode: 2 } } });
			}
			// pfSense REST API v2
			if (p.startsWith("/pfs/api/v2/")) {
				if (req.headers["x-api-key"] !== "pf-key") return send({ code: 401, status: "unauthorized", response_id: "AUTH_AUTHENTICATION_FAILED", message: "Authentication failed", data: [] }, 401);
				if (p === "/pfs/api/v2/status/system") return send({ code: 200, status: "ok", data: { cpu_usage: 7.6, mem_usage: 41.2, disk_usage: 93.0, temp_c: 45.0, cpu_load_avg: [0.1, 0.2, 0.3], uptime: "1 Day 02 Hours" } });
				if (p === "/pfs/api/v2/status/interfaces")
					return send({
						code: 200,
						data: [
							{ name: "wan", descr: "WAN", hwif: "igb0", status: "up", enable: true, ipaddr: "203.0.113.9" },
							{ name: "lan", descr: "LAN", hwif: "igb1", status: "up", enable: true, ipaddr: "192.168.1.1" },
							{ name: "opt1", descr: "IOT", hwif: "igb2", status: "no carrier", enable: true, ipaddr: "" },
							{ name: "opt2", descr: "OFF", hwif: "igb3", status: "down", enable: false }
						]
					});
				if (p === "/pfs/api/v2/status/gateways")
					return send({
						code: 200,
						data: [
							{ name: "WAN_DHCP", monitorip: "203.0.113.1", delay: "5.1ms", loss: "0.0%", status: "online" },
							{ name: "WAN2_PPPOE", monitorip: "198.51.100.1", delay: "0ms", loss: "100.0%", status: "down" }
						]
					});
				if (p === "/pfs/api/v2/system/version") return send({ code: 200, data: { version: "2.7.2-RELEASE" } });
			}
			// OpenWrt ubus
			if (p === "/owrt/ubus" && req.method === "POST") {
				const [session, object, method, args] = body.params || [];
				const ok = (data) => send({ jsonrpc: "2.0", id: body.id, result: data === undefined ? [0] : [0, data] });
				if (object === "session" && method === "login") {
					if (args.username !== "root" || args.password !== "ow-pw") return send({ jsonrpc: "2.0", id: body.id, result: [6] });
					const sid = `sess${++state.owrtSession}`.padEnd(32, "0");
					state.owrtValid.add(sid);
					return ok({ ubus_rpc_session: sid, timeout: 300, expires: 300, acls: {}, data: { username: "root" } });
				}
				if (!state.owrtValid.has(session)) return send({ jsonrpc: "2.0", id: body.id, error: { code: -32002, message: "Access denied" } });
				if (object === "system" && method === "info") return ok({ localtime: 1700000000, uptime: 93784, load: [32768, 16384, 8192], memory: { total: 256000000, free: 100000000, shared: 1000, buffered: 4000000, available: 192000000, cached: 50000000 }, swap: { total: 0, free: 0 } });
				if (object === "system" && method === "board") return ok({ kernel: "5.15.150", hostname: "router", system: "ARMv8", model: "GL.iNet GL-MT3000", board_name: "glinet,gl-mt3000", release: { distribution: "OpenWrt", version: "23.05.3", revision: "r23809", target: "mediatek/filogic" } });
				if (object === "network.interface.wan" && method === "status") return ok({ up: true, pending: false, available: true, uptime: 3600, l3_device: "eth1", proto: "dhcp", device: "eth1", "ipv4-address": [{ address: "198.51.100.4", mask: 24 }] });
				return send({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "Object not found" } });
			}
			// MikroTik RouterOS REST
			if (p.startsWith("/mt/rest/")) {
				if (req.headers.authorization !== basic("admin", "mt-pw")) return send({ error: 401, message: "Unauthorized" }, 401);
				if (p === "/mt/rest/system/resource") return send({ uptime: "1w2d3h4m5s", version: "7.15.3 (stable)", "free-memory": "805306368", "total-memory": "1073741824", "cpu-load": "12", "cpu-count": "4", "board-name": "hAP ax3", "free-hdd-space": "64000000", "total-hdd-space": "128000000", platform: "MikroTik" });
				if (p === "/mt/rest/ip/dhcp-server/lease") {
					assert.ok(q.get(".proplist").includes("status"));
					return send([
						{ ".id": "*1", address: "192.168.88.10", status: "bound", "host-name": "laptop", disabled: "false" },
						{ ".id": "*2", address: "192.168.88.11", status: "waiting", disabled: "false" },
						{ ".id": "*3", address: "192.168.88.12", status: "bound", disabled: "true" },
						{ ".id": "*4", address: "192.168.88.13", status: "bound", disabled: "false" }
					]);
				}
			}
			// FRITZ!Box TR-064 (digest auth)
			if (p.startsWith("/fb/upnp/control/")) {
				const nonce = "F1A2B3C4D5";
				const realm = "F!Box SOAP-Auth";
				if (!digestOk(req.headers.authorization, "POST", "fbuser", "fb-pw", realm, nonce)) return xml("<html>401 Unauthorized</html>", 401, { "WWW-Authenticate": `Digest realm="${realm}", nonce="${nonce}", algorithm=MD5, qop="auth"` });
				const action = (/#(\w+)"?$/.exec(req.headers.soapaction || "") || [])[1];
				assert.ok(raw.includes(`<u:${action} `), "SOAP body names the action");
				if (p === "/fb/upnp/control/wancommonifconfig1") {
					if (action === "GetCommonLinkProperties") return xml(soapAnswer(action, { NewWANAccessType: "DSL", NewLayer1UpstreamMaxBitRate: 40000000, NewLayer1DownstreamMaxBitRate: 250000000, NewPhysicalLinkStatus: "Up" }));
					// near the 32-bit limit, so the counters wrap around
					if (action === "GetTotalBytesSent") return xml(soapAnswer(action, { NewTotalBytesSent: (4294000000 + state.fbBytes++ * 300000) % 2 ** 32 }));
					if (action === "GetTotalBytesReceived") return xml(soapAnswer(action, { NewTotalBytesReceived: (4294900000 + state.fbBytes++ * 3000000) % 2 ** 32 }));
				}
				if (p === "/fb/upnp/control/wanipconnection1" && action === "GetStatusInfo") return xml(soapAnswer(action, { NewConnectionStatus: "Unconfigured", NewLastConnectionError: "ERROR_NONE", NewUptime: 0 }));
				if (p === "/fb/upnp/control/wanpppconn1") {
					if (action === "GetStatusInfo") return xml(soapAnswer(action, { NewConnectionStatus: "Connected", NewLastConnectionError: "ERROR_NONE", NewUptime: 90000 }));
					if (action === "GetExternalIPAddress") return xml(soapAnswer(action, { NewExternalIPAddress: "203.0.113.50" }));
				}
				return xml("<s:Envelope><s:Body><s:Fault><detail><UPnPError><errorCode>401</errorCode><errorDescription>Invalid Action</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>", 500);
			}
			// FRITZ!Box IGD UPnP (no login)
			if (p.startsWith("/fbi/igdupnp/control/")) {
				const action = (/#(\w+)"?$/.exec(req.headers.soapaction || "") || [])[1];
				if (p.endsWith("/WANIPConn1") && action === "GetStatusInfo") return xml(soapAnswer(action, { NewConnectionStatus: "Connected", NewLastConnectionError: "ERROR_NONE", NewUptime: 3600 }));
				if (p.endsWith("/WANIPConn1") && action === "GetExternalIPAddress") return xml(soapAnswer(action, { NewExternalIPAddress: "198.51.100.77" }));
				if (p.endsWith("/WANCommonIFC1") && action === "GetCommonLinkProperties") return xml(soapAnswer(action, { NewWANAccessType: "Ethernet", NewLayer1UpstreamMaxBitRate: 40000000, NewLayer1DownstreamMaxBitRate: 250000000, NewPhysicalLinkStatus: "Up" }));
				if (p.endsWith("/WANCommonIFC1") && action === "GetAddonInfos") return xml(soapAnswer(action, { NewByteSendRate: 125000, NewByteReceiveRate: 1250000, NewX_AVM_DE_TotalBytesSent64: "1000", NewX_AVM_DE_TotalBytesReceived64: "2000" }));
			}
			// Technitium
			if (p === "/tech/api/dashboard/stats/get") {
				if (q.get("token") !== "tt-token") return send({ status: "invalid-token", errorMessage: "Invalid token or session expired." });
				assert.equal(q.get("type"), "LastDay");
				return send({
					status: "ok",
					response: {
						stats: { totalQueries: 10000, totalNoError: 8000, totalServerFailure: 10, totalNxDomain: 400, totalRefused: 0, totalAuthoritative: 100, totalRecursive: 3000, totalCached: 5000, totalBlocked: 1500, totalDropped: 0, totalClients: 14, zones: 3, cachedEntries: 900, allowedZones: 2, blockedZones: 12, allowListZones: 0, blockListZones: 250000 },
						topClients: [{ name: "192.168.1.20", domain: "laptop.lan", hits: 3000 }],
						topDomains: [{ name: "example.com", hits: 900 }],
						topBlockedDomains: [{ name: "ads.example.com", hits: 300 }, { name: "track.example.net", hits: 120 }]
					}
				});
			}
			// Caddy admin API
			if (p === "/caddy/config/")
				return send({
					admin: { listen: "0.0.0.0:2019" },
					apps: {
						http: {
							servers: {
								srv0: {
									listen: [":443"],
									routes: [
										{ match: [{ host: ["a.home.lan", "b.home.lan"] }], handle: [{ handler: "subroute", routes: [{ handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "10.0.0.5:8096" }] }] }] }], terminal: true },
										{ match: [{ host: ["c.home.lan"] }], handle: [{ handler: "subroute", routes: [{ match: [{ host: ["d.home.lan"] }], handle: [{ handler: "reverse_proxy" }] }] }] }
									]
								}
							}
						}
					}
				});
			if (p === "/caddy/reverse_proxy/upstreams") return send([{ address: "10.0.0.5:8096", num_requests: 2, fails: 0 }, { address: "10.0.0.6:80", num_requests: 0, fails: 3 }]);
			if (p.startsWith("/caddy403/")) {
				res.writeHead(403, { "Content-Type": "application/json" });
				return res.end(JSON.stringify({ error: `host not allowed: ${req.headers.host}` }));
			}
			// CrowdSec LAPI
			if (p.startsWith("/cs/v1/") || p.startsWith("/csold/v1/")) {
				const old = p.startsWith("/csold/");
				const sub = p.replace(/^\/cs(old)?/, "");
				if (sub === "/v1/decisions") {
					if (req.headers["x-api-key"] !== "bouncer-key") return send({ message: "access forbidden" }, 403);
					if (old && q.has("origins")) return send({ message: "'origins' doesn't exist: invalid filter" }, 500);
					if (old) return send([{ origin: "CAPI", type: "ban", scenario: "http:scan", value: "192.0.2.1" }, { origin: "lists", type: "ban", scenario: "lists:firehol", value: "192.0.2.2" }, { origin: "crowdsec", type: "ban", scenario: "crowdsecurity/ssh-bf", value: "192.0.2.3" }]);
					assert.equal(q.get("origins"), "crowdsec,cscli,console,appsec");
					return send([
						{ id: 1, origin: "crowdsec", type: "ban", scope: "Ip", scenario: "crowdsecurity/ssh-bf", value: "1.2.3.4", duration: "3h" },
						{ id: 2, origin: "crowdsec", type: "ban", scope: "Ip", scenario: "crowdsecurity/ssh-bf", value: "1.2.3.5", duration: "2h" },
						{ id: 3, origin: "cscli", type: "ban", scope: "Ip", scenario: "manual 'ban' from 'host'", value: "5.6.7.8", duration: "4h" },
						{ id: 4, origin: "crowdsec", type: "captcha", scope: "Ip", scenario: "crowdsecurity/http-probing", value: "9.9.9.9", duration: "1h" }
					]);
				}
				if (sub === "/v1/watchers/login" && req.method === "POST") {
					if (body.machine_id !== "hb" || body.password !== "machine-pw") return send({ code: 401, message: "incorrect Username or Password" }, 401);
					return send({ code: 200, expire: new Date(Date.now() + HOUR).toISOString(), token: "jwt-cs" });
				}
				if (sub === "/v1/alerts") {
					if (req.headers.authorization !== "Bearer jwt-cs") return send({ code: 401, message: "Token is expired" }, 401);
					if (q.get("has_active_decision")) return send([{ id: 9, scenario: "crowdsecurity/ssh-bf", decisions: [{ type: "ban", scenario: "crowdsecurity/ssh-bf", value: "1.2.3.4" }] }]);
					assert.equal(q.get("since"), "24h");
					return send([{ id: 1, scenario: "crowdsecurity/ssh-bf" }, { id: 2, scenario: "crowdsecurity/ssh-bf" }, { id: 3, scenario: "crowdsecurity/http-probing" }]);
				}
			}
			// Headscale
			if (p.startsWith("/hs/api/v1/") || p.startsWith("/hs22/api/v1/")) {
				if (req.headers.authorization !== "Bearer hs-key") return send({ code: 16, message: "Unauthorized" }, 401);
				const nodes = [
					{ id: "1", givenName: "laptop", name: "laptop", user: { id: "1", name: "joel" }, ipAddresses: ["fd7a:115c:a1e0::1", "100.64.0.1"], online: true, lastSeen: new Date().toISOString(), expiry: "0001-01-01T00:00:00Z" },
					{ id: "2", givenName: "phone", name: "phone", user: { id: "1", name: "joel" }, ipAddresses: ["100.64.0.2"], online: false, lastSeen: new Date(Date.now() - 2 * HOUR).toISOString(), expiry: null },
					{ id: "3", givenName: "old-pi", name: "old-pi", user: { id: "2", name: "anna" }, ipAddresses: ["100.64.0.3"], online: false, lastSeen: new Date(Date.now() - 30 * DAY).toISOString(), expiry: new Date(Date.now() - DAY).toISOString() }
				];
				if (p === "/hs/api/v1/node") return send({ nodes });
				if (p === "/hs22/api/v1/machine") return send({ machines: nodes.slice(0, 2) });
				if (p.endsWith("/api/v1/user")) return send({ users: [{ id: "1", name: "joel" }, { id: "2", name: "anna" }] });
			}
			// authentik
			if (p.startsWith("/ak/api/v3/") || p.startsWith("/akold/api/v3/")) {
				if (req.headers.authorization !== "Bearer ak-token") return send({ detail: "Token invalid/expired" }, 403);
				const old = p.startsWith("/akold/");
				const sub = p.replace(/^\/ak(old)?/, "");
				if (sub === "/api/v3/core/users/") return send({ pagination: { count: old ? 7 : 42, current: 1, total_pages: 42 }, results: [{ pk: 1, username: "akadmin" }] });
				if (sub === "/api/v3/events/events/volume/" && !old) {
					assert.deepEqual(q.getAll("actions"), ["login", "login_failed"]);
					return send([
						{ action: "login", time: new Date(Date.now() - 12 * HOUR).toISOString(), count: 5 },
						{ action: "login", time: new Date(Date.now() - 6 * HOUR).toISOString(), count: 3 },
						{ action: "login_failed", time: new Date(Date.now() - 6 * HOUR).toISOString(), count: 2 }
					]);
				}
				if (sub === "/api/v3/events/events/per_month/" && old) {
					if (q.get("action") === "login") return send([{ x_cord: Date.now() - HOUR, y_cord: 4 }, { x_cord: Date.now() - 3 * DAY, y_cord: 10 }]);
					if (q.get("action") === "login_failed") return send([{ x_cord: Date.now() - 2 * HOUR, y_cord: 1 }]);
				}
				if (sub === "/api/v3/admin/version/") {
					if (old) return send({ detail: "You do not have permission to perform this action." }, 403);
					return send({ version_current: "2024.6.1", version_latest: "2024.10.2", version_latest_valid: true, build_hash: "", outdated: true, outpost_outdated: false });
				}
			}
			send({ error: "not found" }, 404);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
	PLUGINS.opnsense.sampleDelay = 20;
	PLUGINS.fritzbox.sampleDelay = 20;
});

test.after(() => server.close());

const run = (kind, path, secrets) => PLUGINS[kind].fetch({ url: base + path, secrets, service: {}, request, json });
const values = (r) => r.metrics.map((m) => (m.value && m.value.en) || m.value);
const count = (line) => seen.filter((x) => x === line).length;
const KINDS = ["opnsense", "pfsense", "openwrt", "mikrotik", "fritzbox", "technitium", "caddy", "crowdsec", "headscale", "authentik"];

test("the network and security plugins are loaded and describe themselves", () => {
	for (const kind of KINDS) {
		const p = PLUGINS[kind];
		assert.ok(p, kind);
		assert.ok(p.match instanceof RegExp, kind);
		assert.ok(p.fields.filter((f) => /password|apiKey|apiSecret|token/i.test(f.key)).every((f) => f.secret), `${kind}: secret fields`);
		assert.ok(p.fields.every((f) => f.label && (typeof f.label === "string" || (f.label.de && f.label.en))), `${kind}: labels`);
	}
	assert.ok(PLUGINS.authentik.match.test("authentik-server ghcr.io/goauthentik/server:2024.8"));
	assert.ok(!PLUGINS.authentik.match.test("authentik-worker ghcr.io/goauthentik/server:2024.8"));
	assert.ok(!PLUGINS.authentik.match.test("authentik-postgresql docker.io/library/postgres:16"));
	assert.ok(PLUGINS.crowdsec.match.test("crowdsec crowdsecurity/crowdsec:latest"));
	assert.ok(!PLUGINS.crowdsec.match.test("crowdsec-firewall-bouncer"));
	assert.ok(PLUGINS.headscale.match.test("headscale/headscale:0.23"));
	assert.ok(!PLUGINS.headscale.match.test("ghcr.io/gurucomputing/headscale-ui"));
	assert.ok(PLUGINS.technitium.match.test("technitium/dns-server"));
	assert.ok(PLUGINS.caddy.match.test("caddy:2-alpine"));
	assert.ok(!PLUGINS.fritzbox.match.test("pdreker/fritz_exporter"));
});

test("OPNsense: CPU, memory, WAN rate from two samples and system messages", async () => {
	const r = await run("opnsense", "/opn", { apiKey: "opn-key", apiSecret: "opn-secret" });
	assert.deepEqual(values(r), ["12.5 %", "25 %", "10.0 Mbit/s", "2.5 Mbit/s"]);
	assert.deepEqual(r.warnings, ["Firmware: An update is available"]);
	assert.deepEqual(r.items, [{ title: "Firmware", sub: "An update is available", status: "warn" }]);
	assert.equal(count("GET /opn/api/diagnostics/traffic/interface"), 2);
	// the next call compares with the stored sample, no extra wait
	const again = await run("opnsense", "/opn", { apiKey: "opn-key", apiSecret: "opn-secret" });
	assert.equal(again.metrics[2].value, "10.0 Mbit/s");
	assert.equal(count("GET /opn/api/diagnostics/traffic/interface"), 3);
	const other = await run("opnsense", "/opn", { apiKey: "opn-key", apiSecret: "opn-secret", wan: "opt7" });
	assert.equal(other.metrics[2].value, null);
	assert.match(other.warnings[0], /no interface "opt7"/);
	await assert.rejects(run("opnsense", "/opn", { apiKey: "opn-key", apiSecret: "wrong" }), /Access denied/);
	await assert.rejects(run("opnsense", "/opn", { apiKey: "opn-key" }), /API key missing/);
});

test("pfSense: system, interfaces, gateways and version", async () => {
	const r = await run("pfsense", "/pfs", { apiKey: "pf-key" });
	assert.deepEqual(values(r), ["8 %", "41 %", "93 %", "Online"]);
	assert.equal(r.metrics[2].warn, true);
	assert.deepEqual(r.warnings, ["Gateway WAN2_PPPOE is down (loss 100.0%)", "pfSense disk is 93 % full"]);
	assert.equal(r.summary, "pfSense 2.7.2-RELEASE · WAN 203.0.113.9");
	assert.ok(!r.items.some((i) => i.title === "OFF"), "disabled interfaces are left out");
	assert.equal(r.items.find((i) => i.title === "IOT").status, "bad");
	assert.equal(r.items.find((i) => i.title === "WAN2_PPPOE").status, "bad");
	await assert.rejects(run("pfsense", "/pfs", { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("pfsense", "/pfs", {}), /API key missing/);
	await assert.rejects(run("pfsense", "/nothing", { apiKey: "pf-key" }), /REST API v2 not found/);
});

test("OpenWrt: ubus login, system info, WAN, session reuse and renewal", async () => {
	const r = await run("openwrt", "/owrt", { password: "ow-pw" });
	assert.deepEqual(values(r), ["0.50", "25 %", "Online", "1 d 2 h"]);
	assert.equal(r.summary, "GL.iNet GL-MT3000 · OpenWrt 23.05.3 · WAN 198.51.100.4");
	assert.deepEqual(r.items, [{ title: "WAN (wan)", sub: "dhcp · 198.51.100.4 · 1 h 0 min", status: "ok" }]);
	assert.equal(state.owrtSession, 1);
	await run("openwrt", "/owrt", { username: "root", password: "ow-pw" });
	assert.equal(state.owrtSession, 1, "session reused");
	state.owrtValid.clear(); // sessions expire
	const again = await run("openwrt", "/owrt", { password: "ow-pw" });
	assert.equal(again.metrics[0].value, "0.50");
	assert.equal(state.owrtSession, 2, "logged in again");
	const noWan = await run("openwrt", "/owrt", { password: "ow-pw", wan: "wwan" });
	assert.equal(noWan.metrics[2].value, null);
	await assert.rejects(run("openwrt", "/owrt", { password: "wrong" }), /Access denied/);
	await assert.rejects(run("openwrt", "/owrt", {}), /Password missing/);
});

test("MikroTik: resources and bound DHCP leases", async () => {
	const r = await run("mikrotik", "/mt", { username: "admin", password: "mt-pw" });
	assert.deepEqual(values(r), ["12 %", "25 %", 2, "9 d 3 h"]);
	assert.equal(r.summary, "hAP ax3 · RouterOS 7.15.3 (stable)");
	assert.deepEqual(r.warnings, []);
	await assert.rejects(run("mikrotik", "/mt", { username: "admin", password: "wrong" }), /Access denied/);
	await assert.rejects(run("mikrotik", "/mt", { password: "mt-pw" }), /Username missing/);
});

test("FRITZ!Box: TR-064 with digest auth, PPP connection and wrapping byte counters", async () => {
	const r = await run("fritzbox", "/fb", { username: "fbuser", password: "fb-pw" });
	assert.equal(r.metrics[0].value.en, "Online");
	assert.ok(!r.metrics[0].warn);
	assert.match(r.metrics[1].value, /bit\/s$/);
	assert.match(r.metrics[2].value, /bit\/s$/);
	assert.equal(r.metrics[3].value, "250/40 Mbit/s");
	assert.equal(r.summary, "IP 203.0.113.50 · online 1 d 1 h · DSL");
	// the digest challenge is remembered: the second call needs no extra round trip per action
	const before = seen.length;
	const again = await run("fritzbox", "/fb", { username: "fbuser", password: "fb-pw" });
	assert.match(again.metrics[1].value, /bit\/s$/);
	assert.equal(seen.length - before, 6);
	await assert.rejects(run("fritzbox", "/fb", { username: "fbuser", password: "wrong" }), /Access denied/);
});

test("FRITZ!Box: IGD UPnP without a login, and UPnP turned off", async () => {
	const r = await run("fritzbox", "/fbi", {});
	assert.deepEqual(values(r), ["Online", "10.0 Mbit/s", "1.0 Mbit/s", "250/40 Mbit/s"]);
	assert.equal(r.summary, "IP 198.51.100.77 · online 1 h 0 min · Ethernet");
	await assert.rejects(run("fritzbox", "/fbx", {}), /UPnP/);
});

test("FRITZ!Box: address and digest helpers", () => {
	const fb = PLUGINS.fritzbox;
	assert.equal(fb.apiBase("http://fritz.box"), "http://fritz.box:49000");
	assert.equal(fb.apiBase("https://192.168.178.1"), "https://192.168.178.1:49443");
	assert.equal(fb.apiBase("http://192.168.178.1:49000"), "http://192.168.178.1:49000");
	const ch = fb.parseChallenge(['Digest realm="F!Box SOAP-Auth", nonce="ABC", algorithm=MD5, qop="auth"']);
	assert.deepEqual({ realm: ch.realm, nonce: ch.nonce, qop: ch.qop }, { realm: "F!Box SOAP-Auth", nonce: "ABC", qop: "auth" });
	const header = fb.digest(ch, "POST", "/upnp/control/x", "u", "p");
	assert.ok(digestOk(header, "POST", "u", "p", "F!Box SOAP-Auth", "ABC"));
	assert.equal(fb.parseChallenge("Basic realm=x"), null);
});

test("Technitium: queries, blocked, clients and top blocked domains", async () => {
	const r = await run("technitium", "/tech", { token: "tt-token" });
	assert.deepEqual(values(r), [10000, 1500, "15.0 %", 14]);
	assert.deepEqual(r.items[0], { title: "ads.example.com", sub: "300×", status: "ok" });
	assert.equal(r.summary, "250,012 domains on the blocklist");
	assert.deepEqual(r.warnings, []);
	await assert.rejects(run("technitium", "/tech", { token: "wrong" }), /Access denied/);
	await assert.rejects(run("technitium", "/tech", {}), /API token missing/);
});

test("Caddy: hosts from the config and upstream health", async () => {
	const r = await run("caddy", "/caddy", {});
	assert.deepEqual(values(r), [4, "1/2", 2]);
	assert.equal(r.metrics[1].warn, true);
	assert.deepEqual(r.items[0], { title: "10.0.0.6:80", sub: "3 failures", status: "bad" });
	assert.deepEqual(r.warnings, ["Caddy upstream 10.0.0.6:80 is failing"]);
	assert.equal(r.summary, "a.home.lan, b.home.lan, c.home.lan +1");
	await assert.rejects(run("caddy", "/caddy403", {}), /admin origins/);
	assert.equal(PLUGINS.caddy.adminBase("https://proxy.home.lan"), "http://proxy.home.lan:2019");
	assert.equal(PLUGINS.caddy.adminBase("http://10.0.0.2:2019"), "http://10.0.0.2:2019");
	assert.equal(PLUGINS.caddy.adminBase("https://proxy.home.lan", "http://caddy:2019/"), "http://caddy:2019");
});

test("CrowdSec: bouncer decisions plus machine alerts", async () => {
	const r = await run("crowdsec", "/cs", { apiKey: "bouncer-key", username: "hb", password: "machine-pw" });
	assert.deepEqual(values(r), [3, 3, 1, "ssh-bf"]);
	assert.deepEqual(r.items[0], { title: "ssh-bf", sub: "2×", status: "ok" });
	assert.equal(r.summary, "Most bans: ssh-bf");
	await run("crowdsec", "/cs", { apiKey: "bouncer-key", username: "hb", password: "machine-pw" });
	assert.equal(count("POST /cs/v1/watchers/login"), 1, "token reused");
	await assert.rejects(run("crowdsec", "/cs", { apiKey: "wrong" }), /Access denied \(check the bouncer key\)/);
	await assert.rejects(run("crowdsec", "/cs", { username: "hb", password: "wrong" }), /Access denied \(check machine ID and password\)/);
	await assert.rejects(run("crowdsec", "/cs", {}), /API key missing/);
});

test("CrowdSec: machine login only, and an older LAPI without the origins filter", async () => {
	const m = await run("crowdsec", "/cs", { username: "hb", password: "machine-pw" });
	assert.deepEqual(values(m), [1, 3, "ssh-bf"]);
	const old = await run("crowdsec", "/csold", { apiKey: "bouncer-key" });
	assert.deepEqual(values(old), [1]);
	assert.deepEqual(old.items, [{ title: "ssh-bf", sub: "1×", status: "ok" }]);
});

test("Headscale: nodes online, users and expired keys", async () => {
	const r = await run("headscale", "/hs", { apiKey: "hs-key" });
	assert.deepEqual(values(r), ["1/3", 2, 1]);
	assert.equal(r.metrics[2].warn, true);
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["laptop", "ok"], ["old-pi", "bad"], ["phone", "warn"]]);
	assert.equal(r.items[0].sub, "joel · 100.64.0.1");
	assert.equal(r.items[2].sub, "joel · 100.64.0.2 · 2 h ago");
	assert.deepEqual(r.warnings, ["Headscale node old-pi has an expired key"]);
	const old = await run("headscale", "/hs22", { apiKey: "hs-key" });
	assert.equal(old.metrics[0].value, "1/2");
	await assert.rejects(run("headscale", "/hs", { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("headscale", "/hs", {}), /API key missing/);
});

test("authentik: users, logins, failed logins and an outdated version", async () => {
	const r = await run("authentik", "/ak", { token: "ak-token" });
	assert.deepEqual(values(r), [42, 8, 2, "2024.6.1"]);
	assert.equal(r.metrics[3].warn, true);
	assert.deepEqual(r.warnings, ["authentik 2024.6.1 is outdated (latest 2024.10.2)"]);
	assert.equal(r.summary, "Update to 2024.10.2 available");
	const old = await run("authentik", "/akold", { token: "ak-token" });
	assert.deepEqual(values(old), [7, 4, 1, null]);
	assert.deepEqual(old.warnings, []);
	await assert.rejects(run("authentik", "/ak", { token: "wrong" }), /Access denied/);
	await assert.rejects(run("authentik", "/ak", {}), /API token missing/);
});
