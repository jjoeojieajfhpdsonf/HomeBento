"use strict";
// The server plugins (Proxmox, TrueNAS, Glances, Portainer, Syncthing, Scrutiny) against a small
// fake server that answers like the real APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, json } = require("../lib/util");
const plugins = require("../lib/plugins");

const TOKEN = "s3cret";
const GiB = 2 ** 30;
const MY_ID = "AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA-AAAAAAA";
const DEV_B = "BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB-BBBBBBB";
const DEV_C = "CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC-CCCCCCC";
let base;
let server;
let glancesV3Only = false;
const seen = [];

const run = (kind, prefix, secrets = {}, service = { id: kind }) => plugins[kind].fetch({ url: `${base}${prefix}`, secrets, service, request, json });
const metric = (r, en) => r.metrics.find((m) => (typeof m.label === "string" ? m.label : m.label.en) === en);

test.before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		const p = url.pathname;
		seen.push(`${req.method} ${p}${url.search}`);
		const send = (v, status = 200) => {
			res.writeHead(status, { "Content-Type": "application/json" });
			res.end(JSON.stringify(v));
		};

		// Proxmox VE: 401 without a valid PVEAPIToken header
		if (p.startsWith("/pve/")) {
			if (req.headers.authorization !== `PVEAPIToken=root@pam!homebento=${TOKEN}`) {
				res.writeHead(401, "authentication failure");
				return res.end();
			}
			if (p === "/pve/api2/json/cluster/resources")
				return send({
					data: [
						{ id: "node/pve1", type: "node", node: "pve1", status: "online", cpu: 0.1, maxcpu: 8, mem: 8 * GiB, maxmem: 32 * GiB, uptime: 1000 },
						{ id: "node/pve2", type: "node", node: "pve2", status: "online", cpu: 0.5, maxcpu: 8, mem: 24 * GiB, maxmem: 32 * GiB, uptime: 1000 },
						{ id: "node/pve3", type: "node", node: "pve3", status: "offline" },
						{ id: "qemu/100", type: "qemu", vmid: 100, name: "homeassistant", node: "pve1", status: "running", cpu: 0.031, maxcpu: 2, mem: GiB, maxmem: 4 * GiB, template: 0 },
						{ id: "qemu/101", type: "qemu", vmid: 101, name: "windows", node: "pve2", status: "stopped", cpu: 0, maxcpu: 4, mem: 0, maxmem: 8 * GiB, template: 0 },
						{ id: "qemu/9000", type: "qemu", vmid: 9000, name: "debian-template", node: "pve1", status: "stopped", template: 1 },
						{ id: "lxc/200", type: "lxc", vmid: 200, name: "pihole", node: "pve1", status: "running", cpu: 0.005, maxcpu: 1, mem: 128 * 2 ** 20, maxmem: 512 * 2 ** 20 },
						{ id: "storage/pve1/local", type: "storage", storage: "local", node: "pve1", status: "available", disk: 10, maxdisk: 100 }
					]
				});
		}

		// TrueNAS: Bearer API key, 401 otherwise
		if (p.startsWith("/nas/")) {
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ message: "Not authenticated" }, 401);
			if (p === "/nas/api/v2.0/system/info") return send({ version: "TrueNAS-SCALE-24.04.2", hostname: "nas", uptime_seconds: 3 * 86400 + 5000, uptime: "3 days, 1:23:20", physmem: 32 * GiB, cores: 8 });
			if (p === "/nas/api/v2.0/pool")
				return send([
					{ id: 1, name: "tank", guid: "1", status: "ONLINE", healthy: true, path: "/mnt/tank", size: 1000, allocated: 620, free: 380 },
					{ id: 2, name: "backup", guid: "2", status: "DEGRADED", healthy: false, path: "/mnt/backup", size: 2000, allocated: 500, free: 1500 }
				]);
			if (p === "/nas/api/v2.0/alert/list")
				return send([
					{ uuid: "a", klass: "VolumeStatus", level: "CRITICAL", formatted: "Pool backup state is DEGRADED: <b>One or more devices are faulted</b>", dismissed: false, datetime: { $date: Date.now() } },
					{ uuid: "b", klass: "HasUpdate", level: "INFO", formatted: "Update available", dismissed: false },
					{ uuid: "c", klass: "SMART", level: "WARNING", formatted: "Old alert", dismissed: true }
				]);
		}

		// Glances v4 (and v3 when glancesV3Only), basic auth glances:pw on /glpw
		const gl = /^\/(gl|glpw)\/api\/([34])\/(\w+)$/.exec(p);
		if (gl) {
			if (gl[1] === "glpw" && req.headers.authorization !== `Basic ${Buffer.from("glances:pw").toString("base64")}`) return send({ detail: "Incorrect username or password" }, 401);
			if (gl[2] === "4" && glancesV3Only) return send({ detail: "Not Found" }, 404);
			const plugin = gl[3];
			if (plugin === "cpu") return send({ total: 23.4, user: 15.1, system: 5.2, idle: 76.6, cpucore: 4 });
			if (plugin === "mem") return send({ total: 16 * GiB, available: 4 * GiB, percent: 75.2, used: 12 * GiB, free: 4 * GiB });
			if (plugin === "load") return send({ min1: 0.523, min5: 0.61, min15: 0.7, cpucore: 4 });
			if (plugin === "fs")
				return send([
					{ device_name: "/dev/sda1", fs_type: "ext4", mnt_point: "/", size: 100 * GiB, used: 41 * GiB, free: 59 * GiB, percent: 41.0, key: "mnt_point" },
					{ device_name: "/dev/sda1", fs_type: "ext4", mnt_point: "/etc/hosts", size: 100 * GiB, used: 41 * GiB, free: 59 * GiB, percent: 41.0, key: "mnt_point" },
					{ device_name: "/dev/sdb1", fs_type: "xfs", mnt_point: "/mnt/data", size: 4000 * GiB, used: 3720 * GiB, free: 280 * GiB, percent: 93.0, key: "mnt_point" }
				]);
			if (plugin === "sensors")
				return send([
					{ label: "Package id 0", value: 48, warning: 80, critical: 100, unit: "C", type: "temperature_core", key: "label" },
					{ label: "nvme0", value: 82, warning: 70, critical: 85, unit: "C", type: "temperature_core", key: "label" },
					{ label: "fan1", value: 1200, unit: "R", type: "fan_speed", key: "label" }
				]);
		}

		// Portainer: X-API-Key, endpoint 1 local Docker, 2 agent (proxy fails → snapshot), 3 down
		if (p.startsWith("/port/")) {
			if (req.headers["x-api-key"] !== TOKEN) return send({ message: "Unauthorized", details: "A valid authorisation token is missing" }, 401);
			if (p === "/port/api/endpoints")
				return send([
					{ Id: 1, Name: "local", Type: 1, Status: 1, URL: "unix:///var/run/docker.sock", Snapshots: [{ RunningContainerCount: 0, StoppedContainerCount: 0 }] },
					{ Id: 2, Name: "nas", Type: 2, Status: 1, URL: "tcp://nas:9001", Snapshots: [{ RunningContainerCount: 4, StoppedContainerCount: 1, UnhealthyContainerCount: 0 }] },
					{ Id: 3, Name: "pi", Type: 2, Status: 2, URL: "tcp://pi:9001", Snapshots: [{ RunningContainerCount: 9, StoppedContainerCount: 0 }] }
				]);
			if (p === "/port/api/endpoints/1/docker/containers/json" && url.searchParams.get("all") === "1")
				return send([
					{ Id: "a", Names: ["/jellyfin"], Image: "jellyfin/jellyfin", State: "running", Status: "Up 2 hours (healthy)" },
					{ Id: "b", Names: ["/sonarr"], Image: "linuxserver/sonarr", State: "running", Status: "Up 3 days (unhealthy)" },
					{ Id: "c", Names: ["/old"], Image: "busybox", State: "exited", Status: "Exited (0) 2 weeks ago" }
				]);
			if (p === "/port/api/endpoints/2/docker/containers/json") return send({ message: "Unable to proxy the request via the Docker socket" }, 502);
		}

		// Syncthing: X-API-Key, 403 otherwise
		if (p.startsWith("/st/")) {
			if (req.headers["x-api-key"] !== TOKEN) {
				res.writeHead(403, { "Content-Type": "text/plain" });
				return res.end("Forbidden\n");
			}
			if (p === "/st/rest/system/status") return send({ myID: MY_ID, uptime: 12345, goroutines: 50, startTime: new Date().toISOString() });
			if (p === "/st/rest/system/connections")
				return send({
					connections: {
						[DEV_B]: { connected: true, paused: false, address: "192.168.1.5:22000", clientVersion: "v1.27.0", type: "tcp-client" },
						[DEV_C]: { connected: false, paused: false, address: "", clientVersion: "" }
					},
					total: { inBytesTotal: 1, outBytesTotal: 2 }
				});
			if (p === "/st/rest/db/completion") return send({ completion: 99.95, globalBytes: 1000, needBytes: 1, globalItems: 10, needItems: 1, needDeletes: 0, remoteState: "valid", sequence: 12 });
			if (p === "/st/rest/config/folders")
				return send([
					{ id: "abcd-1234", label: "Photos", path: "/data/photos", type: "sendreceive", paused: false, devices: [{ deviceID: MY_ID }, { deviceID: DEV_B }, { deviceID: DEV_C }] },
					{ id: "efgh-5678", label: "Documents", path: "/data/docs", type: "sendreceive", paused: false, devices: [{ deviceID: MY_ID }, { deviceID: DEV_B }] },
					{ id: "ijkl-9012", label: "", path: "/data/old", type: "sendonly", paused: true, devices: [{ deviceID: MY_ID }] }
				]);
			if (p === "/st/rest/db/status") {
				const f = url.searchParams.get("folder");
				if (f === "abcd-1234") return send({ state: "syncing", globalBytes: 1000, needBytes: 250, errors: 2, pullErrors: 2 });
				if (f === "efgh-5678") return send({ state: "idle", globalBytes: 500, needBytes: 0, errors: 0, pullErrors: 0 });
				return send({ error: "no such folder" }, 404);
			}
			if (p === "/st/rest/system/error") return send({ errors: null });
		}

		// Scrutiny: no login
		if (p === "/scr/api/summary")
			return send({
				success: true,
				data: {
					summary: {
						"0x5000c500a1b2c3d4": { device: { wwn: "0x5000c500a1b2c3d4", device_name: "sda", model_name: "ST4000VN008", host_id: "", device_status: 0, archived: false }, smart: { collector_date: new Date().toISOString(), temp: 34, power_on_hours: 21000 } },
						"0x5000c500a1b2c3d5": { device: { wwn: "0x5000c500a1b2c3d5", device_name: "sdb", model_name: "WDC WD40EFRX", host_id: "", device_status: 3, archived: false }, smart: { collector_date: new Date().toISOString(), temp: 57, power_on_hours: 43000 } },
						"0x5000c500a1b2c3d6": { device: { wwn: "0x5000c500a1b2c3d6", device_name: "sdc", model_name: "Old", device_status: 1, archived: true }, smart: { temp: 30 } }
					}
				}
			});
		if (p === "/scrbroken/api/summary") return send({ success: false }, 200);

		send({ error: "not found" }, 404);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test("all six plugins are loaded with the plugin interface", () => {
	for (const kind of ["proxmox", "truenas", "glances", "portainer", "syncthing", "scrutiny"]) {
		const p = plugins[kind];
		assert.ok(p, `${kind} loaded`);
		assert.equal(typeof p.fetch, "function");
		assert.ok(p.match instanceof RegExp);
		assert.match(p.repo, /^[\w.-]+\/[\w.-]+$/);
		for (const f of p.fields) assert.ok(f.key && f.label);
	}
	assert.ok(plugins.proxmox.match.test("proxmox-ve"));
	assert.ok(plugins.truenas.match.test("truenas scale"));
	assert.ok(plugins.glances.match.test("nicolargo/glances:latest-full"));
	assert.ok(plugins.portainer.match.test("portainer/portainer-ce"));
	assert.ok(plugins.syncthing.match.test("syncthing/syncthing"));
	assert.ok(plugins.scrutiny.match.test("ghcr.io/analogj/scrutiny:master-omnibus"));
	// the tokens are marked secret so they stay on the server
	assert.ok(plugins.proxmox.fields.find((f) => f.key === "tokenSecret").secret);
	assert.ok(!plugins.proxmox.fields.find((f) => f.key === "tokenId").secret);
	for (const kind of ["truenas", "portainer", "syncthing"]) assert.ok(plugins[kind].fields.find((f) => f.key === "apiKey").secret);
	assert.ok(plugins.glances.fields.find((f) => f.key === "password").secret);
});

test("Proxmox: guests, nodes and cluster load", async () => {
	const r = await run("proxmox", "/pve", { tokenId: "root@pam!homebento", tokenSecret: TOKEN });
	assert.equal(metric(r, "VMs & LXC running").value, "2/3"); // the template is not counted
	assert.equal(metric(r, "Nodes online").value, "2/3");
	assert.equal(metric(r, "Nodes online").warn, true);
	assert.equal(metric(r, "CPU").value, "30 %"); // (0.1·8 + 0.5·8) / 16
	assert.equal(metric(r, "RAM").value, "50 %"); // 32 / 64 GiB
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["windows", "warn"], ["homeassistant", "ok"], ["pihole", "ok"]]);
	assert.equal(r.items[1].sub, "VM 100 · pve1 · CPU 3 % · RAM 25 %");
	assert.equal(r.items[0].sub, "VM 101 · pve2 · stopped");
	assert.deepEqual(r.warnings, ["Node pve3 is offline"]);
});

test("Proxmox: missing, malformed and wrong token", async () => {
	await assert.rejects(run("proxmox", "/pve", {}), /API token missing/);
	await assert.rejects(run("proxmox", "/pve", { tokenId: "root@pam", tokenSecret: TOKEN }), /user@realm!name/);
	await assert.rejects(run("proxmox", "/pve", { tokenId: "root@pam!homebento", tokenSecret: "wrong" }), /Access denied/);
});

test("TrueNAS: pools, alerts, uptime and version", async () => {
	const r = await run("truenas", "/nas", { apiKey: TOKEN });
	assert.equal(metric(r, "Pools healthy").value, "1/2");
	assert.equal(metric(r, "Pools healthy").warn, true);
	assert.equal(metric(r, "Alerts").value, 2); // the dismissed one is ignored
	assert.equal(metric(r, "Alerts").warn, true);
	assert.equal(metric(r, "Uptime").value, "3 d");
	assert.equal(metric(r, "Version").value, "24.04.2");
	assert.deepEqual(r.items, [
		{ title: "backup", sub: "DEGRADED · 25 %", status: "warn" },
		{ title: "tank", sub: "ONLINE · 62 %", status: "ok" }
	]);
	assert.deepEqual(r.warnings, ["Pool backup is DEGRADED", "Pool backup state is DEGRADED: One or more devices are faulted"]);
	assert.equal(plugins.truenas.uptime(300), "5 min");
	assert.equal(plugins.truenas.uptime(7300), "2 h");
});

test("TrueNAS: missing and wrong API key", async () => {
	await assert.rejects(run("truenas", "/nas", {}), /API key missing/);
	await assert.rejects(run("truenas", "/nas", { apiKey: "wrong" }), /Access denied/);
});

test("Glances: API v4 with CPU, RAM, load and file systems", async () => {
	glancesV3Only = false;
	seen.length = 0;
	const r = await run("glances", "/gl");
	assert.equal(metric(r, "CPU").value, "23 %");
	assert.equal(metric(r, "RAM").value, "75 %");
	assert.equal(metric(r, "Load").value, 0.52);
	assert.equal(metric(r, "Load").warn, false);
	assert.equal(metric(r, "Disk max").value, "93 %");
	assert.equal(metric(r, "Disk max").warn, true);
	// the bind-mounted /etc/hosts is skipped
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["/mnt/data", "warn"], ["/", "ok"]]);
	assert.equal(r.items[1].sub, "41 % · /dev/sda1 · ext4");
	assert.deepEqual(r.warnings, ["/mnt/data is 93 % full", "nvme0 at 82 °C"]);
	assert.equal(r.summary, "nvme0 82 °C");
	assert.ok(seen.every((x) => x.includes("/api/4/")));
});

test("Glances: falls back to API v3", async () => {
	glancesV3Only = true;
	seen.length = 0;
	const r = await run("glances", "/gl");
	glancesV3Only = false;
	assert.equal(metric(r, "CPU").value, "23 %");
	assert.ok(seen.includes("GET /gl/api/3/mem"));
});

test("Glances: basic auth, right and wrong password", async () => {
	const r = await run("glances", "/glpw", { password: "pw" });
	assert.equal(metric(r, "RAM").value, "75 %");
	await assert.rejects(run("glances", "/glpw", { username: "glances", password: "nope" }), /Access denied/);
	await assert.rejects(run("glances", "/glpw"), /Access denied/);
});

test("Portainer: environments and containers, live and from the snapshot", async () => {
	seen.length = 0;
	const r = await run("portainer", "/port", { apiKey: TOKEN });
	assert.equal(metric(r, "Environments").value, "2/3");
	assert.equal(metric(r, "Environments").warn, true);
	assert.equal(metric(r, "Containers running").value, "6/8"); // local live 2/3 + nas snapshot 4/5
	assert.equal(metric(r, "stopped").value, 2);
	assert.equal(metric(r, "unhealthy").value, 1);
	assert.equal(metric(r, "unhealthy").warn, true);
	assert.deepEqual(r.items, [
		{ title: "pi", sub: "offline", status: "bad" },
		{ title: "local", sub: "2/3 · 1 unhealthy", status: "warn" },
		{ title: "nas", sub: "4/5", status: "ok" }
	]);
	assert.deepEqual(r.warnings, ["Environment pi is down"]);
	assert.ok(!seen.some((x) => x.startsWith("GET /port/api/endpoints/3/")), "a down environment is not asked");
});

test("Portainer: missing and wrong access token", async () => {
	await assert.rejects(run("portainer", "/port", {}), /Access token missing/);
	await assert.rejects(run("portainer", "/port", { apiKey: "wrong" }), /Access denied/);
});

test("Syncthing: folders, devices, sync and errors", async () => {
	const r = await run("syncthing", "/st", { apiKey: TOKEN });
	assert.equal(metric(r, "Folders").value, 3);
	assert.equal(metric(r, "Devices connected").value, "1/2");
	assert.equal(metric(r, "in sync").value, "99.9 %");
	assert.equal(metric(r, "in sync").warn, false); // only after a while below 100 %
	assert.equal(metric(r, "Errors").value, 2); // errors and pullErrors are the same count
	assert.equal(metric(r, "Errors").warn, true);
	assert.deepEqual(r.items, [
		{ title: "Photos", sub: "syncing 75 % · 2 errors · 2 devices", status: "bad" },
		{ title: "Documents", sub: "idle · 1 device", status: "ok" },
		{ title: "ijkl-9012", sub: "paused · 0 devices", status: "warn" }
	]);
	assert.deepEqual(r.warnings, ["Folder Photos: 2 file(s) failed to sync"]);
});

test("Syncthing: missing and wrong API key", async () => {
	await assert.rejects(run("syncthing", "/st", {}), /API key missing/);
	await assert.rejects(run("syncthing", "/st", { apiKey: "wrong" }), /Access denied/);
});

test("Scrutiny: disks, failures and temperature", async () => {
	const r = await run("scrutiny", "/scr");
	assert.equal(metric(r, "Disks").value, 2); // the archived disk is left out
	assert.equal(metric(r, "failed").value, 1);
	assert.equal(metric(r, "failed").warn, true);
	assert.equal(metric(r, "Max temp").value, "57 °C");
	assert.equal(metric(r, "Max temp").warn, true);
	assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["/dev/sdb", "bad"], ["/dev/sda", "ok"]]);
	assert.equal(r.items[0].sub, "WDC WD40EFRX · 57 °C · 43'000 h · failed (S.M.A.R.T. + Scrutiny)");
	assert.deepEqual(r.warnings, ["/dev/sdb (WDC WD40EFRX) failed S.M.A.R.T. + Scrutiny checks"]);
	await assert.rejects(run("scrutiny", "/scrbroken"), /Unexpected answer from Scrutiny/);
});

test("unreachable server gives a readable error", async () => {
	await assert.rejects(plugins.scrutiny.fetch({ url: "http://127.0.0.1:1", secrets: {}, service: {}, request, json }), /Connection refused/);
});
