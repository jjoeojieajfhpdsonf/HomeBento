"use strict";
// Plugins for home services (Home Assistant, Immich, Nextcloud, Frigate, Paperless-ngx, Gitea,
// Speedtest Tracker, Grafana, Vaultwarden), each against a small fake server that answers like
// the real API.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, json } = require("../lib/util");

const TOKEN = "good-token";
const NOW = Math.floor(Date.now() / 1000);

// Starts a fake server; handler(req, url, send) with send(value, status, headers).
async function serve(handler) {
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		const send = (v, status = 200, headers = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(typeof v === "string" && headers["Content-Type"] ? v : JSON.stringify(v));
		};
		const out = handler(req, url, send);
		if (out === undefined && !res.headersSent) send({ message: "Not Found" }, 404);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.close(r), server.closeAllConnections())) };
}

async function run(kind, handler, secrets) {
	const plugin = require(`../lib/plugins/${kind}`);
	const srv = await serve(handler);
	try {
		return await plugin.fetch({ url: srv.url, secrets, service: { id: "s1", kind }, request, json });
	} finally {
		await srv.close();
	}
}

const values = (r) => r.metrics.map((m) => m.value);

// ---------- Home Assistant ----------

const haStates = [
	{ entity_id: "sensor.living_temp", state: "21.5", attributes: { friendly_name: "Living room", unit_of_measurement: "°C" } },
	{ entity_id: "sensor.power", state: "432", attributes: { friendly_name: "House power", unit_of_measurement: "W" } },
	{ entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } },
	{ entity_id: "light.hall", state: "off", attributes: { friendly_name: "Hall" } },
	{ entity_id: "light.desk", state: "on", attributes: { friendly_name: "Desk" } },
	{ entity_id: "switch.coffee", state: "on", attributes: { friendly_name: "Coffee machine" } },
	{ entity_id: "sensor.garage_door", state: "unavailable", attributes: { friendly_name: "Garage door" } }
];
function homeAssistant(req, url, send) {
	if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ message: "Unauthorized" }, 401);
	if (url.pathname === "/api/") return send({ message: "API running." });
	if (url.pathname === "/api/config") return send({ location_name: "Home", version: "2024.10.1", unit_system: {} });
	if (url.pathname === "/api/states") return send(haStates);
}

test("Home Assistant with chosen entities", async () => {
	const r = await run("homeassistant", homeAssistant, { token: TOKEN, entities: "sensor.living_temp, sensor.power, sensor.garage_door, sensor.gone" });
	assert.deepEqual(values(r), [7, 2, "21.5 °C", "432 W"]);
	assert.equal(r.metrics[2].label, "Living room");
	assert.deepEqual(
		r.items.map((i) => [i.title, i.sub, i.status]),
		[
			["Living room", "21.5 °C", "ok"],
			["House power", "432 W", "ok"],
			["Garage door", "unavailable", "bad"],
			["sensor.gone", "not found", "bad"]
		]
	);
	assert.deepEqual(r.warnings, ["Garage door is unavailable", "sensor.gone not found"]);
	assert.equal(r.summary, "Home · 2024.10.1");
});

test("Home Assistant without a list shows lights and switches that are on", async () => {
	const r = await run("homeassistant", homeAssistant, { token: TOKEN });
	assert.equal(r.metrics.length, 2);
	assert.deepEqual(
		r.items.map((i) => i.title),
		["Coffee machine", "Desk", "Kitchen"]
	);
	assert.deepEqual(r.warnings, []);
});

test("Home Assistant: missing and wrong token", async () => {
	await assert.rejects(run("homeassistant", homeAssistant, {}), /Token missing/);
	await assert.rejects(run("homeassistant", homeAssistant, { token: "wrong" }), /Access denied/);
});

// ---------- Immich ----------

function immich(newApi) {
	const prefix = newApi ? "/api/server" : "/api/server-info";
	return (req, url, send) => {
		if (!url.pathname.startsWith(prefix + "/")) return;
		if (req.headers["x-api-key"] !== TOKEN) return send({ message: "Invalid API key", statusCode: 401 }, 401);
		if (url.pathname === `${prefix}/version`) return send({ major: 1, minor: newApi ? 118 : 105, patch: 2 });
		if (url.pathname === `${prefix}/statistics`)
			return send({
				photos: 24512,
				videos: 830,
				usage: 1_234_000_000_000,
				usagePhotos: 900_000_000_000,
				usageVideos: 334_000_000_000,
				usageByUser: [
					{ userId: "u1", userName: "Joël", photos: 20000, videos: 700, usage: 1_000_000_000_000, quotaSizeInBytes: null },
					{ userId: "u2", userName: "Anna", photos: 4512, videos: 130, usage: 234_000_000_000, quotaSizeInBytes: null }
				]
			});
	};
}

test("Immich statistics (current and older API)", async () => {
	const r = await run("immich", immich(true), { apiKey: TOKEN });
	assert.deepEqual(values(r), [24512, 830, "1.2 TB", 2]);
	assert.equal(r.summary, "v1.118.2");
	assert.equal(r.items[1].title, "Anna");
	const old = await run("immich", immich(false), { apiKey: TOKEN });
	assert.deepEqual(values(old), [24512, 830, "1.2 TB", 2]);
	assert.equal(old.summary, "v1.105.2");
});

test("Immich: missing and wrong API key", async () => {
	await assert.rejects(run("immich", immich(true), {}), /API key missing/);
	await assert.rejects(run("immich", immich(true), { apiKey: "wrong" }), /Access denied/);
});

// ---------- Nextcloud ----------

function nextcloud(req, url, send) {
	if (url.pathname !== "/ocs/v2.php/apps/serverinfo/api/v1/info") return;
	if (req.headers["ocs-apirequest"] !== "true") return send({ message: "CSRF check failed" }, 412);
	const basic = `Basic ${Buffer.from("admin:app-pass").toString("base64")}`;
	if (req.headers["nc-token"] !== TOKEN && req.headers.authorization !== basic) return send({ ocs: { meta: { status: "failure", statuscode: 997, message: "Current user is not logged in" }, data: [] } }, 401);
	return send({
		ocs: {
			meta: { status: "ok", statuscode: 200, message: "OK" },
			data: {
				nextcloud: {
					system: { version: "29.0.4.1", freespace: 812_300_000_000, cpuload: [0.2, 0.3, 0.3], update: { lastupdatedat: NOW, available: true, available_version: "29.0.5" }, apps: { num_installed: 54, num_updates_available: 3, app_updates: {} } },
					storage: { num_users: 4, num_files: 183422, num_storages: 6 },
					shares: { num_shares: 12 }
				},
				server: { webserver: "Apache", php: { version: "8.2.0" } },
				activeUsers: { last5minutes: 2, last1hour: 3, last24hours: 4 }
			}
		}
	});
}

test("Nextcloud serverinfo with token and with basic auth", async () => {
	const r = await run("nextcloud", nextcloud, { token: TOKEN });
	assert.deepEqual(values(r), [2, 183422, "812 GB", "29.0.4"]);
	assert.equal(r.metrics[3].warn, true);
	assert.deepEqual(r.warnings, ["Nextcloud update available: 29.0.5"]);
	assert.equal(r.summary, "4 users · 3 app update(s)");
	const b = await run("nextcloud", nextcloud, { username: "admin", password: "app-pass" });
	assert.equal(b.metrics[1].value, 183422);
});

test("Nextcloud: missing and wrong login", async () => {
	await assert.rejects(run("nextcloud", nextcloud, {}), /Login missing/);
	await assert.rejects(run("nextcloud", nextcloud, { token: "wrong" }), /Access denied/);
});

// ---------- Frigate ----------

function frigate(req, url, send) {
	if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ success: false, message: "Unauthorized" }, 401);
	if (url.pathname === "/api/stats")
		return send({
			cameras: {
				front: { camera_fps: 5.1, process_fps: 5.0, skipped_fps: 0, detection_fps: 1.5, pid: 101, capture_pid: 102 },
				garden: { camera_fps: 5.0, process_fps: 5.0, skipped_fps: 0, detection_fps: 0.7, pid: 103, capture_pid: 104 },
				garage: { camera_fps: 0.0, process_fps: 0.0, skipped_fps: 0, detection_fps: 0, pid: 105, capture_pid: 106 }
			},
			detectors: { coral: { inference_speed: 8.42, detection_start: 0, pid: 99 } },
			detection_fps: 2.2,
			service: { uptime: 3600, version: "0.14.1-f4f3cfa", latest_version: "0.14.1", storage: {} }
		});
	if (url.pathname === "/api/events") {
		const all = [
			{ id: "a", label: "person", camera: "front", start_time: NOW - 60, end_time: NOW - 30, top_score: 0.9 },
			{ id: "b", label: "car", camera: "garden", start_time: NOW - 120, end_time: NOW - 90, top_score: 0.8 },
			{ id: "c", label: "cat", camera: "garden", start_time: NOW - 3 * 86400, end_time: NOW - 3 * 86400 + 20, top_score: 0.7 }
		];
		const after = Number(url.searchParams.get("after") || 0);
		return send(all.filter((e) => e.start_time > after).slice(0, Number(url.searchParams.get("limit") || 100)));
	}
}

test("Frigate stats and latest events", async () => {
	const r = await run("frigate", frigate, { token: TOKEN });
	const today = new Date().toDateString() === new Date((NOW - 120) * 1000).toDateString() ? 2 : r.metrics[3].value;
	assert.deepEqual(values(r), [3, 2.2, "8.4 ms", today]);
	assert.equal(r.metrics[0].warn, true);
	assert.deepEqual(
		r.items.map((i) => i.title),
		["person · front", "car · garden", "cat · garden"]
	);
	assert.match(r.items[0].sub, /^\d\d:\d\d$/);
	assert.match(r.items[2].sub, /^\d\d\.\d\d\. \d\d:\d\d$/);
	assert.deepEqual(r.warnings, ["Camera garage delivers no frames"]);
	assert.equal(r.summary, "v0.14.1");
});

test("Frigate: older stats format and wrong token", async () => {
	const plugin = require("../lib/plugins/frigate");
	assert.deepEqual(
		plugin.camerasOf({ front: { camera_fps: 5, detection_fps: 1 }, detectors: {}, service: {} }).map((c) => c.name),
		["front"]
	);
	await assert.rejects(run("frigate", frigate, { token: "wrong" }), /Access denied/);
});

// ---------- Paperless-ngx ----------

function paperless(req, url, send) {
	if (req.headers.authorization !== `Token ${TOKEN}`) return send({ detail: "Invalid token." }, 401);
	if (url.pathname === "/api/statistics/") return send({ documents_total: 1532, documents_inbox: 7, inbox_tag: 1, inbox_tags: [1], document_file_type_counts: [], character_count: 8123456, tag_count: 20, correspondent_count: 40, document_type_count: 9, storage_path_count: 1 });
	if (url.pathname === "/api/tasks/") {
		const iso = (s) => new Date(Date.now() - s * 1000).toISOString();
		return send([
			{ id: 3, task_id: "t3", task_file_name: "invoice.pdf", date_created: iso(30), date_done: iso(20), type: "file", status: "FAILURE", result: "invoice.pdf: Not consuming invoice.pdf: It is a duplicate.", acknowledged: false, related_document: null },
			{ id: 2, task_id: "t2", task_file_name: "letter.pdf", date_created: iso(60), date_done: iso(50), type: "file", status: "SUCCESS", result: "Success. New document id 1532 created", acknowledged: false, related_document: "1532" },
			{ id: 1, task_id: "t1", task_file_name: "old.pdf", date_created: iso(5 * 86400), date_done: iso(5 * 86400), type: "file", status: "FAILURE", result: "error", acknowledged: false, related_document: null }
		]);
	}
}

test("Paperless-ngx statistics and failed tasks", async () => {
	const r = await run("paperless", paperless, { token: TOKEN });
	assert.deepEqual(values(r), [1532, 7, 1]);
	assert.equal(r.metrics[2].warn, true);
	assert.deepEqual(r.warnings, ["Consuming invoice.pdf failed"]);
	assert.equal(r.items[0].status, "bad");
	assert.equal(r.summary, "8,123,456 characters");
	await assert.rejects(run("paperless", paperless, {}), /Token missing/);
	await assert.rejects(run("paperless", paperless, { token: "wrong" }), /Access denied/);
});

// ---------- Gitea / Forgejo ----------

function gitea(req, url, send) {
	if (url.pathname === "/api/v1/version") return send({ version: "1.22.3" });
	if (req.headers.authorization !== `token ${TOKEN}`) return send({ message: "token is required" }, 401);
	if (url.pathname === "/api/v1/notifications") {
		assert.equal(url.searchParams.get("status-types"), "unread");
		return send([{ id: 1, unread: true, subject: { title: "Fix build", type: "Pull" } }, { id: 2, unread: true, subject: { title: "Bug", type: "Issue" } }], 200, { "X-Total-Count": "2" });
	}
	if (url.pathname === "/api/v1/repos/search") return send({ ok: true, data: [{ id: 1, full_name: "joel/homebento" }] }, 200, { "X-Total-Count": "17" });
	if (url.pathname === "/api/v1/repos/issues/search") {
		assert.equal(url.searchParams.get("type"), "pulls");
		assert.equal(url.searchParams.get("state"), "open");
		return send([{ number: 12, title: "Add plugins", repository: { full_name: "joel/homebento" } }], 200, { "X-Total-Count": "3" });
	}
}

test("Gitea repositories, notifications and pull requests", async () => {
	const r = await run("gitea", gitea, { token: TOKEN });
	assert.deepEqual(values(r), [17, 2, 3]);
	assert.equal(r.metrics[1].warn, true);
	assert.deepEqual(r.items, [{ title: "Add plugins", sub: "joel/homebento #12", status: "ok" }]);
	assert.equal(r.summary, "v1.22.3");
	await assert.rejects(run("gitea", gitea, { token: "wrong" }), /Access denied/);
	assert.ok(require("../lib/plugins/gitea").match.test("forgejo codeberg.org/forgejo/forgejo:9"));
});

// ---------- Speedtest Tracker ----------

function speedtest({ v1 = true, failed = false, empty = false } = {}) {
	const created = new Date(Date.now() - 25 * 60000);
	const p = (n) => String(n).padStart(2, "0");
	const local = `${created.getFullYear()}-${p(created.getMonth() + 1)}-${p(created.getDate())} ${p(created.getHours())}:${p(created.getMinutes())}:${p(created.getSeconds())}`;
	return (req, url, send) => {
		if (url.pathname === "/api/v1/results/latest") {
			if (!v1) return;
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ message: "Unauthenticated." }, 401);
			if (empty) return send({ message: "No result found." }, 404);
			if (failed) return send({ data: { id: 9, service: "ookla", ping: null, download: null, upload: null, healthy: null, status: "failed", scheduled: true, created_at: local, updated_at: local }, message: "ok" });
			return send({
				data: { id: 9, service: "ookla", ping: 12.345, download: 117_000_000, upload: 5_250_000, download_bits: 936_000_000, upload_bits: 42_000_000, download_bits_human: "936 Mbps", upload_bits_human: "42 Mbps", healthy: true, status: "completed", scheduled: true, created_at: local, updated_at: local },
				message: "ok"
			});
		}
		if (url.pathname === "/api/speedtest/latest") return send({ message: "ok", data: { id: 9, ping: 14.2, download: 512.34, upload: 40.12, server_id: 1, server_host: "x", server_name: "Zürich", url: "", scheduled: true, failed, created_at: created.toISOString(), updated_at: created.toISOString() } });
	};
}

test("Speedtest Tracker v1 API", async () => {
	const r = await run("speedtest", speedtest(), { token: TOKEN });
	assert.deepEqual(values(r), [936, 42, "12 ms", "25 min"]);
	assert.deepEqual(r.warnings, []);
	const f = await run("speedtest", speedtest({ failed: true }), { token: TOKEN });
	assert.deepEqual(values(f), ["–", "–", "–", "25 min"]);
	assert.deepEqual(f.warnings, ["The last speed test failed (25 min ago)"]);
	const e = await run("speedtest", speedtest({ empty: true }), { token: TOKEN });
	assert.equal(e.summary, "No results yet");
	await assert.rejects(run("speedtest", speedtest(), { token: "wrong" }), /Access denied/);
});

test("Speedtest Tracker older API without token", async () => {
	const r = await run("speedtest", speedtest({ v1: false }), {});
	assert.deepEqual(values(r), [512, 40.1, "14 ms", "25 min"]);
	const t = await run("speedtest", speedtest({ v1: false }), { token: TOKEN });
	assert.deepEqual(values(t), [512, 40.1, "14 ms", "25 min"]);
});

// ---------- Grafana ----------

function grafana({ db = "ok" } = {}) {
	return (req, url, send) => {
		if (url.pathname === "/api/health") return send({ commit: "abc", database: db, version: "11.3.0" }, db === "ok" ? 200 : 503);
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ message: "Unauthorized" }, 401);
		if (url.pathname === "/api/search") return send([{ uid: "a", title: "Home", type: "dash-db" }, { uid: "b", title: "Solar", type: "dash-db" }, { uid: "c", title: "Docker", type: "dash-db" }]);
		if (url.pathname === "/api/alertmanager/grafana/api/v2/alerts")
			return send([
				{ labels: { alertname: "Disk full", instance: "nas" }, annotations: { summary: "Disk at 95%" }, status: { state: "active", silencedBy: [], inhibitedBy: [] }, startsAt: new Date().toISOString() },
				{ labels: { alertname: "Muted" }, annotations: {}, status: { state: "suppressed", silencedBy: ["s1"], inhibitedBy: [] } }
			]);
	};
}

test("Grafana with and without token", async () => {
	const r = await run("grafana", grafana(), { token: TOKEN });
	assert.deepEqual(values(r), [3, 1, "11.3.0", "ok"]);
	assert.deepEqual(r.warnings, ["Disk full is firing: Disk at 95%"]);
	assert.equal(r.items[0].title, "Disk full");
	const plain = await run("grafana", grafana(), {});
	assert.deepEqual(values(plain), ["11.3.0", "ok"]);
	const broken = await run("grafana", grafana({ db: "failing" }), {});
	assert.deepEqual(broken.warnings, ["Grafana database: failing"]);
	assert.equal(broken.metrics[1].warn, true);
	await assert.rejects(run("grafana", grafana(), { token: "wrong" }), /Access denied/);
});

// ---------- Vaultwarden ----------

test("Vaultwarden alive and version", async () => {
	const r = await run(
		"vaultwarden",
		(req, url, send) => {
			if (url.pathname === "/alive") return send(new Date().toISOString());
			if (url.pathname === "/api/version") return send("1.32.4");
		},
		{}
	);
	assert.equal(r.metrics[0].value, "up");
	assert.match(r.metrics[1].value, /^\d+ ms$/);
	assert.equal(r.metrics[2].value, "1.32.4");
	await assert.rejects(run("vaultwarden", (req, url, send) => send("down", 503), {}), /Not alive \(HTTP 503\)/);
});
