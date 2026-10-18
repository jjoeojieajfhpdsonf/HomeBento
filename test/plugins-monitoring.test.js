"use strict";
// The monitoring plugins (changedetection.io, Healthchecks, Gatus, Beszel, Netdata, Gotify, ntfy,
// Gluetun, What's Up Docker, Watchtower) against a small fake server that answers like the real APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, json } = require("../lib/util");
const plugins = require("../lib/plugins");
const { guessKind } = require("../lib/kinds");

const KEY = "s3cret";
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
let base;
let server;
let beszelLogins = 0;
let beszelValid = new Set();
let gluetunOld = false;
let ntfyHealthy = true;

const run = (kind, prefix, secrets = {}) => plugins[kind].fetch({ url: `${base}${prefix}`, secrets, service: { id: kind }, request, json });
const metric = (r, en) => r.metrics.find((m) => (typeof m.label === "string" ? m.label : m.label.en) === en);
const val = (m) => (m && typeof m.value === "object" && m.value ? m.value.en : m && m.value);

test.before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		const p = url.pathname;
		const send = (v, status = 200, type = "application/json") => {
			res.writeHead(status, { "Content-Type": type });
			res.end(typeof v === "string" ? v : JSON.stringify(v));
		};
		let raw = "";
		req.on("data", (c) => (raw += c));
		req.on("end", () => {
			// changedetection.io: x-api-key
			if (p === "/cd/api/v1/watch") {
				if (req.headers["x-api-key"] !== KEY) return send({ message: "Invalid access - API key invalid." }, 403);
				return send({
					"u-1": { url: "https://example.com/price", title: "Price", last_changed: 1700000000, last_checked: 1700000100, last_error: false, viewed: false },
					"u-2": { url: "https://shop.example.org/item", title: "", last_changed: 1700000000, last_checked: 1700000100, last_error: false, viewed: true },
					"u-3": { url: "https://broken.example.net/", title: "Broken", last_changed: 0, last_checked: 1700000100, last_error: "Connection refused", viewed: true }
				});
			}

			// Healthchecks: X-Api-Key
			if (p === "/hc/api/v3/checks/") {
				if (req.headers["x-api-key"] !== KEY) return send({ error: "wrong api key" }, 401);
				return send({
					checks: [
						{ name: "Backup", slug: "backup", status: "down", last_ping: ago(60 * 30), grace: 3600 },
						{ name: "Cron", slug: "cron", status: "up", last_ping: ago(5) },
						{ name: "Nightly", slug: "nightly", status: "grace", last_ping: ago(60 * 25) },
						{ name: "Old", slug: "old", status: "paused", last_ping: null },
						{ name: "Job", slug: "job", status: "started", last_ping: ago(1) }
					]
				});
			}

			// Gatus: open, and basic auth under /gatuspw
			const g = /^\/(gatus|gatuspw)\/api\/v1\/endpoints\/statuses$/.exec(p);
			if (g) {
				if (g[1] === "gatuspw" && req.headers.authorization !== basic("admin", KEY)) return send({ error: "Unauthorized" }, 401);
				return send([
					{ name: "website", group: "core", key: "core_website", results: [{ success: false, duration: 1e6 }, { success: true, duration: 23_400_000, errors: [] }] },
					{ name: "api", group: "", key: "_api", results: [{ success: true, duration: 1e6 }, { success: false, duration: 5e9, errors: ["context deadline exceeded"] }] },
					{ name: "new", key: "_new", results: [] }
				]);
			}

			// Beszel (PocketBase)
			if (p === "/bz/api/collections/users/auth-with-password" && req.method === "POST") {
				const b = JSON.parse(raw || "{}");
				if (b.identity === "me@example.com" && b.password === KEY) {
					beszelLogins++;
					const token = `tok${beszelLogins}`;
					beszelValid.add(token);
					return send({ token, record: { id: "u1", email: b.identity } });
				}
				return send({ code: 400, message: "Failed to authenticate.", data: {} }, 400);
			}
			if (p === "/bz/api/collections/_superusers/auth-with-password") return send({ code: 400, message: "Failed to authenticate.", data: {} }, 400);
			if (p === "/bz/api/collections/systems/records") {
				const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
				if (!beszelValid.has(token)) return send({ page: 1, perPage: 500, totalItems: 0, totalPages: 0, items: [] });
				return send({
					page: 1,
					perPage: 500,
					totalItems: 3,
					items: [
						{ id: "a", name: "nas", host: "10.0.0.2", status: "up", info: { cpu: 12.4, mp: 45.2, dp: 93.1, u: 1000, v: "0.12.0" } },
						{ id: "b", name: "pi", host: "10.0.0.3", status: "down", info: { cpu: 0, mp: 0, dp: 0 } },
						{ id: "c", name: "docker", host: "10.0.0.4", status: "up", info: { cpu: 55.6, mp: 70, dp: 40 } }
					]
				});
			}

			// Netdata
			if (p === "/nd/api/v1/info") return send({ version: "v1.47.0", cores_total: "4", alarms: { normal: 120, warning: 1, critical: 1 } });
			if (p === "/nd/api/v1/alarms")
				return send({
					hostname: "box",
					alarms: {
						"disk_space._.used_space": { id: 1, name: "disk_space_usage", chart: "disk_space._", status: "CRITICAL", value_string: "97%" },
						"system.ram.ram_in_use": { id: 2, name: "ram_in_use", chart: "system.ram", status: "WARNING", value_string: "85.1%" }
					}
				});
			if (p === "/nd/api/v1/data") {
				const chart = url.searchParams.get("chart");
				if (chart === "system.cpu") return send({ labels: ["time", "guest_nice", "guest", "steal", "softirq", "irq", "user", "system", "nice", "iowait"], data: [[1700000000, 0, 0, 0, 0.5, 0, 10.2, 3.1, 0, 1.2]] });
				if (chart === "system.ram") return send({ labels: ["time", "free", "used", "cached", "buffers"], data: [[1700000000, 2000, 6000, 1500, 500]] });
			}

			// Gotify: X-Gotify-Key client token
			if (p.startsWith("/gotify/")) {
				if (req.headers["x-gotify-key"] !== KEY) return send({ error: "Unauthorized", errorCode: 401, errorDescription: "you need to provide a valid access token or user credentials to access this api" }, 401);
				if (p === "/gotify/message")
					return send({
						messages: [
							{ id: 3, appid: 1, message: "Disk almost full", title: "Alert", priority: 9, date: ago(10) },
							{ id: 2, appid: 2, message: "Backup done\nall fine", title: "", priority: 2, date: ago(120) }
						],
						paging: { size: 2, since: 0, limit: 200 }
					});
				if (p === "/gotify/application") return send([{ id: 1, name: "Server" }, { id: 2, name: "Backup" }]);
				if (p === "/gotify/client") return send([{ id: 1, name: "Phone" }]);
			}

			// ntfy
			if (p.startsWith("/ntfy/")) {
				if (req.headers.authorization && req.headers.authorization !== `Bearer ${KEY}`) return send({ code: 40101, http: 401, error: "unauthorized" }, 401);
				if (p === "/ntfy/v1/health") return send({ healthy: ntfyHealthy }, ntfyHealthy ? 200 : 503);
				if (p === "/ntfy/v1/stats") return send({ messages: 1234, messages_rate: 0.0512 });
				if (p === "/ntfy/v1/account") return send({ username: "joel", role: "user" });
			}

			// Gluetun: X-API-Key
			if (p.startsWith("/gt/")) {
				if (req.headers["x-api-key"] !== KEY) return send("Unauthorized", 401, "text/plain");
				if (p === "/gt/v1/vpn/status" && !gluetunOld) return send({ status: "running" });
				if (p === "/gt/v1/openvpn/status" && gluetunOld) return send({ status: "stopped" });
				if (p === "/gt/v1/publicip/ip") return send({ public_ip: "185.1.2.3", country: "Switzerland", city: "Zurich", organization: "M247" });
				if (p === "/gt/v1/portforward" && !gluetunOld) return send({ port: 51413 });
				if (p === "/gt/v1/openvpn/portforwarded" && gluetunOld) return send({ port: 0 });
			}

			// What's Up Docker
			if (p === "/wud/api/containers")
				return send([
					{ id: "1", name: "jellyfin", displayName: "jellyfin", image: { name: "jellyfin/jellyfin", tag: { value: "10.9.1" } }, updateAvailable: true, updateKind: { kind: "tag", localValue: "10.9.1", remoteValue: "10.10.0" }, result: { tag: "10.10.0" } },
					{ id: "2", name: "pihole", displayName: "pihole", image: { name: "pihole/pihole", tag: { value: "latest" } }, updateAvailable: true, updateKind: { kind: "digest" } },
					{ id: "3", name: "nginx", displayName: "nginx", image: { name: "library/nginx", tag: { value: "1.27" } }, updateAvailable: false },
					{ id: "4", name: "private", displayName: "private", image: { name: "ghcr.io/me/private", tag: { value: "1.0" } }, updateAvailable: false, error: { message: "Unauthorized registry" } }
				]);

			// Watchtower: Bearer token
			if (p === "/wt/v1/metrics") {
				if (req.headers.authorization !== `Bearer ${KEY}`) return send("", 401, "text/plain");
				return send(
					"# HELP watchtower_containers_scanned Number of containers scanned for changes by watchtower during the last scan\n# TYPE watchtower_containers_scanned gauge\nwatchtower_containers_scanned 12\nwatchtower_containers_updated 2\nwatchtower_containers_failed 1\nwatchtower_scans_total 340\nwatchtower_scans_skipped 0\n",
					200,
					"text/plain; version=0.0.4"
				);
			}
			send({ error: "not found" }, 404);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test("monitoring plugins are registered and recognised", () => {
	for (const k of ["changedetection", "healthchecks", "gatus", "beszel", "netdata", "gotify", "ntfy", "gluetun", "whatsupdocker", "watchtower"]) assert.ok(plugins[k], k);
	assert.equal(guessKind("changedetection", "ghcr.io/dgtlmoon/changedetection.io"), "changedetection");
	assert.notEqual(guessKind("changedetection-playwright", "browserless/chrome"), "changedetection");
	assert.equal(guessKind("beszel", "henrygd/beszel"), "beszel");
	assert.notEqual(guessKind("beszel-agent", "henrygd/beszel-agent"), "beszel");
	assert.equal(guessKind("healthchecks", "healthchecks/healthchecks"), "healthchecks");
	assert.notEqual(guessKind("healthchecks-db", "postgres:16"), "healthchecks");
	assert.equal(guessKind("ntfy", "binwiederhier/ntfy"), "ntfy");
	assert.equal(guessKind("wud", "getwud/wud"), "whatsupdocker");
	assert.equal(guessKind("whatsupdocker", "fmartinou/whats-up-docker"), "whatsupdocker");
	assert.equal(guessKind("gluetun", "qmcgaw/gluetun"), "gluetun");
	assert.equal(guessKind("watchtower", "containrrr/watchtower"), "watchtower");
});

test("changedetection.io: watches, unviewed changes and errors", async () => {
	const r = await run("changedetection", "/cd", { apiKey: KEY });
	assert.equal(metric(r, "Watched").value, 3);
	assert.equal(metric(r, "changed").value, 1);
	assert.equal(metric(r, "errors").value, 1);
	assert.equal(metric(r, "errors").warn, true);
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["Broken", "bad"], ["Price", "warn"], ["https://shop.example.org/item", "ok"]]);
	assert.equal(r.items[2].sub, "shop.example.org");
	assert.deepEqual(r.warnings, ["Broken: Connection refused"]);
	await assert.rejects(run("changedetection", "/cd", {}), /API key missing/);
	await assert.rejects(run("changedetection", "/cd", { apiKey: "wrong" }), /Access denied/);
});

test("Healthchecks: up, late and down checks", async () => {
	const r = await run("healthchecks", "/hc", { apiKey: KEY });
	assert.equal(metric(r, "Checks up").value, "2/5");
	assert.equal(metric(r, "down").value, 1);
	assert.equal(metric(r, "late").value, 1);
	assert.equal(r.items[0].title, "Backup");
	assert.equal(r.items[0].status, "bad");
	assert.match(r.items[0].sub, /^down · 30 h$/);
	assert.equal(r.items[1].status, "warn");
	assert.deepEqual(r.warnings, ["Backup is down"]);
	await assert.rejects(run("healthchecks", "/hc", {}), /API key missing/);
	await assert.rejects(run("healthchecks", "/hc", { apiKey: "wrong" }), /Access denied/);
});

test("Gatus: endpoint state from the latest result", async () => {
	const r = await run("gatus", "/gatus");
	assert.equal(metric(r, "Endpoints up").value, "1/3");
	assert.equal(metric(r, "down").value, 1);
	assert.equal(metric(r, "Uptime").value, "50.0 %");
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["api", "bad"], ["core / website", "ok"], ["new", "warn"]]);
	assert.equal(r.items[0].sub, "context deadline exceeded");
	assert.equal(r.items[1].sub, "23 ms");
	assert.deepEqual(r.warnings, ["api is down"]);
	await assert.rejects(run("gatus", "/gatuspw"), /Login missing/);
	await assert.rejects(run("gatus", "/gatuspw", { username: "admin", password: "nope" }), /Access denied/);
	assert.equal(metric(await run("gatus", "/gatuspw", { username: "admin", password: KEY }), "Endpoints up").value, "1/3");
});

test("Beszel: logs in, keeps the token and logs in again when it expires", async () => {
	const secrets = { username: "me@example.com", password: KEY };
	const r = await run("beszel", "/bz", secrets);
	assert.equal(metric(r, "Systems up").value, "2/3");
	assert.equal(metric(r, "down").value, 1);
	assert.equal(metric(r, "CPU max").value, "56 %");
	assert.equal(metric(r, "Disk max").value, "93 %");
	assert.equal(metric(r, "Disk max").warn, true);
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["pi", "bad"], ["docker", "ok"], ["nas", "warn"]]);
	assert.equal(r.items[2].sub, "CPU 12 % · RAM 45 % · Disk 93 %");
	assert.deepEqual(r.warnings, ["pi is down"]);
	assert.equal(beszelLogins, 1);
	await run("beszel", "/bz", secrets);
	assert.equal(beszelLogins, 1, "token reused");
	beszelValid.clear(); // the token expires
	assert.equal(metric(await run("beszel", "/bz", secrets), "Systems up").value, "2/3");
	assert.equal(beszelLogins, 2);
	await assert.rejects(run("beszel", "/bz", { username: "me@example.com" }), /Login missing/);
	await assert.rejects(run("beszel", "/bz", { username: "me@example.com", password: "wrong" }), /Access denied/);
});

test("Netdata: alarms, CPU and RAM", async () => {
	const r = await run("netdata", "/nd");
	assert.equal(metric(r, "CPU").value, "15 %");
	assert.equal(metric(r, "RAM").value, "60 %");
	assert.equal(metric(r, "Warnings").value, 1);
	assert.equal(metric(r, "critical").value, 1);
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["disk space usage", "bad"], ["ram in use", "warn"]]);
	assert.equal(r.items[0].sub, "disk_space._ · 97%");
	assert.deepEqual(r.warnings, ["Netdata: disk space usage is critical (97%)"]);
});

test("Gotify: messages, apps and clients", async () => {
	const r = await run("gotify", "/gotify", { token: KEY });
	assert.equal(metric(r, "Messages").value, "2");
	assert.equal(metric(r, "Apps").value, 2);
	assert.equal(metric(r, "Clients").value, 1);
	assert.deepEqual(r.items[0], { title: "Alert", sub: "Server · 10 min", status: "warn" });
	assert.deepEqual(r.items[1], { title: "Backup done", sub: "Backup · 2 h", status: "ok" });
	await assert.rejects(run("gotify", "/gotify", {}), /Client token missing/);
	await assert.rejects(run("gotify", "/gotify", { token: "wrong" }), /Access denied/);
});

test("ntfy: health, stats and an optional token", async () => {
	let r = await run("ntfy", "/ntfy");
	assert.equal(val(metric(r, "Health")), "OK");
	assert.equal(metric(r, "Messages").value, 1234);
	assert.equal(metric(r, "Rate").value, "0.05/s");
	assert.equal(r.summary, null);
	r = await run("ntfy", "/ntfy", { token: KEY });
	assert.equal(r.summary, "joel");
	await assert.rejects(run("ntfy", "/ntfy", { token: "wrong" }), /Access denied/);
	ntfyHealthy = false;
	r = await run("ntfy", "/ntfy");
	ntfyHealthy = true;
	assert.equal(val(metric(r, "Health")), "Unhealthy");
	assert.equal(metric(r, "Health").warn, true);
	assert.equal(r.warnings.length, 1);
});

test("Gluetun: VPN status, public IP and forwarded port (new and old routes)", async () => {
	let r = await run("gluetun", "/gt", { apiKey: KEY });
	assert.equal(val(metric(r, "VPN")), "Running");
	assert.equal(metric(r, "VPN").warn, false);
	assert.equal(metric(r, "Public IP").value, "185.1.2.3");
	assert.equal(metric(r, "Country").value, "Switzerland");
	assert.equal(metric(r, "Forwarded port").value, 51413);
	assert.equal(r.summary, "Zurich, Switzerland · M247");
	gluetunOld = true;
	r = await run("gluetun", "/gt", { apiKey: KEY });
	gluetunOld = false;
	assert.equal(val(metric(r, "VPN")), "Stopped");
	assert.equal(metric(r, "Forwarded port"), undefined);
	assert.deepEqual(r.warnings, ["Gluetun VPN is stopped"]);
	await assert.rejects(run("gluetun", "/gt", {}), /API key missing/);
	await assert.rejects(run("gluetun", "/gt", { apiKey: "wrong" }), /Access denied/);
});

test("What's Up Docker: containers with updates and errors", async () => {
	const r = await run("whatsupdocker", "/wud");
	assert.equal(metric(r, "Containers").value, 4);
	assert.equal(metric(r, "Updates").value, 2);
	assert.equal(metric(r, "errors").value, 1);
	assert.deepEqual(r.items.map((i) => [i.title, i.sub, i.status]), [
		["private", "Unauthorized registry", "bad"],
		["jellyfin", "10.9.1 → 10.10.0", "warn"],
		["pihole", "new image", "warn"],
		["nginx", "library/nginx:1.27", "ok"]
	]);
	assert.equal(r.summary, "2 updates available");
});

test("Watchtower: metrics of the last scan", async () => {
	const r = await run("watchtower", "/wt", { token: KEY });
	assert.equal(metric(r, "Scanned").value, 12);
	assert.equal(metric(r, "updated").value, 2);
	assert.equal(metric(r, "failed").value, 1);
	assert.equal(metric(r, "failed").warn, true);
	assert.deepEqual(r.warnings, ["Watchtower could not update 1 container"]);
	await assert.rejects(run("watchtower", "/wt", {}), /API token missing/);
	await assert.rejects(run("watchtower", "/wt", { token: "wrong" }), /Access denied/);
});
