"use strict";
// The integrations against a small fake server that answers like Jellyfin, Sonarr, Radarr,
// qBittorrent and MagicMirror Manager.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { Integrations } = require("../lib/integrations");

const KEY = "secret-key";
const DAY = 86400000;
let base;
let server;
const seen = [];

test.before(async () => {
	server = http.createServer((req, res) => {
		const url = new URL(req.url, "http://x");
		seen.push(`${req.method} ${url.pathname}`);
		const json = (v, status = 200, headers = {}) => {
			res.writeHead(status, { "Content-Type": "application/json", ...headers });
			res.end(JSON.stringify(v));
		};
		const p = url.pathname;
		// Jellyfin
		if (p.startsWith("/jf/")) {
			if (req.headers.authorization !== `MediaBrowser Client="HomeBento", Device="HomeBento", DeviceId="homebento", Version="1", Token="${KEY}"`) return json({}, 401);
			if (p === "/jf/Sessions") return json([{ UserName: "Joël", DeviceName: "Apple TV", PlayState: { PositionTicks: 50, IsPaused: false }, NowPlayingItem: { Type: "Episode", SeriesName: "Severance", Name: "Woe's Hollow", ParentIndexNumber: 2, IndexNumber: 4, RunTimeTicks: 100, SeriesId: "a".repeat(32), Id: "b".repeat(32) } }, { UserName: "idle" }]);
			if (p === "/jf/Users") return json([{ Id: "u1", Policy: { IsAdministrator: true } }]);
			if (p === "/jf/Items/Counts") return json({ MovieCount: 120, SeriesCount: 30, EpisodeCount: 900 });
			if (p === "/jf/Items/Latest") return json({}, 404); // older server: only the /Users/{id} route
			if (p === "/jf/Users/u1/Items/Latest") return json([{ Type: "Episode", SeriesName: "Shōgun", SeriesId: "c".repeat(32), Id: "d".repeat(32) }, { Type: "Movie", Name: "Dune", Id: "e".repeat(32), ProductionYear: 2024 }]);
		}
		// Sonarr / Radarr
		if (p === "/sonarr/api/v3/calendar") {
			if (req.headers["x-api-key"] !== KEY) return json({}, 401);
			return json([{ airDateUtc: new Date(Date.now() + 3600000).toISOString(), seasonNumber: 1, episodeNumber: 6, title: "Gold Summit", hasFile: false, series: { title: "The Penguin" } }]);
		}
		if (p === "/radarr/api/v3/calendar") {
			if (req.headers["x-api-key"] !== KEY) return json({}, 401);
			return json([{ title: "Smile 2", year: 2024, inCinemas: new Date(Date.now() - 30 * DAY).toISOString(), digitalRelease: new Date(Date.now() + 2 * DAY).toISOString(), hasFile: false }]);
		}
		// qBittorrent with login
		if (p === "/qb/api/v2/auth/login") {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => {
				if (body === "username=admin&password=pw") return json("Ok.", 200, { "Set-Cookie": "SID=abc; HttpOnly; path=/" });
				if (body === "username=v5&password=p%26w") {
					res.writeHead(204, { "Set-Cookie": ["other=1; path=/", "QBT_SID_8082=abc; HttpOnly; path=/"] });
					return res.end();
				}
				if (body.startsWith("username=v5&")) {
					res.writeHead(401, { "Content-Type": "text/plain" });
					return res.end("Unauthorized");
				}
				json("Fails.", 200);
			});
			return;
		}
		if (p.startsWith("/qb/api/v2/")) {
			if (req.headers.cookie !== "SID=abc" && req.headers.cookie !== "QBT_SID_8082=abc") return json({}, 403);
			if (p === "/qb/api/v2/transfer/info") return json({ dl_info_speed: 12_400_000, up_info_speed: 300_000 });
			if (p === "/qb/api/v2/torrents/info") return json([{ name: "Arcane", progress: 0.64, dlspeed: 8_000_000, eta: 360, state: "downloading" }]);
		}
		// Radarr movie details and cover
		if (p === "/radarr/api/v3/movie/7") return json({ id: 7, title: "Dune", year: 2024, overview: "Paul …", genres: ["Sci-Fi"], ratings: { imdb: { value: 8.5 } }, runtime: 166, hasFile: true, sizeOnDisk: 9e9, titleSlug: "dune-2024" });
		if (p === "/jf/Items" && url.searchParams.get("searchTerm") === "Dune") return json({ Items: [{ Id: "f".repeat(32), Name: "Dune", ProductionYear: 2024 }] });
		// solar dashboard
		if (p === "/solar/api/state") return json({ kwp: 19.2, live: { pv: 2206, cons: 457, bat: { soc: 7 } }, today: { yieldWh: 4234 } });
		if (p === "/solar/api/day") return json({ points: [{ m: 0, pv: 0 }, { m: 5, pv: 0 }, { m: 15, pv: 10 }, { m: 30, pv: 200 }] });
		// MagicMirror Manager with password
		if (p === "/mm/api/login") return json({ ok: true }, 200, { "Set-Cookie": "mmm_session=xyz; HttpOnly" });
		if (p === "/mm/api/status") {
			if (req.headers.cookie !== "mmm_session=xyz") return json({ error: "Please log in", login: true }, 401);
			return json({ process: { status: "online", restarts: 3 }, http: { up: true }, version: "2.33.0" });
		}
		json({ error: "not found" }, 404);
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const store = (secrets) => ({ secretsOf: () => secrets });

test("Jellyfin: now playing, recently added, library counts", async () => {
	const i = new Integrations(store({ apiKey: KEY }));
	const { data, error } = await i.data({ id: "j", kind: "jellyfin", url: `${base}/jf/` });
	assert.equal(error, undefined);
	assert.equal(data.now.length, 1);
	assert.deepEqual(data.now[0].episode, { season: 2, number: 4, name: "Woe's Hollow" });
	assert.equal(data.now[0].progress, 0.5);
	assert.equal(data.now[0].image, "a".repeat(32));
	assert.deepEqual(data.recent.map((r) => r.title), ["Shōgun", "Dune"]);
	assert.equal(data.counts.movies, 120);
});

test("Jellyfin without or with a wrong key: a readable error", async () => {
	assert.match((await new Integrations(store({})).data({ id: "j1", kind: "jellyfin", url: `${base}/jf` })).error, /API key missing/);
	assert.match((await new Integrations(store({ apiKey: "nope" })).data({ id: "j2", kind: "jellyfin", url: `${base}/jf` })).error, /denied/);
});

test("Sonarr and Radarr: upcoming items", async () => {
	const i = new Integrations(store({ apiKey: KEY }));
	const s = (await i.data({ id: "s", kind: "sonarr", url: `${base}/sonarr` })).data;
	assert.equal(s.items[0].title, "The Penguin");
	assert.deepEqual(s.items[0].sub, { season: 1, number: 6, name: "Gold Summit" });
	const r = (await i.data({ id: "r", kind: "radarr", url: `${base}/radarr` })).data;
	assert.equal(r.items.length, 1);
	assert.equal(r.items[0].sub.release, "digital", "past cinema release is skipped");
});

test("qBittorrent: logs in when needed and keeps the cookie", async () => {
	const i = new Integrations(store({ username: "admin", password: "pw" }));
	const { data, error } = await i.data({ id: "q", kind: "qbittorrent", url: `${base}/qb` });
	assert.equal(error, undefined);
	assert.equal(data.down, 12_400_000);
	assert.equal(data.torrents[0].name, "Arcane");
	const v5 = await new Integrations(store({ username: "v5", password: "p&w" })).data({ id: "q5", kind: "qbittorrent", url: `${base}/qb` });
	assert.equal(v5.error, undefined, "qBittorrent 5 cookie name QBT_SID_<port>");
	assert.equal(v5.data.torrents.length, 1);
	const bad = await new Integrations(store({ username: "admin", password: "wrong" })).data({ id: "q2", kind: "qbittorrent", url: `${base}/qb` });
	assert.match(bad.error, /Login failed/);
	const bad5 = await new Integrations(store({ username: "v5", password: "nope" })).data({ id: "q6", kind: "qbittorrent", url: `${base}/qb` });
	assert.match(bad5.error, /check user and password/);
});

test("MagicMirror Manager: logs in with the password on 401", async () => {
	const { data, error } = await new Integrations(store({ password: "pw" })).data({ id: "m", kind: "mmmanager", url: `${base}/mm` });
	assert.equal(error, undefined);
	assert.equal(data.process, "online");
	assert.equal(data.version, "2.33.0");
});

test("media card: Radarr movie with a link to the same movie in Jellyfin", async () => {
	const i = new Integrations({ secretsOf: (id) => ({ apiKey: KEY }) });
	const m = await i.media({ id: "r", kind: "radarr", url: `${base}/radarr` }, "movie-7", { id: "j", url: `${base}/jf`, name: "Jellyfin" });
	assert.equal(m.title, "Dune");
	assert.equal(m.rating, 8.5);
	assert.equal(m.runtime, 166);
	assert.equal(m.downloaded, true);
	assert.deepEqual(m.links.map((l) => l.kind), ["jellyfin", "radarr"]);
	assert.match(m.links[1].url, /\/movie\/dune-2024$/);
	await assert.rejects(i.media({ id: "r", kind: "radarr", url: `${base}/radarr` }, "series-7"), /Not found/);
});

test("results are cached: a second call within the TTL doesn't ask again", async () => {
	const i = new Integrations(store({ apiKey: KEY }));
	const svc = { id: "s9", kind: "sonarr", url: `${base}/sonarr` };
	await i.data(svc);
	const before = seen.length;
	await i.data(svc);
	assert.equal(seen.length, before);
});
