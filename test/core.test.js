"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { guessIcon, guessKind, niceName } = require("../lib/kinds");
const { demux, baseName, urlFor } = require("../lib/docker");
const { Store } = require("../lib/store");
const { Monitor, hourOf } = require("../lib/monitor");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sd-test-"));

test("icons and kinds from Docker images and names", () => {
	assert.equal(guessIcon(null, "linuxserver/sonarr:4.0.11"), "sonarr");
	assert.equal(guessIcon(null, "portainer/portainer-ce:2.24.0"), "portainer");
	assert.equal(guessIcon(null, "ghcr.io/home-assistant/home-assistant:stable"), "home-assistant");
	assert.equal(guessIcon("Uptime Kuma"), "uptime-kuma");
	assert.equal(niceName("uptime-kuma"), "Uptime Kuma");
	assert.equal(niceName("qbittorrent"), "qBittorrent");
	assert.equal(guessKind("qbittorrent", "linuxserver/qbittorrent"), "qbittorrent");
	assert.equal(guessKind("mm-manager"), "mmmanager");
	assert.equal(guessKind("flaresolverr"), null);
});

test("suggestion names: registry images keep theirs, compose builds use the service or project", () => {
	const c = (image, project, service) => ({ image, labels: project ? { "com.docker.compose.project": project, "com.docker.compose.service": service } : {} });
	assert.equal(baseName(c("postgres:16-alpine", "kontoauszug-reader", "db")), "postgres");
	assert.equal(baseName(c("kontoauszug-reader-app", "kontoauszug-reader", "app")), "kontoauszug-reader");
	assert.equal(baseName(c("solar-dashboard-solar-dashboard", "solar-dashboard", "solar-dashboard")), "solar-dashboard");
	assert.equal(baseName(c("linuxserver/sonarr:4", "media", "sonarr")), "sonarr");
	assert.equal(urlFor("nas", 80), "http://nas");
	assert.equal(urlFor("nas", 9443), "https://nas:9443");
	assert.equal(urlFor("nas", 5432), "");
});

test("Docker log frames are split into text", () => {
	const frame = (stream, text) => {
		const b = Buffer.from(text);
		const head = Buffer.alloc(8);
		head[0] = stream;
		head.writeUInt32BE(b.length, 4);
		return Buffer.concat([head, b]);
	};
	assert.equal(demux(Buffer.concat([frame(1, "out line\n"), frame(2, "err line\n")])), "out line\nerr line\n");
	assert.equal(demux(Buffer.from("plain tty output")), "plain tty output");
});

test("store: secrets never reach the web app; empty string removes them", () => {
	const dir = tmp();
	const st = new Store(dir);
	const s = st.saveService({ name: "Sonarr", url: "http://nas:8989", kind: "sonarr", secrets: { apiKey: "abc123" } });
	assert.deepEqual(st.public().services[0].secrets, { apiKey: true });
	assert.ok(!JSON.stringify(st.public()).includes("abc123"));
	assert.ok(!fs.readFileSync(path.join(dir, "config.json"), "utf8").includes("abc123"));
	assert.equal(st.secretsOf(s.id).apiKey, "abc123");
	st.saveService({ secrets: { apiKey: undefined } }, s.id);
	assert.equal(st.secretsOf(s.id).apiKey, "abc123", "undefined keeps the key");
	st.saveService({ secrets: { apiKey: "" } }, s.id);
	assert.equal(st.secretsOf(s.id).apiKey, undefined);
	assert.throws(() => st.saveService({ name: "x", url: "ftp://nas" }), /http/);
});

test("store: tile layouts are checked (types, sizes, unknown services, links)", () => {
	const st = new Store(tmp());
	const s = st.saveService({ name: "Jellyfin", url: "http://nas:8096" });
	const b = st.config.boards[0];
	const r = st.setTiles(b.id, [
		{ type: "service", service: s.id, w: 2, h: 2 },
		{ type: "service", service: "nope", w: 1, h: 1 },
		{ type: "evil", w: 1, h: 1 },
		{ type: "host", w: 9, h: 9 },
		{ type: "links", w: 2, h: 2, links: [{ name: "ok", url: "https://example.org" }, { name: "js", url: "javascript:alert(1)" }] }
	]);
	assert.deepEqual(r.tiles.map((t) => `${t.type}:${t.w}x${t.h}`), ["service:2x2", "host:1x1", "links:2x2"]);
	assert.equal(r.tiles[2].links.length, 1);
	st.removeService(s.id);
	assert.equal(st.config.boards[0].tiles.some((t) => t.service === s.id), false, "removing a service removes its tiles");
});

test("store: notes are Markdown; old entry lists become a checklist; the archive is kept", () => {
	const st = new Store(tmp());
	const b = st.config.boards[0];
	let r = st.setTiles(b.id, [{ type: "notes", w: 2, h: 2, notes: [{ text: "Backup", done: true }, { text: "Serien", done: false }] }]);
	assert.equal(r.tiles[0].text, "- [x] Backup\n- [ ] Serien");
	r = st.setTiles(b.id, [{ ...r.tiles[0], text: "# Liste\n- [ ] neu", archive: [{ text: "Backup", at: 1 }, { text: "" }] }]);
	assert.equal(r.tiles[0].text, "# Liste\n- [ ] neu");
	assert.deepEqual(r.tiles[0].archive, [{ text: "Backup", at: 1 }]);
});

test("monitor: hourly buckets give uptime and the 24 h view", () => {
	const st = new Store(tmp());
	const s = st.saveService({ name: "A", url: "http://a" });
	const m = new Monitor({ store: st, docker: null, dataDir: tmp() });
	const now = Date.now();
	for (let i = 0; i < 9; i++) m.bucket(s.id, now, { status: "up", ms: 100 });
	m.bucket(s.id, now, { status: "down", ms: null });
	assert.equal(m.uptime(s.id, 1), 90);
	const hours = m.hours(s.id, 24);
	assert.equal(hours.length, 24);
	assert.deepEqual(hours[23], { ok: 0.9, ms: 100 });
	assert.equal(hours[0].ok, null);
	assert.equal(hourOf(now) % 3600000, 0);
});

test("monitor: status changes become events, only on a real change", () => {
	const st = new Store(tmp());
	const s = st.saveService({ name: "A", url: "http://a" });
	const events = [];
	const m = new Monitor({ store: st, docker: null, dataDir: tmp(), onChange: (ev) => events.push(ev) });
	m.record(s, { status: "up", ms: 20 });
	m.record(s, { status: "up", ms: 25 });
	m.record(s, { status: "down", ms: null, error: "Connection refused" });
	m.record(s, { status: "up", ms: 30 });
	assert.deepEqual(events.map((e) => `${e.from}>${e.to}`), ["up>down", "down>up"]);
	assert.equal(events[0].detail, "Connection refused");
	assert.deepEqual(m.summary(s.id).recent, [20, 25, null, 30]);
});

test("releases: running version from image labels and comparing versions", () => {
	const { runningVersion, sameVersion, parseRepo } = require("../lib/releases");
	assert.equal(runningVersion({ labels: { "org.opencontainers.image.version": "4.0.20.3014-ls329" } }), "4.0.20.3014-ls329");
	assert.equal(runningVersion({ labels: { build_version: "Linuxserver.io version:- 5.2.4-ls480 Build-date:- 2026" } }), "5.2.4-ls480");
	assert.equal(runningVersion({ labels: { "org.opencontainers.image.version": "latest" } }), null);
	assert.equal(sameVersion("4.0.20.3014-ls329", "4.0.20.3014-ls329"), true);
	assert.equal(sameVersion("4.0.20.3014-ls328", "4.0.20.3014-ls329"), false);
	assert.equal(sameVersion("12.2.0", "v12.2-202610051851"), true);
	assert.equal(sameVersion("2.5.5", "2.5.6"), false);
	assert.equal(parseRepo("https://github.com/Sonarr/Sonarr.git"), "Sonarr/Sonarr");
	assert.equal(parseRepo("github.com/amir20/dozzle/releases"), "amir20/dozzle");
	assert.equal(parseRepo("nonsense"), null);
});

test("releases: the running version comes from the image, not from stale container labels", () => {
	const { runningVersion } = require("../lib/releases");
	// a container recreated with the old image's labels copied, now running the new image
	const c = { labels: { "org.opencontainers.image.version": "5.2.2_v2.0.13-ls462", "com.docker.compose.project": "media" }, imageLabels: { "org.opencontainers.image.version": "5.2.4_v2.0.15-ls481" } };
	assert.equal(runningVersion(c), "5.2.4_v2.0.15-ls481");
	assert.equal(runningVersion({ labels: { "org.opencontainers.image.version": "1.2.3" } }), "1.2.3");
});
