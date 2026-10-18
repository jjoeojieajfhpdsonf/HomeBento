"use strict";
// Jellystat, Tracearr, Maintainerr, Your Spotify, xTeVe, slskd, Stash, RomM and Minecraft against
// small fake servers that answer like the real APIs (Minecraft: a TCP server speaking the ping).
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
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

const run = (name, url, secrets = {}) => require(`../lib/plugins/${name}`).fetch({ url, secrets, service: {}, request, json });
const en = (v) => (v && typeof v === "object" ? v.en : v);
const metric = (r, label) => {
	const m = r.metrics.find((x) => en(x.label) === label);
	assert.ok(m, `metric ${label} in ${r.metrics.map((x) => en(x.label)).join(", ")}`);
	return m;
};
const valid = (r) => {
	assert.ok(r.metrics.length <= 4, "at most 4 metrics");
	for (const m of r.metrics) assert.ok(typeof m.label === "string" || (m.label.de && m.label.en), "label text or { de, en }");
	for (const i of r.items || []) assert.ok(["ok", "warn", "bad"].includes(i.status), "item status");
};

const NAMES = ["jellystat", "tracearr", "maintainerr", "yourspotify", "xteve", "slskd", "stash", "romm", "minecraft"];

test("media2 plugins: kind, label, match, secret fields and a fetch", () => {
	for (const name of NAMES) {
		const p = require(`../lib/plugins/${name}`);
		assert.equal(p.kind, name);
		assert.ok(p.label && p.match instanceof RegExp && Array.isArray(p.fields) && typeof p.fetch === "function", name);
		for (const f of p.fields) if (/key|password|token/i.test(f.key)) assert.equal(f.secret, true, `${name}.${f.key} is secret`);
	}
	const m = (name) => require(`../lib/plugins/${name}`).match;
	// the texts are "container image base" as lib/kinds.js joins them
	assert.ok(m("jellystat").test("jellystat cyfershepard/jellystat:latest jellystat"));
	assert.ok(!m("jellystat").test("jellystat-db postgres:15 postgres"));
	assert.ok(m("tracearr").test("tracearr ghcr.io/connorgallopo/tracearr:latest tracearr"));
	assert.ok(!m("tracearr").test("tracearr-redis redis:7 redis") && !m("tracearr").test("tracearr-db timescale/timescaledb timescaledb"));
	assert.ok(m("yourspotify").test("your_spotify_server yooooomi/your_spotify_server your_spotify_server"));
	assert.ok(!m("yourspotify").test("your_spotify_web yooooomi/your_spotify_client your_spotify_client"));
	assert.ok(!m("yourspotify").test("your_spotify_mongo mongo:6 mongo"));
	assert.ok(m("stash").test("stash stashapp/stash:latest stash") && !m("stash").test("stashcat x/stashcat stashcat"));
	assert.ok(m("romm").test("romm rommapp/romm:latest romm") && !m("romm").test("romm-db mariadb:latest mariadb"));
	assert.ok(m("minecraft").test("mc itzg/minecraft-server minecraft-server"));
	assert.ok(!m("minecraft").test("mc itzg/minecraft-bedrock-server minecraft-bedrock-server"));
});

test("Jellystat: plays, watch time and top users of the last 7 days", async () => {
	const url = await serve((req, u, body, send) => {
		if (!req.headers["x-api-token"]) return send({ message: "Authentication failed. No token or API key provided." }, 401);
		if (req.headers["x-api-token"] !== KEY) return send({ message: "Invalid API key" }, 403);
		if (u.pathname === "/stats/getViewsByLibraryType" && req.method === "GET") {
			assert.equal(u.searchParams.get("days"), "7");
			return send({ Audio: "40", Movie: "3", Series: "12", Other: 0 });
		}
		if (u.pathname === "/stats/getMostActiveUsers" && req.method === "POST") {
			assert.deepEqual(JSON.parse(body), { days: 7 });
			return send([{ Plays: "30", UserId: "a", Name: "joel" }, { Plays: "1", UserId: "b", Name: "anna" }]);
		}
		if (u.pathname === "/stats/getViewsOverTime") return send({ libraries: [{ Id: "1", Name: "Movies" }, { Id: "2", Name: "Shows" }], stats: [{ Key: "Oct 17, 2026", Movies: { count: 1, duration: 120 }, Shows: { count: 4, duration: 180 } }, { Key: "Oct 18, 2026", Movies: { count: 0, duration: 0 }, Shows: { count: 8, duration: 330 } }] });
	});
	const r = await run("jellystat", url, { apiKey: KEY });
	valid(r);
	assert.equal(metric(r, "Plays (7 d)").value, 55);
	assert.equal(metric(r, "Watch time (7 d)").value, "11 h");
	assert.equal(metric(r, "Top user").value, "joel");
	assert.deepEqual(r.items.map((i) => [i.title, i.sub]), [["joel", "30 plays"], ["anna", "1 play"]]);
	assert.equal(r.summary, "12 episodes · 3 movies · 40 songs");
	await assert.rejects(run("jellystat", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("jellystat", url, {}), /API key missing/);
});

test("Tracearr: streams, transcodes, bitrate and open alerts", async () => {
	const url = await serve((req, u, body, send) => {
		if (req.headers.authorization !== `Bearer ${KEY}`) return send({ error: "Unauthorized" }, 401);
		if (u.pathname === "/api/v1/public/streams") return send({
			data: [
				{ id: "1", serverName: "Plex", username: "joel", mediaTitle: "Woe's Hollow", mediaType: "episode", showTitle: "Severance", seasonNumber: 2, episodeNumber: 4, durationMs: 2400000, progressMs: 600000, state: "playing", isTranscode: true, videoDecision: "transcode", device: "Apple TV" },
				{ id: "2", serverName: "Jellyfin", username: "anna", mediaTitle: "Dune", mediaType: "movie", year: 2024, durationMs: 0, progressMs: 0, state: "paused", isTranscode: false, videoDecision: "directplay", device: null }
			],
			summary: { total: 2, transcodes: 1, directStreams: 0, directPlays: 1, totalBitrate: "24.5 Mbps", byServer: [] }
		});
		if (u.pathname === "/api/v1/public/violations") {
			assert.equal(u.searchParams.get("acknowledged"), "false");
			return send({ data: [{ id: "v1", serverName: "Plex", severity: "high", acknowledged: false, rule: { id: "r", type: "concurrent_streams", name: "Too many streams" }, user: { id: "u", username: "max" } }], meta: { total: 3, page: 1, pageSize: 10 } });
		}
		if (u.pathname === "/api/v1/public/health") return send({ status: "ok", version: "1.0.0", servers: [{ id: "s1", name: "Plex", type: "plex", online: true, activeStreams: 1 }, { id: "s2", name: "Emby", type: "emby", online: false, activeStreams: 0 }] });
	});
	const r = await run("tracearr", url, { apiKey: KEY });
	valid(r);
	assert.equal(metric(r, "Streams").value, 2);
	assert.equal(metric(r, "Transcodes").value, 1);
	assert.equal(metric(r, "Bitrate").value, "24.5 Mbps");
	assert.equal(metric(r, "Open alerts").value, 3);
	assert.equal(metric(r, "Open alerts").warn, true);
	assert.equal(r.items[0].title, "joel · Severance S02E04");
	assert.equal(r.items[0].sub, "Apple TV · 25 % · transcode");
	assert.equal(r.items[1].title, "anna · Dune (2024)");
	assert.equal(r.items[1].status, "warn");
	assert.deepEqual(r.items[2], { title: "Too many streams", sub: "max · Plex · high", status: "bad" });
	assert.deepEqual(r.warnings, ["Media server Emby is offline"]);
	await assert.rejects(run("tracearr", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("tracearr", url, {}), /API key missing/);
});

test("Maintainerr: rules, media scheduled for removal and reclaimable space", async () => {
	let metrics = true;
	const url = await serve((req, u, body, send) => {
		if (u.pathname === "/api/collections") return send([
			{ id: 1, title: "Old movies", isActive: true, deleteAfterDays: 30, mediaCount: 12, totalSizeBytes: 400e9, handledMediaAmount: 5 },
			{ id: 2, title: "Watched shows", isActive: true, deleteAfterDays: 0, mediaCount: 4, totalSizeBytes: null, handledMediaAmount: 0 },
			{ id: 3, title: "Paused rule", isActive: false, deleteAfterDays: 10, mediaCount: 7, totalSizeBytes: 50e9, handledMediaAmount: 2 }
		]);
		if (u.pathname === "/api/storage-metrics" && metrics) return send({ totals: {}, instances: [{ id: 1, name: "Radarr", type: "radarr", ok: false, error: "Connection refused", mountCount: 0 }], collectionSummary: { activeSizeBytes: 1.2e12 }, cleanupTotals: { itemsHandled: 42 } });
	});
	const r = await run("maintainerr", url);
	valid(r);
	assert.equal(metric(r, "Rules active").value, "2/3");
	assert.equal(metric(r, "Scheduled for removal").value, 12);
	assert.equal(metric(r, "Reclaimable").value, "1.2 TB");
	assert.equal(metric(r, "Handled so far").value, 42);
	assert.deepEqual(r.items[0], { title: "Old movies", sub: "12 items · removed after 30 d · 400 GB", status: "ok" });
	assert.equal(r.items[2].sub, "7 items · inactive · 50 GB");
	assert.equal(r.items[2].status, "warn");
	assert.deepEqual(r.warnings, ["Radarr: Connection refused"]);
	// older versions without /api/storage-metrics
	metrics = false;
	const old = await run("maintainerr", url);
	assert.equal(metric(old, "Reclaimable").value, "400 GB");
	assert.equal(metric(old, "Handled so far").value, 7);
});

test("Your Spotify: songs, listening time, artists and top artists with the public token", async () => {
	const url = await serve((req, u, body, send) => {
		if (u.searchParams.get("token") !== KEY) return send({ code: "NOT_LOGGED" }, 401);
		assert.ok(!isNaN(Date.parse(u.searchParams.get("start"))) && !isNaN(Date.parse(u.searchParams.get("end"))));
		if (u.pathname === "/spotify/songs_per") return send([{ _id: { year: 2026 }, count: 321 }]);
		if (u.pathname === "/spotify/time_per") return send([{ _id: { year: 2026 }, count: 5.4e7 }]);
		if (u.pathname === "/spotify/different_artists_per") return send([{ _id: { year: 2026 }, artists: [{}, {}, {}] }]);
		if (u.pathname === "/spotify/top/artists") {
			assert.equal(u.searchParams.get("nb"), "5");
			return send([{ count: 40, duration_ms: 9e6, artist: { name: "Radiohead" } }, { count: 1, duration_ms: 2e5, artist: { name: "Björk" } }]);
		}
	});
	const r = await run("yourspotify", url, { token: KEY });
	valid(r);
	assert.equal(metric(r, "Songs (7 d)").value, 321);
	assert.equal(metric(r, "Listened (7 d)").value, "15 h");
	assert.equal(metric(r, "Artists").value, 3);
	assert.deepEqual(r.items.map((i) => [i.title, i.sub]), [["Radiohead", "40 plays · 2.5 h"], ["Björk", "1 play · 3 min"]]);
	await assert.rejects(run("yourspotify", url, { token: "wrong" }), /Access denied/);
	await assert.rejects(run("yourspotify", url, {}), /Public token missing/);
});

test("xTeVe: status without and with API authentication", async () => {
	let auth = false;
	let logins = 0;
	const issued = new Set();
	const url = await serve((req, u, body, send) => {
		if (u.pathname !== "/api/" || req.method !== "POST") return;
		const q = JSON.parse(body);
		const status = (extra) => send({ status: true, "streams.all": 63, "streams.active": 7, "streams.xepg": 2, "version.xteve": "2.2.0", "epg.source": "XEPG", ...extra });
		if (!auth) return q.cmd === "status" ? status() : send({ status: true });
		const token = () => {
			const t = `t${Math.random()}`;
			issued.add(t);
			return t;
		};
		if (q.cmd === "login") {
			logins++;
			if (q.username === "plex" && q.password === KEY) return send({ status: true, token: token() });
			return send({ status: false, err: "User authentication failed" });
		}
		// every token is valid once, like xTeVe
		if (!q.token || !issued.delete(q.token)) return send({ status: false, err: "Login incorrect" });
		return status({ token: token() });
	});
	const r = await run("xteve", url);
	valid(r);
	assert.equal(metric(r, "Channels").value, 63);
	assert.equal(metric(r, "Filtered").value, 7);
	assert.equal(metric(r, "In XEPG").value, 2);
	assert.equal(r.summary, "xTeVe 2.2.0 · EPG: XEPG");
	auth = true;
	await assert.rejects(run("xteve", url), /User and password missing/);
	const a = await run("xteve", url, { username: "plex", password: KEY });
	assert.equal(metric(a, "Channels").value, 63);
	await run("xteve", url, { username: "plex", password: KEY });
	assert.equal(logins, 1, "the token of the last answer is reused");
	issued.clear(); // tokens expired: logs in again
	await run("xteve", url, { username: "plex", password: KEY });
	assert.equal(logins, 2);
	await assert.rejects(run("xteve", url, { username: "plex", password: "wrong" }), /Access denied/);
});

test("slskd: connection, active transfers and shares", async () => {
	let connected = true;
	const url = await serve((req, u, body, send) => {
		if (req.headers["x-api-key"] !== KEY) return send("", 401, { "Content-Type": "text/plain" });
		if (u.pathname === "/api/v0/application") return send({ version: { current: "0.22.0" }, server: { address: "server.slsknet.org:2271", state: connected ? "Connected, LoggedIn" : "Disconnected", isConnected: connected, isLoggedIn: connected }, shares: { files: 12345, directories: 800 } });
		if (u.pathname === "/api/v0/transfers/downloads") return send([
			{ username: "alice", directories: [{ directory: "@@x\\Music\\Album", fileCount: 3, files: [
				{ username: "alice", filename: "@@x\\Music\\Album\\01 Song.flac", state: "InProgress", size: 40e6, bytesTransferred: 10e6, averageSpeed: 2.5e6 },
				{ username: "alice", filename: "@@x\\Music\\Album\\02 Song.flac", state: "Queued, Remotely", size: 30e6, bytesTransferred: 0, averageSpeed: 0 },
				{ username: "alice", filename: "@@x\\Music\\Album\\00 Intro.flac", state: "Completed, Succeeded", size: 1e6, bytesTransferred: 1e6, averageSpeed: 1e6 }
			] }] }
		]);
		if (u.pathname === "/api/v0/transfers/uploads") return send([{ username: "bob", directories: [{ directory: "Music\\X", fileCount: 1, files: [{ username: "bob", filename: "Music\\X\\track.mp3", state: "Initializing", size: 5e6, bytesTransferred: 0, averageSpeed: 0 }] }] }]);
	});
	const r = await run("slskd", url, { apiKey: KEY });
	valid(r);
	assert.equal(en(metric(r, "Soulseek").value), "Connected");
	assert.equal(metric(r, "Downloads active").value, 1);
	assert.equal(metric(r, "Uploads active").value, 1);
	assert.equal(metric(r, "Download").value, "2.5 MB/s");
	assert.deepEqual(r.items[0], { title: "01 Song.flac", sub: "↓ alice · 25 % · 2.5 MB/s", status: "ok" });
	assert.equal(r.items[1].title, "track.mp3");
	assert.equal(r.summary, "1 queued · 12,345 shared files");
	assert.deepEqual(r.warnings, []);
	connected = false;
	const off = await run("slskd", url, { apiKey: KEY });
	assert.equal(metric(off, "Soulseek").warn, true);
	assert.equal(off.warnings.length, 1);
	await assert.rejects(run("slskd", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("slskd", url, {}), /API key missing/);
});

test("Stash: scenes, images, performers and size via GraphQL", async () => {
	const url = await serve((req, u, body, send) => {
		if (u.pathname !== "/graphql" || req.method !== "POST") return;
		if (req.headers.apikey !== KEY) return send("Unauthorized", 401, { "Content-Type": "text/plain" });
		assert.match(JSON.parse(body).query, /stats\s*\{[^}]*scene_count/);
		return send({ data: { stats: { scene_count: 1200, scenes_size: 2.4e12, scenes_duration: 360000, image_count: 5000, images_size: 0.1e12, gallery_count: 30, performer_count: 85, studio_count: 12, tag_count: 140 } } });
	});
	const r = await run("stash", url, { apiKey: KEY });
	valid(r);
	assert.equal(metric(r, "Scenes").value, 1200);
	assert.equal(metric(r, "Images").value, 5000);
	assert.equal(metric(r, "Performers").value, 85);
	assert.equal(metric(r, "Size").value, "2.5 TB");
	assert.equal(r.summary, "4 d of video · 30 galleries · 12 studios · 140 tags");
	await assert.rejects(run("stash", url, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("stash", url, {}), /API key missing/);
	const bad = await serve((req, u, body, send) => send({ errors: [{ message: "Cannot query field \"stats\"" }], data: null }));
	await assert.rejects(run("stash", bad, {}), /Stash: Cannot query field/);
});

test("RomM: stats without login, platforms with basic auth or a token", async () => {
	const basic = `Basic ${Buffer.from(`joel:${KEY}`).toString("base64")}`;
	const url = await serve((req, u, body, send) => {
		const a = req.headers.authorization;
		if (a && a !== basic && a !== `Bearer rmm_${KEY}`) return send({ detail: "Invalid credentials" }, 401);
		if (u.pathname === "/api/stats") return send({ PLATFORMS: 4, ROMS: 812, SAVES: 25, STATES: 9, SCREENSHOTS: 3, TOTAL_FILESIZE_BYTES: 120e9 });
		if (u.pathname === "/api/platforms") {
			if (!a) return send({ detail: "Forbidden" }, 403);
			return send([{ id: 1, slug: "snes", name: "Super Nintendo", display_name: "SNES", rom_count: 400, fs_size_bytes: 1.5e9 }, { id: 2, slug: "gba", name: "Game Boy Advance", rom_count: 412, fs_size_bytes: 6e9 }, { id: 3, slug: "n64", name: "N64", rom_count: 0, fs_size_bytes: 0 }]);
		}
	});
	const r = await run("romm", url);
	valid(r);
	assert.equal(metric(r, "Platforms").value, 4);
	assert.equal(metric(r, "ROMs").value, 812);
	assert.equal(metric(r, "Saves").value, 25);
	assert.equal(metric(r, "Size").value, "120 GB");
	assert.equal(r.summary, "9 save states · 3 screenshots");
	assert.deepEqual(r.items, []);
	const b = await run("romm", url, { username: "joel", password: KEY });
	assert.deepEqual(b.items.map((i) => [i.title, i.sub]), [["Game Boy Advance", "412 ROMs · 6.0 GB"], ["SNES", "400 ROMs · 1.5 GB"]]);
	const t = await run("romm", url, { token: `rmm_${KEY}` });
	assert.equal(t.items.length, 2);
	await assert.rejects(run("romm", url, { username: "joel", password: "wrong" }), /Access denied/);
});

// A fake Minecraft server: reads the handshake and the status request, answers with the status JSON.
async function minecraft(status, check) {
	const server = net.createServer((sock) => {
		let buf = Buffer.alloc(0);
		sock.on("data", (c) => {
			buf = Buffer.concat([buf, c]);
			const len = buf[0]; // the handshake is shorter than 128 bytes
			if (buf.length < 1 + len + 2) return;
			const hs = buf.subarray(1, 1 + len);
			assert.equal(hs[0], 0x00, "handshake packet id");
			const hostLen = hs[6]; // id (1) + protocol version -1 (5 bytes)
			check({ host: hs.subarray(7, 7 + hostLen).toString(), port: hs.readUInt16BE(7 + hostLen), next: hs[9 + hostLen] });
			assert.deepEqual([...buf.subarray(1 + len, 3 + len)], [0x01, 0x00], "status request");
			const text = Buffer.from(JSON.stringify(status));
			const varint = (n) => {
				const out = [];
				do {
					let b = n & 0x7f;
					n >>>= 7;
					if (n) b |= 0x80;
					out.push(b);
				} while (n);
				return Buffer.from(out);
			};
			const body = Buffer.concat([Buffer.from([0x00]), varint(text.length), text]);
			const whole = Buffer.concat([varint(body.length), body]);
			// in two parts, like a real network might deliver it
			sock.write(whole.subarray(0, 10));
			setTimeout(() => sock.end(whole.subarray(10)), 20);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	return server.address().port;
}

test("Minecraft: players, version and MOTD via the Server List Ping", async () => {
	let seen = null;
	const sample = Array.from({ length: 40 }, (_, i) => ({ name: `Player${i}`, id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}` }));
	const port = await minecraft({ version: { name: "Paper 1.21.4", protocol: 769 }, players: { max: 20, online: 2, sample: [{ name: "Steve", id: "a" }, { name: "Alex", id: "b" }] }, description: { text: "", extra: [{ text: "§aHome ", bold: true }, { text: "Server" }] } }, (h) => (seen = h));
	const r = await run("minecraft", `http://127.0.0.1:${port}`);
	valid(r);
	assert.deepEqual(seen, { host: "127.0.0.1", port, next: 1 });
	assert.equal(metric(r, "Players").value, "2/20");
	assert.equal(metric(r, "Version").value, "Paper 1.21.4");
	assert.match(metric(r, "Ping").value, /^\d+ ms$/);
	assert.deepEqual(r.items.map((i) => i.title), ["Steve", "Alex"]);
	assert.equal(r.summary, "Home Server");
	// a long status (MOTD as plain text with colour codes, many players) spans several reads
	const big = await minecraft({ version: { name: "1.20.1" }, players: { max: 100, online: 40, sample }, description: "§6Big §lserver" }, () => {});
	const b = await run("minecraft", `http://127.0.0.1:${big}`);
	assert.equal(b.items.length, 40);
	assert.equal(b.summary, "Big server");
	// nothing listens on the port
	const closed = net.createServer();
	await new Promise((res) => closed.listen(0, "127.0.0.1", res));
	const free = closed.address().port;
	await new Promise((res) => closed.close(res));
	await assert.rejects(run("minecraft", `http://127.0.0.1:${free}`), /Connection refused/);
	// an HTTP server is not a Minecraft server
	const web = await serve((req, u, body, send) => send({}));
	await assert.rejects(run("minecraft", web), /closed the connection|Unexpected answer|Timeout/);
});
