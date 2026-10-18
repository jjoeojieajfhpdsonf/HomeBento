"use strict";
// The storage and energy plugins (Unraid, OpenMediaVault, Synology, PeaNUT, Proxmox Backup Server,
// Kubernetes, evcc, OpenDTU) against a small fake server that answers like the real APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, json } = require("../lib/util");
const plugins = require("../lib/plugins");

const TOKEN = "s3cret";
const GiB = 2 ** 30;
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;
let base;
let server;
const seen = [];
let omvSession = "omv-1";
let omvLogins = 0;
let dsmSid = "sid-1";
let dsmLogins = 0;

const run = (kind, prefix, secrets = {}, service = { id: kind }) => plugins[kind].fetch({ url: `${base}${prefix}`, secrets, service, request, json });
const metric = (r, en) => r.metrics.find((m) => (typeof m.label === "string" ? m.label : m.label.en) === en);
const value = (m) => (m.value && typeof m.value === "object" ? m.value.en : m.value);

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
	});
}

const disk = (o) => ({ name: "disk1", status: "DISK_OK", temp: 34, numErrors: 0, fsSize: 1000, fsUsed: 500, type: "DATA", warning: 45, critical: 55, ...o });

test.before(async () => {
	server = http.createServer(async (req, res) => {
		const url = new URL(req.url, "http://x");
		const p = url.pathname;
		const body = await readBody(req);
		seen.push(`${req.method} ${p}${url.search}`);
		const send = (v, status = 200, headers = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(JSON.stringify(v));
		};

		// Unraid API: GraphQL with x-api-key
		if (p === "/unraid/graphql") {
			if (req.headers["x-api-key"] !== TOKEN) return send({ errors: [{ message: "Unauthorized", extensions: { code: "UNAUTHENTICATED" } }], data: null });
			const q = JSON.parse(body).query;
			if (/array/.test(q))
				return send({
					data: {
						array: {
							state: "STARTED",
							capacity: { kilobytes: { free: "3000", used: "7000", total: "10000" } },
							parities: [disk({ name: "parity", type: "PARITY", fsSize: null, fsUsed: null }), disk({ name: "parity2", status: "DISK_NP", type: "PARITY" })],
							disks: [disk({ name: "disk1" }), disk({ name: "disk2", status: "DISK_DSBL", temp: null })],
							caches: [disk({ name: "cache", type: "CACHE", temp: 50, fsSize: 100, fsUsed: 20 })]
						}
					}
				});
			if (/docker/.test(q)) return send({ data: { docker: { containers: [{ names: ["/plex"], state: "RUNNING", autoStart: true }, { names: ["/nextcloud"], state: "EXITED", autoStart: true }, { names: ["/old"], state: "EXITED", autoStart: false }] } } });
			// VMs are off: Unraid answers with an error and no data
			if (/vms/.test(q)) return send({ errors: [{ message: "VMs are not available" }], data: null });
		}
		// Unraid without the API: the web interface redirects to its login page
		if (p === "/unraid-old/graphql") {
			res.writeHead(302, { Location: "/login" });
			return res.end();
		}

		// OpenMediaVault RPC: session cookie after Session.login
		if (p === "/omv/rpc.php") {
			const rpc = JSON.parse(body);
			if (rpc.service === "Session" && rpc.method === "login") {
				if (rpc.params.username !== "admin" || rpc.params.password !== TOKEN) return send({ response: null, error: { code: 0, message: "Incorrect username or password." } }, 401);
				omvLogins++;
				return send({ response: { authenticated: true, username: "admin", permissions: { role: "admin" } }, error: null }, 200, { "Set-Cookie": [`X-OPENMEDIAVAULT-SESSIONID=${omvSession}; path=/; HttpOnly`] });
			}
			if (req.headers.cookie !== `X-OPENMEDIAVAULT-SESSIONID=${omvSession}`) return send({ response: null, error: { code: 5001, message: "Session not authenticated." } }, 401);
			if (rpc.service === "System" && rpc.method === "getInformation")
				return send({ response: { hostname: "nas", version: "7.4.2-1 (Sandworm)", cpuUtilization: 12.6, memTotal: String(8 * GiB), memUsed: String(2 * GiB), uptime: 2 * 86400 + 100, availablePkgUpdates: 3, rebootRequired: false }, error: null });
			if (rpc.service === "FileSystemMgmt" && rpc.method === "enumerateMountedFilesystems") {
				assert.equal(rpc.params.includeroot, true);
				return send({
					response: [
						{ devicefile: "/dev/sda1", label: "", mountpoint: "/", percentage: 40, available: String(20 * GiB), size: String(32 * GiB), usagewarnthreshold: 85 },
						{ devicefile: "/dev/sdb1", label: "data", mountpoint: "/srv/dev-disk-by-uuid-1", percentage: 91, available: String(100 * GiB), size: String(1100 * GiB), usagewarnthreshold: 85 }
					],
					error: null
				});
			}
			if (rpc.service === "Services" && rpc.method === "getStatus")
				return send({
					response: {
						total: 3,
						data: [
							{ name: "ssh", title: "SSH", enabled: true, running: true },
							{ name: "smb", title: "SMB/CIFS", enabled: true, running: false },
							{ name: "nfs", title: "NFS", enabled: false, running: false }
						]
					},
					error: null
				});
			return send({ response: null, error: { code: 1, message: "Unknown method" } }, 500);
		}

		// Synology DSM Web API
		if (p === "/dsm/webapi/query.cgi")
			return send({
				success: true,
				data: {
					"SYNO.API.Auth": { path: "entry.cgi", minVersion: 1, maxVersion: 7 },
					"SYNO.Core.System.Utilization": { path: "entry.cgi", minVersion: 1, maxVersion: 1 },
					"SYNO.Storage.CGI.Storage": { path: "entry.cgi", minVersion: 1, maxVersion: 1 },
					"SYNO.DSM.Info": { path: "entry.cgi", minVersion: 1, maxVersion: 2 }
				}
			});
		if (p === "/dsm/webapi/entry.cgi") {
			if (req.method === "POST") {
				const f = new URLSearchParams(body);
				assert.equal(f.get("api"), "SYNO.API.Auth");
				assert.equal(f.get("format"), "sid");
				if (f.get("account") !== "admin" || f.get("passwd") !== TOKEN) return send({ success: false, error: { code: 400 } });
				dsmLogins++;
				return send({ success: true, data: { sid: dsmSid } });
			}
			if (url.searchParams.get("_sid") !== dsmSid) return send({ success: false, error: { code: 119 } });
			const api = url.searchParams.get("api");
			if (api === "SYNO.Core.System.Utilization") return send({ success: true, data: { cpu: { user_load: 7, system_load: 3, other_load: 1 }, memory: { real_usage: 42, total_real: 4000000, avail_real: 2300000 } } });
			if (api === "SYNO.Storage.CGI.Storage")
				return send({
					success: true,
					data: {
						volumes: [
							{ id: "volume_1", vol_path: "/volume1", status: "normal", size: { total: String(4000 * GiB), used: String(3000 * GiB) } },
							{ id: "volume_2", vol_path: "/volume2", status: "degraded", size: { total: String(1000 * GiB), used: String(100 * GiB) } }
						],
						disks: [
							{ id: "sata1", name: "Drive 1", model: "WD40EFRX ", status: "normal", smart_status: "normal", temp: 33 },
							{ id: "sata2", name: "Drive 2", model: "WD40EFRX", status: "crashed", smart_status: "failing", temp: 36 }
						]
					}
				});
			if (api === "SYNO.DSM.Info") return send({ success: true, data: { model: "DS920+", version_string: "DSM 7.2.1-69057", uptime: 5 * 86400 + 30 } });
		}

		// PeaNUT REST API; /nutpw needs basic auth
		const nut = /^\/(nut|nutpw)\/api\/v1\/devices(?:\/([^/]+))?$/.exec(p);
		if (nut) {
			if (nut[1] === "nutpw" && req.headers.authorization !== basic("admin", TOKEN)) return send({ error: "Unauthorized" }, 401);
			const ups = { "battery.charge": 87, "battery.runtime": 1500, "ups.load": 23, "ups.status": "OB DISCHRG", "device.mfr": "APC", "device.model": "Back-UPS 700" };
			const ups2 = { "battery.charge": "100", "battery.runtime": "3600", "ups.load": "10", "ups.status": "OL" };
			if (!nut[2]) return send([url.searchParams.get("meta") === "true" ? { ...ups, "peanut.device_id": "ups" } : ups, { ...ups2, "peanut.device_id": "rack" }]);
			if (nut[2] === "ups") return send(ups);
			if (nut[2] === "rack") return send(ups2);
			return send({ error: "Device not found" }, 404);
		}

		// Proxmox Backup Server: PBSAPIToken header
		if (p.startsWith("/pbs/")) {
			if (req.headers.authorization !== `PBSAPIToken=root@pam!homebento:${TOKEN}`) return send({ data: null, message: "authentication failed" }, 401);
			const now = Math.floor(Date.now() / 1000);
			if (p === "/pbs/api2/json/status/datastore-usage")
				return send({
					data: [
						{ store: "main", total: 1000, used: 920, avail: 80 },
						{ store: "offsite", total: 2000, used: 500, avail: 1500 }
					]
				});
			if (p === "/pbs/api2/json/nodes/localhost/tasks") {
				assert.ok(Number(url.searchParams.get("since")) > now - 86400 - 60);
				return send({
					data: [
						{ upid: "1", worker_type: "backup", worker_id: "main:vm/100", starttime: now - 7200, endtime: now - 7000, status: "OK" },
						{ upid: "2", worker_type: "backup", worker_id: "main:ct/200", starttime: now - 3600, endtime: now - 3500, status: "backup failed: connection reset" },
						{ upid: "3", worker_type: "verificationjob", worker_id: "main:v-1", starttime: now - 600, endtime: now - 300, status: "WARNINGS: 1" },
						{ upid: "4", worker_type: "garbage_collection", worker_id: "main", starttime: now - 60 }
					],
					total: 4
				});
			}
		}

		// Kubernetes API server: bearer token
		if (p.startsWith("/k8s/")) {
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ kind: "Status", status: "Failure", message: "Unauthorized", code: 401 }, 401);
			if (p === "/k8s/version") return send({ major: "1", minor: "30", gitVersion: "v1.30.4+k3s1" });
			const ready = (s) => [{ type: "MemoryPressure", status: "False" }, { type: "Ready", status: s }];
			if (p === "/k8s/api/v1/nodes")
				return send({
					items: [
						{ metadata: { name: "cp1" }, spec: {}, status: { conditions: ready("True"), nodeInfo: { kubeletVersion: "v1.30.4+k3s1" } } },
						{ metadata: { name: "worker1" }, spec: { unschedulable: true }, status: { conditions: ready("Unknown") } }
					]
				});
			if (p === "/k8s/api/v1/pods") {
				assert.equal(url.searchParams.get("fieldSelector"), "status.phase!=Succeeded");
				const cs = (ready, state = { running: {} }, restartCount = 0) => [{ name: "c", ready, state, restartCount }];
				return send({
					items: [
						{ metadata: { namespace: "default", name: "web-1" }, spec: { nodeName: "cp1" }, status: { phase: "Running", containerStatuses: cs(true) } },
						{ metadata: { namespace: "default", name: "web-2" }, spec: { nodeName: "cp1" }, status: { phase: "Running", containerStatuses: cs(false, { waiting: { reason: "CrashLoopBackOff" } }, 12) } },
						{ metadata: { namespace: "media", name: "plex-0" }, spec: { nodeName: "cp1" }, status: { phase: "Pending", containerStatuses: cs(false, { waiting: { reason: "ContainerCreating" } }) } },
						{ metadata: { namespace: "kube-system", name: "coredns" }, spec: { nodeName: "cp1" }, status: { phase: "Running", containerStatuses: cs(true) } }
					]
				});
			}
		}

		// evcc: new format (no "result", grid object, battery list) and old format
		if (p === "/evcc/api/state")
			return send({
				siteTitle: "Home",
				pvPower: 5230,
				homePower: 830,
				grid: { power: -2400 },
				batteryConfigured: true,
				batterySoc: 76.4,
				vehicles: { ev1: { title: "ID.3" } },
				loadpoints: [
					{ title: "Garage", charging: true, connected: true, chargePower: 11040, vehicleName: "ev1", vehicleSoc: 63.6, mode: "pv" },
					{ title: "Carport", charging: false, connected: false, chargePower: 0, vehicleSoc: 0, mode: "off" }
				]
			});
		if (p === "/evcc-old/api/state") return send({ result: { pvPower: 0, homePower: 450, gridPower: 450, batteryConfigured: false, batterySoc: 0, loadpoints: [{ title: "Wallbox", charging: false, connected: true, chargePower: 0, vehicleTitle: "Zoe", vehicleSoc: 80, mode: "now" }] } });

		// OpenDTU live data; /dtupw needs basic auth admin:<password>
		const dtu = /^\/(dtu|dtupw)\/api\/livedata\/status$/.exec(p);
		if (dtu) {
			if (dtu[1] === "dtupw" && req.headers.authorization !== basic("admin", TOKEN)) {
				res.writeHead(401);
				return res.end();
			}
			return send({
				inverters: [
					{ serial: "1141", name: "Roof", order: 0, reachable: true, producing: true, poll_enabled: true, limit_relative: 100, limit_absolute: 800, AC: { 0: { Power: { v: 612.3, u: "W", d: 1 } } } },
					{ serial: "1142", name: "Balcony", order: 1, reachable: true, producing: false, poll_enabled: true, limit_relative: 50, limit_absolute: 300 },
					{ serial: "1143", name: "Garage", order: 2, reachable: false, producing: false, poll_enabled: true, limit_relative: 100, limit_absolute: 600 }
				],
				total: { Power: { v: 1234.5, u: "W", d: 1 }, YieldDay: { v: 4210, u: "Wh", d: 0 }, YieldTotal: { v: 1234.56, u: "kWh", d: 2 } },
				hints: { time_sync: false, radio_problem: true, default_password: false }
			});
		}

		send({ error: "not found" }, 404);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test("all storage plugins are loaded", () => {
	for (const k of ["unraid", "openmediavault", "synology", "peanut", "proxmoxbackup", "kubernetes", "evcc", "opendtu"]) {
		assert.ok(plugins[k], k);
		assert.ok(plugins[k].fields.every((f) => !["password", "apiKey", "token", "tokenSecret"].includes(f.key) || f.secret), `${k}: secret fields`);
	}
	assert.ok(plugins.unraid.match.test("unraid"));
	assert.ok(plugins.peanut.match.test("brandawg93/peanut"));
	assert.ok(plugins.opendtu.match.test("opendtu"));
	assert.ok(!plugins.kubernetes.match.test("postgres"));
});

test("Unraid: array state, used %, Docker and disks", async () => {
	const r = await run("unraid", "/unraid", { apiKey: TOKEN });
	assert.equal(value(metric(r, "Array")), "Started");
	assert.equal(metric(r, "Array used").value, "70 %");
	assert.equal(metric(r, "Containers running").value, "1/3");
	assert.equal(metric(r, "VMs running"), undefined); // VMs are off
	assert.deepEqual(
		r.items.map((i) => i.title),
		["disk2", "cache", "parity", "disk1"]
	);
	assert.equal(r.items[0].status, "bad");
	assert.equal(r.items[1].status, "warn"); // 50 °C ≥ warning 45
	assert.match(r.items[3].sub, /Data · OK · 50 % · 34 °C/);
	assert.ok(!r.items.some((i) => i.title === "parity2")); // empty slot
	assert.ok(r.warnings.includes("Disk disk2 is disabled"));
	assert.ok(r.warnings.includes("nextcloud is not running"));
	assert.ok(!r.warnings.some((w) => /old/.test(w)));
	assert.equal(r.summary, "Disk problem");
});

test("Unraid: missing or wrong key, no API", async () => {
	await assert.rejects(run("unraid", "/unraid", {}), /API key missing/);
	await assert.rejects(run("unraid", "/unraid", { apiKey: "nope" }), /Access denied/);
	await assert.rejects(run("unraid", "/unraid-old", { apiKey: TOKEN }), /Unraid Connect plugin/);
});

test("OpenMediaVault: login, file systems, services and re-login", async () => {
	const r = await run("openmediavault", "/omv", { username: "admin", password: TOKEN });
	assert.equal(metric(r, "Services running").value, "1/2");
	assert.equal(metric(r, "Services running").warn, true);
	assert.equal(metric(r, "Storage used").value, "91 %");
	assert.equal(metric(r, "CPU").value, "13 %");
	assert.equal(metric(r, "RAM").value, "25 %");
	assert.deepEqual(r.items[0], { title: "SMB/CIFS", sub: "enabled but not running", status: "bad" });
	assert.equal(r.items[1].title, "data");
	assert.equal(r.items[1].status, "warn");
	assert.match(r.items[1].sub, /91 % · 100 GB free/);
	assert.equal(r.items[2].title, "/");
	assert.deepEqual(r.warnings, ["Service SMB/CIFS is not running", "data is 91 % full"]);
	assert.equal(r.summary, "OMV 7.4.2-1 · 3 updates");
	assert.equal(omvLogins, 1);

	// the session is reused …
	await run("openmediavault", "/omv", { username: "admin", password: TOKEN });
	assert.equal(omvLogins, 1);
	// … and renewed after it expired
	omvSession = "omv-2";
	await run("openmediavault", "/omv", { username: "admin", password: TOKEN });
	assert.equal(omvLogins, 2);
});

test("OpenMediaVault: missing or wrong login", async () => {
	await assert.rejects(run("openmediavault", "/omv", { username: "admin" }), /missing/);
	await assert.rejects(run("openmediavault", "/omv", { username: "admin", password: "wrong" }), /Access denied/);
});

test("Synology: utilization, volumes, disks, uptime and re-login", async () => {
	const r = await run("synology", "/dsm", { account: "admin", password: TOKEN });
	assert.equal(metric(r, "Volume used").value, "75 %");
	assert.equal(metric(r, "Volume used").warn, true); // volume2 degraded
	assert.equal(metric(r, "CPU").value, "11 %");
	assert.equal(metric(r, "RAM").value, "42 %");
	assert.equal(metric(r, "Uptime").value, "5 d");
	assert.deepEqual(r.items[0], { title: "volume1", sub: "normal · 75 % · 1000 GB free", status: "ok" });
	assert.equal(r.items[1].status, "warn");
	assert.deepEqual(r.items[2], { title: "Drive 2", sub: "WD40EFRX · crashed · 36 °C", status: "bad" });
	assert.deepEqual(r.warnings, ["volume2 is degraded", "Drive 2 is failing"]);
	assert.equal(r.summary, "DS920+ · DSM 7.2.1-69057");
	assert.equal(dsmLogins, 1);
	// the password goes in the POST body, never in the address
	assert.ok(!seen.some((s) => s.includes(TOKEN)));

	await run("synology", "/dsm", { account: "admin", password: TOKEN });
	assert.equal(dsmLogins, 1);
	dsmSid = "sid-2";
	await run("synology", "/dsm", { account: "admin", password: TOKEN });
	assert.equal(dsmLogins, 2);
});

test("Synology: missing or wrong login", async () => {
	await assert.rejects(run("synology", "/dsm", {}), /missing/);
	await assert.rejects(run("synology", "/dsm", { account: "admin", password: "wrong" }), /Access denied/);
});

test("PeaNUT: one UPS on battery", async () => {
	const r = await run("peanut", "/nut", { device: "ups" });
	assert.equal(value(metric(r, "Status")), "On battery");
	assert.equal(metric(r, "Status").warn, true);
	assert.equal(metric(r, "Battery").value, "87 %");
	assert.equal(metric(r, "Runtime").value, "25 min");
	assert.equal(metric(r, "Load").value, "23 %");
	assert.deepEqual(r.items, [{ title: "ups", sub: "on battery, discharging · 87 % · 25 min · load 23 %", status: "warn" }]);
	assert.deepEqual(r.warnings, ["ups is running on battery"]);
	assert.equal(r.summary, "APC Back-UPS 700");
});

test("PeaNUT: all UPS, login, unknown UPS", async () => {
	const r = await run("peanut", "/nutpw", { username: "admin", password: TOKEN });
	assert.deepEqual(
		r.items.map((i) => [i.title, i.status]),
		[
			["ups", "warn"],
			["rack", "ok"]
		]
	);
	assert.equal(metric(r, "Battery").value, "87 %"); // lowest
	assert.equal(metric(r, "Load").value, "23 %"); // highest
	const ok = await run("peanut", "/nut", { device: "rack" });
	assert.equal(value(metric(ok, "Status")), "Online");
	assert.equal(metric(ok, "Runtime").value, "1 h 0 min");
	assert.deepEqual(ok.warnings, []);
	await assert.rejects(run("peanut", "/nutpw", {}), /asks for a login/);
	await assert.rejects(run("peanut", "/nutpw", { username: "admin", password: "x" }), /Access denied/);
	await assert.rejects(run("peanut", "/nut", { device: "nope" }), /not found/);
});

test("Proxmox Backup Server: datastores and failed tasks", async () => {
	const r = await run("proxmoxbackup", "/pbs", { tokenId: "root@pam!homebento", tokenSecret: TOKEN });
	assert.equal(metric(r, "Datastore used").value, "92 %");
	assert.equal(metric(r, "Datastore used").warn, true);
	assert.equal(metric(r, "Backups OK (24 h)").value, "1/2");
	assert.equal(metric(r, "Failed (24 h)").value, 1);
	assert.equal(value(metric(r, "Last backup")), "1 h ago");
	assert.deepEqual(r.items[0], { title: "Backup main:ct/200", sub: "backup failed: connection reset", status: "bad" });
	assert.deepEqual(r.items[1], { title: "main", sub: "92 % · 80 B free", status: "warn" });
	assert.equal(r.items[3].title, "Verify job main:v-1");
	assert.equal(r.items[3].status, "warn");
	assert.deepEqual(r.warnings, ["Datastore main is 92 % full", "Backup main:ct/200 failed"]);
	assert.equal(r.summary, "1 failed task in 24 h");
});

test("Proxmox Backup Server: missing or wrong token", async () => {
	await assert.rejects(run("proxmoxbackup", "/pbs", {}), /API token missing/);
	await assert.rejects(run("proxmoxbackup", "/pbs", { tokenId: "root", tokenSecret: TOKEN }), /user@realm!name/);
	await assert.rejects(run("proxmoxbackup", "/pbs", { tokenId: "root@pam!homebento", tokenSecret: "x" }), /Access denied/);
});

test("Kubernetes: nodes, pods and not-ready pods", async () => {
	const r = await run("kubernetes", "/k8s", { token: TOKEN });
	assert.equal(metric(r, "Nodes ready").value, "1/2");
	assert.equal(metric(r, "Nodes ready").warn, true);
	assert.equal(metric(r, "Pods running").value, "3/4");
	assert.equal(metric(r, "Pods not ready").value, 2);
	assert.equal(metric(r, "Version").value, "v1.30.4");
	assert.deepEqual(r.items[0], { title: "Node worker1", sub: "not ready · cordoned", status: "bad" });
	assert.deepEqual(r.items[1], { title: "default/web-2", sub: "CrashLoopBackOff · 12 restarts · cp1", status: "bad" });
	assert.deepEqual(r.items[2], { title: "media/plex-0", sub: "ContainerCreating · cp1", status: "warn" });
	assert.deepEqual(r.warnings, ["Node worker1 is not ready", "1 pod failing: web-2"]);
	assert.equal(r.summary, "2 pods not ready");
});

test("Kubernetes: missing or wrong token", async () => {
	await assert.rejects(run("kubernetes", "/k8s", {}), /Token missing/);
	await assert.rejects(run("kubernetes", "/k8s", { token: "x" }), /Access denied/);
});

test("evcc: power flows, battery and loadpoints", async () => {
	const r = await run("evcc", "/evcc");
	assert.equal(metric(r, "PV").value, "5.2 kW");
	assert.equal(metric(r, "Home").value, "830 W");
	assert.equal(metric(r, "Grid export").value, "2.4 kW");
	assert.equal(metric(r, "Home battery").value, "76 %");
	assert.deepEqual(r.items, [
		{ title: "Garage", sub: "charging 11.0 kW · ID.3 · 64 % · pv", status: "ok" },
		{ title: "Carport", sub: "not connected · off", status: "ok" }
	]);
	assert.equal(r.summary, "ID.3 charging 11.0 kW");

	const old = await run("evcc", "/evcc-old");
	assert.equal(metric(old, "Grid import").value, "450 W");
	assert.equal(metric(old, "Home battery"), undefined);
	assert.equal(metric(old, "Charging").value, "0 W");
	assert.equal(old.items[0].sub, "connected · Zoe · 80 % · now");
	await assert.rejects(run("evcc", "/nothing"), /HTTP 404/);
});

test("OpenDTU: power, yield and inverters", async () => {
	const r = await run("opendtu", "/dtu");
	assert.equal(metric(r, "Power").value, "1.2 kW");
	assert.equal(metric(r, "Today").value, "4.2 kWh");
	assert.equal(metric(r, "Total").value, "1.23 MWh");
	assert.equal(metric(r, "Inverters producing").value, "1/3");
	assert.deepEqual(r.items, [
		{ title: "Roof", sub: "producing · 612 W", status: "ok" },
		{ title: "Balcony", sub: "reachable · limit 50 %", status: "ok" },
		{ title: "Garage", sub: "not reachable", status: "warn" }
	]);
	assert.equal(r.warnings.length, 1);
	assert.match(r.warnings[0], /radio problem/);
});

test("OpenDTU: login when read-only access is off", async () => {
	const r = await run("opendtu", "/dtupw", { password: TOKEN });
	assert.equal(metric(r, "Power").value, "1.2 kW");
	await assert.rejects(run("opendtu", "/dtupw", {}), /Password missing/);
	await assert.rejects(run("opendtu", "/dtupw", { password: "x" }), /Access denied/);
});
