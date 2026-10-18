"use strict";
// The media and download plugins against small fake servers that answer like the real APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, json } = require("../lib/util");

const KEY = "secret-key";
const servers = [];

// Starts a fake server; the handler gets (req, url, body, send) and returns nothing.
async function serve(handler) {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const send = (v, status = 200, headers = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers });
				res.end(typeof v === "string" ? v : JSON.stringify(v));
			};
			const url = new URL(req.url, "http://x");
			try {
				if (handler(req, url, body, send) === undefined && !res.headersSent) send({ error: "not found" }, 404);
			} catch (err) {
				send({ error: err.message }, 500);
			}
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	return `http://127.0.0.1:${server.address().port}`;
}
test.after(() => servers.forEach((s) => s.close()));

const run = (name, url, secrets) => require(`../lib/plugins/${name}`).fetch({ url, secrets, service: {}, request, json });
const en = (label) => (typeof label === "string" ? label : label.en);
const metric = (r, label) => {
	const m = r.metrics.find((x) => en(x.label) === label);
	assert.ok(m, `metric ${label} in ${r.metrics.map((x) => en(x.label)).join(", ")}`);
	return m;
};
const valid = (r) => {
	assert.ok(r.metrics.length <= 4, "at most 4 metrics");
	for (const m of r.metrics) assert.ok(typeof m.label === "string" || (m.label.de && m.label.en), "label text or { de, en }");
};

test("plugins: every new plugin has kind, label, match, fields and a fetch", () => {
	for (const name of ["plex", "tautulli", "emby", "overseerr", "lidarr", "readarr", "bazarr", "sabnzbd", "transmission", "deluge", "nzbget"]) {
		const p = require(`../lib/plugins/${name}`);
		assert.equal(p.kind, name);
		assert.ok(p.label && p.match instanceof RegExp && Array.isArray(p.fields) && typeof p.fetch === "function", name);
		for (const f of p.fields) if (/key|password|token/i.test(f.key)) assert.equal(f.secret, true, `${name}.${f.key} is secret`);
	}
	const plex = require("../lib/plugins/plex").match;
	assert.ok(plex.test("linuxserver/plex:latest") && plex.test("plexinc/pms-docker"));
	assert.ok(!plex.test("plex-tautulli tautulli/tautulli") && !plex.test("complex"));
	const seerr = require("../lib/plugins/overseerr").match;
	assert.ok(seerr.test("sctx/overseerr") && seerr.test("fallenbagel/jellyseerr"));
});

test("Plex: streams, library sizes by type and the sessions", async () => {
	const url = await serve((req, u, body, send) => {
		if (req.headers["x-plex-token"] !== KEY) return send("<html>Unauthorized</html>", 401, { "Content-Type": "text/html" });
		assert.match(req.headers.accept, /application\/json/);
		if (u.pathname === "/status/sessions") return send({ MediaContainer: { size: 2, Metadata: [
			{ type: "episode", grandparentTitle: "Severance", title: "Woe's Hollow", parentIndex: 2, index: 4, viewOffset: 600000, duration: 2400000, User: { title: "joel" }, Player: { title: "Apple TV", state: "playing" } },
			{ type: "movie", title: "Dune", year: 2024, viewOffset: 0, duration: 9960000, User: { title: "anna" }, Player: { product: "Plex Web", state: "paused" } }
		] } });
		if (u.pathname === "/library/sections") return send({ MediaContainer: { size: 4, Directory: [{ key: "1", type: "movie", title: "Movies" }, { key: "2", type: "show", title: "TV" }, { key: "3", type: "movie", title: "Kids" }, { key: "4", type: "photo", title: "Photos" }] } });
		const m = /^\/library\/sections\/(\d)\/all$/.exec(u.pathname);
		if (m) {
			assert.equal(u.searchParams.get("X-Plex-Container-Size"), "0");
			return send({ MediaContainer: { size: 0, totalSize: { 1: 120, 2: 30, 3: 15 }[m[1]] } });
		}
	});
	const r = await run("plex", url, { token: KEY });
	valid(r);
	assert.equal(metric(r, "Streams").value, 2);
	assert.equal(metric(r, "Movies").value, 135);
	assert.equal(metric(r, "Shows").value, 30);
	assert.equal(r.metrics.length, 3, "no music library, no music metric");
	assert.equal(r.items[0].title, "joel · Severance S02E04");
	assert.match(r.items[0].sub, /Apple TV · 25 %/);
	assert.equal(r.items[1].title, "anna · Dune (2024)");
	assert.equal(r.items[1].status, "warn");
	await assert.rejects(run("plex", url, { token: "nope" }), /Access denied/);
	await assert.rejects(run("plex", url, {}), /Token missing/);
});

test("Tautulli: streams, bandwidth, libraries and a wrong key", async () => {
	const url = await serve((req, u, body, send) => {
		if (u.pathname !== "/api/v2") return;
		if (u.searchParams.get("apikey") !== KEY) return send({ response: { result: "error", message: "Invalid apikey", data: {} } }, 401);
		const cmd = u.searchParams.get("cmd");
		if (cmd === "get_activity") return send({ response: { result: "success", message: null, data: { stream_count: "1", total_bandwidth: 12400, lan_bandwidth: 0, wan_bandwidth: 12400, sessions: [{ friendly_name: "Joël", full_title: "Severance - Woe's Hollow", state: "playing", player: "Apple TV", progress_percent: "45", transcode_decision: "transcode" }] } } });
		if (cmd === "get_libraries") return send({ response: { result: "success", message: null, data: [{ section_id: "1", section_name: "Movies", section_type: "movie", count: "120" }, { section_id: "2", section_name: "TV", section_type: "show", count: "30" }] } });
		return send({ response: { result: "error", message: "Unknown command", data: {} } }, 400);
	});
	const r = await run("tautulli", url, { apiKey: KEY });
	valid(r);
	assert.equal(metric(r, "Streams").value, 1);
	assert.equal(metric(r, "Bandwidth").value, "12.4 Mbit/s");
	assert.equal(metric(r, "Libraries").value, 2);
	assert.equal(r.items[0].title, "Joël · Severance - Woe's Hollow");
	assert.equal(r.items[0].sub, "Apple TV · 45 % · transcode");
	await assert.rejects(run("tautulli", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("tautulli", url, {}), /API key missing/);
});

test("Emby: streams and library counts like Jellyfin", async () => {
	const url = await serve((req, u, body, send) => {
		if (req.headers["x-emby-token"] !== KEY) return send("Access token is invalid or expired.", 401, { "Content-Type": "text/plain" });
		if (u.pathname === "/emby/Sessions") return send([
			{ UserName: "joel", DeviceName: "Living room", PlayState: { PositionTicks: 50, IsPaused: false }, NowPlayingItem: { Type: "Episode", SeriesName: "Shōgun", Name: "Anjin", ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 100 } },
			{ UserName: "idle", DeviceName: "Phone" }
		]);
		if (u.pathname === "/emby/Items/Counts") return send({ MovieCount: 120, SeriesCount: 30, EpisodeCount: 900, SongCount: 0 });
	});
	const r = await run("emby", url, { apiKey: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => m.value), [1, 120, 30, 900]);
	assert.equal(r.items.length, 1);
	assert.equal(r.items[0].title, "joel · Shōgun S01E01");
	assert.equal(r.items[0].sub, "Living room · 50 %");
	await assert.rejects(run("emby", url, { apiKey: "wrong" }), /Access denied/);
});

test("Overseerr / Jellyseerr: requests by state and an update hint", async () => {
	const url = await serve((req, u, body, send) => {
		if (u.pathname === "/api/v1/status") return send({ version: "2.1.0", commitTag: "v2.1.0", updateAvailable: true, commitsBehind: 0, restartRequired: false });
		if (req.headers["x-api-key"] !== KEY) return send({ message: "You do not have permission to access this endpoint" }, 403);
		if (u.pathname === "/api/v1/request/count") return send({ total: 40, movie: 25, tv: 15, pending: 3, approved: 2, declined: 1, processing: 4, available: 30 });
	});
	const r = await run("overseerr", url, { apiKey: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Pending", 3], ["Approved", 2], ["Processing", 4], ["Available", 30]]);
	assert.deepEqual(r.warnings, ["Update available"]);
	assert.equal(r.summary, "v2.1.0");
	await assert.rejects(run("overseerr", url, { apiKey: "wrong" }), /Access denied/);
});

// Lidarr and Readarr share one fake *arr v1 server
const arr = (library, rows) => (req, u, body, send) => {
	if (req.headers["x-api-key"] !== KEY) return send({ error: "Unauthorized" }, 401);
	if (u.pathname === `/api/v1/${library}`) return send(rows);
	if (u.pathname === "/api/v1/queue/status") return send({ totalCount: 2, count: 2, unknownCount: 0, errors: false, warnings: false, unknownErrors: false, unknownWarnings: false });
	if (u.pathname === "/api/v1/wanted/missing") {
		assert.equal(u.searchParams.get("pageSize"), "1");
		return send({ page: 1, pageSize: 1, sortKey: "releaseDate", totalRecords: 17, records: [{ id: 1, title: "x" }] });
	}
	if (u.pathname === "/api/v1/health") return send([{ source: "IndexerStatusCheck", type: "warning", message: "Indexers unavailable due to failures: NZBgeek", wikiUrl: "" }, { source: "UpdateCheck", type: "notice", message: "fine" }]);
};

test("Lidarr: library, queue, missing and health warnings", async () => {
	const url = await serve(arr("artist", [{ id: 1, artistName: "Daft Punk" }, { id: 2, artistName: "Air" }, { id: 3, artistName: "Moderat" }]));
	const r = await run("lidarr", url, { apiKey: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => m.value), [3, 2, 17, 1]);
	assert.equal(en(r.metrics[0].label), "Artists");
	assert.equal(r.metrics[3].warn, true);
	assert.deepEqual(r.warnings, ["Indexers unavailable due to failures: NZBgeek"]);
	await assert.rejects(run("lidarr", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("lidarr", url, {}), /API key missing/);
});

test("Readarr: same API with authors", async () => {
	const url = await serve(arr("author", [{ id: 1, authorName: "Terry Pratchett" }]));
	const r = await run("readarr", url, { apiKey: KEY });
	assert.equal(en(r.metrics[0].label), "Authors");
	assert.deepEqual(r.metrics.map((m) => m.value), [1, 2, 17, 1]);
});

test("Bazarr: missing subtitles, throttled providers, health", async () => {
	const url = await serve((req, u, body, send) => {
		if (req.headers["x-api-key"] !== KEY) return send({ message: "Unauthorized" }, 401);
		if (u.pathname === "/api/badges") return send({ episodes: 42, movies: 7, providers: 1, status: 0, sonarr_signalr: "LIVE", radarr_signalr: "LIVE", announcements: 0 });
		if (u.pathname === "/api/system/status") return send({ data: { bazarr_version: "1.5.1", sonarr_version: "4.0.9", radarr_version: "5.11.0" } });
	});
	const r = await run("bazarr", url, { apiKey: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => m.value), [42, 7, 1, 0]);
	assert.equal(r.metrics[2].warn, true);
	assert.equal(r.metrics[3].warn, false);
	assert.deepEqual(r.warnings, ["1 subtitle provider(s) throttled"]);
	assert.equal(r.summary, "v1.5.1");
	await assert.rejects(run("bazarr", url, { apiKey: "wrong" }), /Access denied/);
});

test("SABnzbd: speed, queue, size left, paused and a wrong key", async () => {
	let paused = false;
	const url = await serve((req, u, body, send) => {
		if (u.pathname !== "/api") return;
		assert.equal(u.searchParams.get("output"), "json");
		if (u.searchParams.get("apikey") !== KEY) return send({ status: false, error: "API Key Incorrect" });
		if (u.searchParams.get("mode") === "queue") return send({ queue: { status: paused ? "Paused" : "Downloading", paused, speed: "11.8 M", kbpersec: "12109.38", sizeleft: "3.4 GB", mbleft: "3481.2", noofslots: 2, noofslots_total: 2, timeleft: "0:04:47", slots: [{ nzo_id: "SABnzbd_nzo_1", filename: "Arcane.S02E01", percentage: "64", timeleft: "0:01:10", status: "Downloading", mb: "2048", mbleft: "737" }, { nzo_id: "SABnzbd_nzo_2", filename: "Dune.2024", percentage: "0", timeleft: "0:03:37", status: "Queued", mb: "2744", mbleft: "2744" }] } });
		if (u.searchParams.get("mode") === "history") return send({ history: { noofslots: 2, slots: [{ name: "Old.Show.S01E01", status: "Failed", fail_message: "Out of retention" }, { name: "Fine", status: "Completed" }] } });
	});
	const r = await run("sabnzbd", url, { apiKey: KEY });
	valid(r);
	assert.equal(metric(r, "↓ Download").value, "12.4 MB/s");
	assert.equal(metric(r, "Queue").value, 2);
	assert.equal(metric(r, "Left").value, "3.4 GB");
	assert.equal(metric(r, "State").warn, false);
	assert.deepEqual(r.items.map((i) => i.title), ["Arcane.S02E01", "Dune.2024"]);
	assert.equal(r.items[0].sub, "64 % · 0:01:10 · Downloading");
	assert.deepEqual(r.warnings, ["Old.Show.S01E01 failed: Out of retention"]);
	paused = true;
	assert.equal(metric(await run("sabnzbd", url, { apiKey: KEY }), "State").warn, true);
	await assert.rejects(run("sabnzbd", url, { apiKey: "wrong" }), /Access denied/);
});

test("Transmission: session id handshake, basic auth, stats and torrents", async () => {
	const SID = "sid-123";
	let handshakes = 0;
	const auth = `Basic ${Buffer.from("admin:pw").toString("base64")}`;
	const url = await serve((req, u, body, send) => {
		if (u.pathname !== "/transmission/rpc" || req.method !== "POST") return;
		if (req.headers.authorization !== auth) return send("<h1>401: Unauthorized</h1>", 401, { "Content-Type": "text/html" });
		if (req.headers["x-transmission-session-id"] !== SID) {
			handshakes++;
			return send("<h1>409: Conflict</h1>", 409, { "Content-Type": "text/html", "X-Transmission-Session-Id": SID });
		}
		const x = JSON.parse(body);
		if (x.method === "session-stats") return send({ result: "success", arguments: { activeTorrentCount: 2, downloadSpeed: 12_400_000, uploadSpeed: 340_000, pausedTorrentCount: 1, torrentCount: 5 } });
		if (x.method === "torrent-get") {
			assert.deepEqual(x.arguments.fields.slice(0, 4), ["name", "percentDone", "rateDownload", "status"]);
			return send({ result: "success", arguments: { torrents: [
				{ name: "Seeded", percentDone: 1, rateDownload: 0, status: 6, error: 0, errorString: "" },
				{ name: "Arcane", percentDone: 0.64, rateDownload: 8_000_000, status: 4, error: 0, errorString: "" },
				{ name: "Broken", percentDone: 0.1, rateDownload: 0, status: 0, error: 3, errorString: "No data found" }
			] } });
		}
		return send({ result: "method name not recognized" });
	});
	const r = await run("transmission", url, { username: "admin", password: "pw" });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => m.value), ["12.4 MB/s", "340 kB/s", 2, 5]);
	assert.deepEqual(r.items.map((i) => i.title), ["Arcane", "Broken"]);
	assert.equal(r.items[0].sub, "64 % · 8.0 MB/s · downloading");
	assert.equal(r.items[1].status, "bad");
	assert.deepEqual(r.warnings, ["Broken: No data found"]);
	assert.equal(handshakes, 1);
	await run("transmission", url, { username: "admin", password: "pw" });
	assert.equal(handshakes, 1, "the session id is kept");
	await assert.rejects(run("transmission", url, { username: "admin", password: "wrong" }), /Access denied/);
});

test("Deluge: logs in, keeps the cookie, logs in again when the session is gone", async () => {
	let sessions = new Set();
	let logins = 0;
	const url = await serve((req, u, body, send) => {
		if (u.pathname !== "/json" || req.method !== "POST") return;
		const x = JSON.parse(body);
		if (x.method === "auth.login") {
			if (x.params[0] !== "deluge") return send({ result: false, error: null, id: x.id });
			logins++;
			const sid = `s${logins}`;
			sessions.add(sid);
			return send({ result: true, error: null, id: x.id }, 200, { "Set-Cookie": [`_session_id=${sid}; Expires=Tue, 20 Oct 2026 10:00:00 GMT; Path=/json`] });
		}
		const sid = ((req.headers.cookie || "").match(/_session_id=(\w+)/) || [])[1];
		if (!sessions.has(sid)) return send({ result: null, error: { message: "Not authenticated", code: 1 }, id: x.id });
		if (x.method === "web.update_ui") {
			assert.deepEqual(x.params[0].slice(0, 4), ["name", "progress", "download_payload_rate", "upload_payload_rate"]);
			return send({ id: x.id, error: null, result: { connected: true, stats: { download_rate: 2_500_000, upload_rate: 120_000, num_connections: 40 }, filters: {}, torrents: {
				a1: { name: "Arcane", progress: 64.2, download_payload_rate: 2_500_000, upload_payload_rate: 0, state: "Downloading" },
				b2: { name: "Linux ISO", progress: 100, download_payload_rate: 0, upload_payload_rate: 120_000, state: "Seeding" },
				c3: { name: "Other ISO", progress: 100, download_payload_rate: 0, upload_payload_rate: 0, state: "Seeding" }
			} } });
		}
	});
	const r = await run("deluge", url, { password: "deluge" });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => m.value), ["2.5 MB/s", "120 kB/s", 1, 2]);
	assert.equal(r.items.length, 1);
	assert.equal(r.items[0].sub, "64 % · 2.5 MB/s · Downloading");
	await run("deluge", url, { password: "deluge" });
	assert.equal(logins, 1, "the cookie is kept");
	sessions = new Set(); // Deluge restarted
	await run("deluge", url, { password: "deluge" });
	assert.equal(logins, 2);
	await assert.rejects(run("deluge", url, { password: "wrong" }), /Login failed/);
	await assert.rejects(run("deluge", url, {}), /Password missing/);
});

test("NZBGet: status with basic auth, queue from listgroups", async () => {
	const auth = `Basic ${Buffer.from("nzbget:tegbzn6789").toString("base64")}`;
	const url = await serve((req, u, body, send) => {
		if (u.pathname !== "/jsonrpc") return;
		if (req.headers.authorization !== auth) return send("Unauthorized", 401, { "Content-Type": "text/plain", "WWW-Authenticate": 'Basic realm="NZBGet"' });
		const x = JSON.parse(body);
		if (x.method === "status") return send({ version: "1.1", id: x.id, result: { DownloadRate: 5_000_000, RemainingSizeMB: 2048, RemainingSizeLo: 2147483648, RemainingSizeHi: 0, DownloadPaused: true, ServerStandBy: true, ThreadCount: 8 } });
		if (x.method === "listgroups") return send({ version: "1.1", id: x.id, result: [{ NZBID: 1, NZBName: "Arcane.S02E01", FileSizeMB: 2048, RemainingSizeMB: 1024, Status: "PAUSED" }] });
		return send({ version: "1.1", id: x.id, error: { name: "JSONRPCError", code: 1, message: "Invalid procedure" } });
	});
	const r = await run("nzbget", url, { username: "nzbget", password: "tegbzn6789" });
	valid(r);
	assert.equal(metric(r, "↓ Download").value, "5.0 MB/s");
	assert.equal(metric(r, "Left").value, "2.1 GB");
	assert.equal(metric(r, "State").warn, true);
	assert.equal(r.items[0].title, "Arcane.S02E01");
	assert.equal(r.items[0].sub, "50 % · 1.1 GB · PAUSED");
	await assert.rejects(run("nzbget", url, { username: "nzbget", password: "wrong" }), /Access denied/);
});
