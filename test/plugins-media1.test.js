"use strict";
// Audiobookshelf, Navidrome, Komga, Jackett, autobrr, Tdarr, Unmanic, FileFlows and Tube Archivist
// against small fake servers that answer like the real APIs.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const crypto = require("node:crypto");
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

const NAMES = ["audiobookshelf", "navidrome", "komga", "jackett", "autobrr", "tdarr", "unmanic", "fileflows", "tubearchivist"];
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

test("media1 plugins: kind, label, match, fields and fetch", () => {
	for (const name of NAMES) {
		const p = require(`../lib/plugins/${name}`);
		assert.equal(p.kind, name);
		assert.ok(p.label && p.match instanceof RegExp && Array.isArray(p.fields) && typeof p.fetch === "function", name);
		for (const f of p.fields) if (/key|password|token/i.test(f.key)) assert.equal(f.secret, true, `${name}.${f.key} is secret`);
		assert.ok(require("../lib/plugins")[name], `${name} is loaded`);
	}
	const m = (name) => require(`../lib/plugins/${name}`).match;
	assert.ok(m("tdarr").test("tdarr ghcr.io/haveagitgat/tdarr:latest"));
	assert.ok(!m("tdarr").test("tdarr-node ghcr.io/haveagitgat/tdarr_node:latest"));
	assert.ok(m("autobrr").test("autobrr ghcr.io/autobrr/autobrr:latest"));
	assert.ok(!m("autobrr").test("omegabrr ghcr.io/autobrr/omegabrr:latest"));
	assert.ok(m("tubearchivist").test("tubearchivist bbilly1/tubearchivist"));
	assert.ok(!m("tubearchivist").test("archivist-es bbilly1/tubearchivist-es"));
	assert.ok(m("audiobookshelf").test("ghcr.io/advplyr/audiobookshelf"));
});

test("Audiobookshelf: books, podcasts, playtime, listened today", async () => {
	const url = await serve((req, u, body, send) => {
		if (req.headers.authorization !== `Bearer ${KEY}`) return send("Unauthorized", 401, { "Content-Type": "text/plain" });
		if (u.pathname === "/api/libraries") return send({ libraries: [{ id: "lib1", name: "Audiobooks", mediaType: "book" }, { id: "lib2", name: "Podcasts", mediaType: "podcast" }] });
		if (u.pathname === "/api/libraries/lib1/stats") return send({ totalItems: 120, totalAuthors: 40, totalDuration: 1800000, totalSize: 9e10, numAudioTracks: 2000 });
		if (u.pathname === "/api/libraries/lib2/stats") return send({ totalItems: 8, totalDuration: 360000 });
		if (u.pathname === "/api/me/listening-stats") return send({ totalTime: 720000, today: 5400, days: {}, items: {} });
	});
	const r = await run("audiobookshelf", url, { apiKey: KEY });
	valid(r);
	assert.equal(metric(r, "Books").value, 120);
	assert.equal(metric(r, "Podcasts").value, 8);
	assert.equal(metric(r, "Playtime").value, "600 h");
	assert.equal(metric(r, "Listened today").value, "1.5 h");
	assert.deepEqual(r.items.map((i) => [i.title, i.sub]), [["Audiobooks", "120 books · 500 h"], ["Podcasts", "8 podcasts · 100 h"]]);
	assert.equal(r.summary, "200 h listened in total");
	await assert.rejects(run("audiobookshelf", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("audiobookshelf", url, {}), /API key missing/);
});

test("Navidrome: now playing, albums, artists, tracks with token auth", async () => {
	const ok = (extra) => ({ "subsonic-response": { status: "ok", version: "1.16.1", type: "navidrome", serverVersion: "0.58.0", ...extra } });
	const url = await serve((req, u, body, send) => {
		const p = u.searchParams;
		assert.equal(p.get("f"), "json");
		assert.equal(p.get("p"), null, "the password is never sent");
		const expected = crypto.createHash("md5").update("pw" + p.get("s")).digest("hex");
		if (p.get("u") !== "joel" || p.get("t") !== expected) return send({ "subsonic-response": { status: "failed", version: "1.16.1", error: { code: 40, message: "Wrong username or password" } } });
		if (u.pathname === "/rest/getNowPlaying") return send(ok({ nowPlaying: { entry: [{ id: "1", title: "Windowlicker", artist: "Aphex Twin", album: "Windowlicker", username: "joel", minutesAgo: 0, playerName: "Feishin" }] } }));
		if (u.pathname === "/rest/getArtists") return send(ok({ artists: { ignoredArticles: "The", index: [{ name: "A", artist: [{ id: "a1", name: "Air", albumCount: 3 }, { id: "a2", name: "Aphex Twin", albumCount: 5 }] }, { name: "M", artist: [{ id: "a3", name: "Moderat", albumCount: 2 }] }] } }));
		if (u.pathname === "/rest/getScanStatus") return send(ok({ scanStatus: { scanning: false, count: 1234, folderCount: 80, lastScan: "2026-10-18T06:00:00Z" } }));
		if (u.pathname === "/rest/getAlbumList2") {
			assert.equal(p.get("type"), "newest");
			return send(ok({ albumList2: { album: [{ id: "x", name: "MORE D4TA", artist: "Moderat" }] } }));
		}
	});
	const r = await run("navidrome", url, { username: "joel", password: "pw" });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Playing", 1], ["Albums", 10], ["Artists", 3], ["Tracks", 1234]]);
	assert.equal(r.items[0].title, "joel · Aphex Twin – Windowlicker");
	assert.equal(r.items[0].sub, "Windowlicker · Feishin");
	assert.equal(r.summary, "Newest: Moderat – MORE D4TA");
	await assert.rejects(run("navidrome", url, { username: "joel", password: "nope" }), /Access denied/);
	await assert.rejects(run("navidrome", url, { username: "joel" }), /User or password missing/);
});

test("Komga: list search with API key, legacy GET with basic auth and session", async () => {
	const libraries = [{ id: "1", name: "Comics", unavailable: false }, { id: "2", name: "Manga", unavailable: true }];
	const counts = { series: 42, books: 900, UNREAD: 600, IN_PROGRESS: 3 };
	// newer Komga: POST …/list with conditions, X-API-Key
	const modern = await serve((req, u, body, send) => {
		if (req.headers["x-api-key"] !== KEY) return send({ error: "Unauthorized" }, 401);
		if (u.pathname === "/api/v1/libraries") return send(libraries);
		const m = /^\/api\/v1\/(series|books)\/list$/.exec(u.pathname);
		if (m && req.method === "POST") {
			assert.equal(u.searchParams.get("size"), "1");
			const status = body && JSON.parse(body).condition ? JSON.parse(body).condition.readStatus.value : null;
			return send({ content: [], totalElements: counts[status || m[1]], size: 1 });
		}
	});
	const r = await run("komga", modern, { apiKey: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Series", 42], ["Books", 900], ["Unread", 600], ["Reading", 3]]);
	assert.deepEqual(r.items.map((i) => i.status), ["ok", "bad"]);
	assert.deepEqual(r.warnings, ["Library Manga is unavailable"]);
	await assert.rejects(run("komga", modern, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("komga", modern, {}), /API key or login missing/);

	// older Komga: only GET /series and /books, basic auth gives an X-Auth-Token session
	let logins = 0;
	const legacy = await serve((req, u, body, send) => {
		const basic = `Basic ${Buffer.from("me@x.ch:pw").toString("base64")}`;
		if (req.headers.authorization === basic) logins++;
		else if (req.headers["x-auth-token"] !== "sess-1") return send({ error: "Unauthorized" }, 401);
		const h = { "X-Auth-Token": "sess-1" };
		if (/\/list$/.test(u.pathname)) return send({ error: "Not Found" }, 404, h);
		if (u.pathname === "/api/v1/libraries") return send(libraries.slice(0, 1), 200, h);
		const m = /^\/api\/v1\/(series|books)$/.exec(u.pathname);
		if (m && req.method === "GET") return send({ content: [], totalElements: counts[u.searchParams.get("read_status") || m[1]] }, 200, h);
	});
	const r2 = await run("komga", legacy, { username: "me@x.ch", password: "pw" });
	assert.deepEqual(r2.metrics.map((m) => m.value), [42, 900, 600, 3]);
	assert.equal(r2.summary, "1 library");
	assert.equal(logins, 1, "the session token is reused after the first call");
	await run("komga", legacy, { username: "me@x.ch", password: "pw" });
	assert.equal(logins, 1);
	await assert.rejects(run("komga", legacy, { username: "me@x.ch", password: "wrong" }), /Access denied/);
});

test("Jackett: indexers, failing ones, admin password login", async () => {
	const indexers = [
		{ id: "1337x", name: "1337x", configured: true, last_error: null },
		{ id: "nyaasi", name: "Nyaa.si", configured: true, last_error: "Request to Nyaa.si failed (Error 503)" },
		{ id: "eztv", name: "EZTV", configured: true, last_error: "" }
	];
	// without an admin password
	const open = await serve((req, u, body, send) => {
		if (u.pathname !== "/api/v2.0/indexers") return;
		assert.equal(u.searchParams.get("configured"), "true");
		if (u.searchParams.get("apikey") !== KEY) return send({ error: "bad key" }, 401);
		return send(indexers);
	});
	const r = await run("jackett", open, { apiKey: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value, !!m.warn]), [["Indexers", 3, false], ["Failing", 1, true]]);
	assert.equal(r.items[0].title, "Nyaa.si");
	assert.equal(r.items[0].status, "bad");
	assert.deepEqual(r.warnings, ["1 indexer(s) failing: Nyaa.si"]);
	await assert.rejects(run("jackett", open, {}), /API key missing/);

	// with an admin password: redirect to the login page until the cookie is there
	let logins = 0;
	const locked = await serve((req, u, body, send) => {
		if (u.pathname === "/UI/Dashboard" && req.method === "POST") {
			if (body !== "password=s%C3%A9cret") return send("", 302, { Location: "/UI/Login" });
			logins++;
			return send("", 302, { Location: "/UI/Dashboard", "Set-Cookie": ["Jackett=abc123; path=/; httponly", "other=1"] });
		}
		if (u.pathname === "/api/v2.0/indexers") {
			if (req.headers.cookie !== "Jackett=abc123") return send("", 302, { Location: "/UI/Login?ReturnUrl=%2Fapi" });
			return send(indexers.slice(0, 1));
		}
	});
	await assert.rejects(run("jackett", locked, { apiKey: KEY }), /admin password/);
	await assert.rejects(run("jackett", locked, { apiKey: KEY, password: "wrong" }), /Access denied/);
	const r2 = await run("jackett", locked, { apiKey: KEY, password: "sécret" });
	assert.equal(r2.metrics[0].value, 1);
	await run("jackett", locked, { apiKey: KEY, password: "sécret" });
	assert.equal(logins, 1, "the session cookie is reused");
});

test("autobrr: pushed today, totals, filters and IRC health", async () => {
	const now = Date.now();
	const yesterday = new Date();
	yesterday.setDate(yesterday.getDate() - 1);
	const url = await serve((req, u, body, send) => {
		if (req.headers["x-api-token"] !== KEY) return send({ message: "unauthorized" }, 401);
		if (u.pathname === "/api/release/stats") return send({ total_count: 500, filtered_count: 60, filter_rejected_count: 440, push_approved_count: 55, push_rejected_count: 4, push_error_count: 1 });
		if (u.pathname === "/api/filters") return send([{ id: 1, name: "TV", enabled: true }, { id: 2, name: "Movies", enabled: true }, { id: 3, name: "Old", enabled: false }]);
		if (u.pathname === "/api/irc") return send([
			{ id: 1, name: "TorrentLeech", enabled: true, server: "irc.torrentleech.org", connected: true, healthy: true, connection_errors: [] },
			{ id: 2, name: "IPTorrents", enabled: true, server: "irc.iptorrents.com", connected: false, healthy: false, connection_errors: ["dial tcp: i/o timeout"] },
			{ id: 3, name: "Off", enabled: false, healthy: false }
		]);
		if (u.pathname === "/api/release") {
			assert.equal(u.searchParams.get("push_status"), "PUSH_APPROVED");
			return send({ data: [
				{ id: 3, name: "Show.S01E02", timestamp: new Date(now).toISOString(), action_status: [{ status: "PUSH_APPROVED", timestamp: new Date(now).toISOString() }] },
				{ id: 2, name: "Show.S01E01", timestamp: new Date(now - 1000).toISOString(), action_status: [] },
				{ id: 1, name: "Movie.2025", timestamp: yesterday.toISOString(), action_status: [{ status: "PUSH_APPROVED", timestamp: yesterday.toISOString() }] }
			], count: 3, next_cursor: 0 });
		}
	});
	const r = await run("autobrr", url, { apiKey: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Pushed today", 2], ["Pushed total", 55], ["Filters active", "2/3"], ["IRC healthy", "1/2"]]);
	assert.equal(metric(r, "IRC healthy").warn, true);
	assert.deepEqual(r.warnings, ["IRC network IPTorrents is disconnected"]);
	assert.equal(r.items[1].sub, "irc.iptorrents.com · disconnected · dial tcp: i/o timeout");
	assert.equal(r.summary, "1 push error(s)");
	await assert.rejects(run("autobrr", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("autobrr", url, {}), /API key missing/);
});

test("Tdarr: statistics document, nodes and an optional API key", async () => {
	const url = await serve((req, u, body, send) => {
		if (req.headers["x-api-key"] && req.headers["x-api-key"] !== KEY) return send({ error: "Unauthorized" }, 401);
		if (u.pathname === "/api/v2/cruddb" && req.method === "POST") {
			assert.deepEqual(JSON.parse(body), { data: { collection: "StatisticsJSONDB", mode: "getById", docID: "statistics" } });
			return send({ _id: "statistics", totalFileCount: 3000, totalTranscodeCount: 800, sizeDiff: 1234.5, table1Count: 10, table1ViewableCount: 8, table2Count: 700, table3Count: 2, table4Count: 4, table5Count: 2200, table6Count: 1 });
		}
		if (u.pathname === "/api/v2/get-nodes") return send({ n1: { _id: "n1", nodeName: "MainNode", nodePaused: false, workers: { w1: { file: "/media/a.mkv" }, w2: { file: "/media/b.mkv" } } }, n2: { _id: "n2", nodeName: "GPU", nodePaused: true, workers: {} } });
	});
	const r = await run("tdarr", url, {});
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Queue", 12], ["Processed", 2900], ["Errored", 3], ["Saved", "1.2 TB"]]);
	assert.equal(metric(r, "Errored").warn, true);
	assert.deepEqual(r.items.map((i) => [i.title, i.sub, i.status]), [["MainNode", "2 worker(s) busy", "ok"], ["GPU", "paused", "warn"]]);
	assert.equal(r.summary, "2 worker(s) busy on 2 node(s)");
	assert.equal((await run("tdarr", url, { apiKey: KEY })).metrics[0].value, 12);
	await assert.rejects(run("tdarr", url, { apiKey: "wrong" }), /Access denied/);
});

test("Unmanic: workers, pending, completed and failed tasks", async () => {
	const url = await serve((req, u, body, send) => {
		if (u.pathname === "/unmanic/api/v2/workers/status") return send({ workers_status: [
			{ id: "W0", name: "Worker-W0", idle: false, paused: false, current_file: "/library/movies/Dune (2024).mkv", current_task: 12 },
			{ id: "W1", name: "Worker-W1", idle: true, paused: false, current_file: "" }
		] });
		if (req.method !== "POST") return;
		assert.deepEqual(JSON.parse(body), { start: 0, length: 1 });
		if (u.pathname === "/unmanic/api/v2/pending/tasks") return send({ recordsTotal: 37, recordsFiltered: 37, results: [] });
		if (u.pathname === "/unmanic/api/v2/history/tasks") return send({ recordsTotal: 410, recordsFiltered: 410, successCount: 405, failedCount: 5, results: [] });
	});
	const r = await run("unmanic", url, {});
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Workers busy", "1/2"], ["Pending", 37], ["Completed", 405], ["Failed", 5]]);
	assert.deepEqual(r.items.map((i) => i.sub), ["Dune (2024).mkv", "idle"]);
});

test("FileFlows: /api/status, the Fenrus endpoint and its token", async () => {
	const old = await serve((req, u, body, send) => {
		if (u.pathname === "/api/status") return send({ queue: 14, processing: 2, processed: 1200, time: "1:23:45", processingFiles: [{ name: "Show.S01E01.mkv", library: "TV", step: "FFmpeg Builder", stepPercent: 42.4 }] });
	});
	const r = await run("fileflows", old, {});
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Queue", 14], ["Processing", 2], ["Processed", 1200], ["Time", "1:23:45"]]);
	assert.equal(r.items[0].sub, "TV · FFmpeg Builder · 42 %");

	const v26 = await serve((req, u, body, send) => {
		if (u.pathname !== "/webhook/fenrus") return;
		if (req.headers["x-webhook-token"] !== KEY) return send({ error: "Unauthorized" }, 401);
		return send({ Unprocessed: 5, Processing: 1, Processed: 300, Failed: 2 });
	});
	const r2 = await run("fileflows", v26, { token: KEY });
	valid(r2);
	assert.deepEqual(r2.metrics.map((m) => [en(m.label), m.value]), [["Queue", 5], ["Processing", 1], ["Processed", 300], ["Failed", 2]]);
	assert.equal(metric(r2, "Failed").warn, true);
	await assert.rejects(run("fileflows", v26, { token: "wrong" }), /Access denied/);
	await assert.rejects(run("fileflows", v26, {}), /Fenrus token missing/);
	// an old version with a token falls back to /api/status
	assert.equal((await run("fileflows", old, { token: KEY })).metrics[0].value, 14);
});

test("Tube Archivist: videos, channels, queue and size with the token", async () => {
	const url = await serve((req, u, body, send) => {
		if (req.headers.authorization !== `Token ${KEY}`) return send({ detail: "Invalid token." }, 401);
		if (u.pathname === "/api/stats/video/") return send({ doc_count: 2345, media_size: 1.5e12, duration: 3600000, duration_str: "41d 16h" });
		if (u.pathname === "/api/stats/channel/") return send({ doc_count: 25, active_true: 25, subscribed_true: 20 });
		if (u.pathname === "/api/stats/download/") return send({ pending: 12, pending_videos: 10, pending_shorts: 2, pending_streams: 0 });
		if (u.pathname === "/api/stats/playlist/") return send({ doc_count: 7, active_true: 7 });
	});
	const r = await run("tubearchivist", url, { token: KEY });
	valid(r);
	assert.deepEqual(r.metrics.map((m) => [en(m.label), m.value]), [["Videos", 2345], ["Channels", 25], ["Download queue", 12], ["Size", "1.5 TB"]]);
	assert.equal(r.summary, "41d 16h of video · 7 playlists");
	await assert.rejects(run("tubearchivist", url, { token: "wrong" }), /Access denied/);
	await assert.rejects(run("tubearchivist", url, {}), /API token missing/);
});
