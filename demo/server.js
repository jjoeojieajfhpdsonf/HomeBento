"use strict";
// HomeBento with made-up data: every tile and integration filled, values moving.
// For trying the dashboard, screenshots and checking the design – nothing here talks to real services
// (only the weather comes from Open-Meteo, with made-up values when that isn't reachable).
//
//   node demo/server.js            → http://localhost:8122
//
// Pages, tiles and settings work for real (kept in a temporary folder until the demo stops).
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../lib/store");
const { KINDS } = require("../lib/kinds");
const widgets = require("../lib/widgets");
const holidays = require("../lib/holidays");
const notify = require("../lib/notify");
const importers = require("../lib/importers");
const { UserError } = require("../lib/errors");

const PORT = Number(process.env.PORT) || 8122;
const PUBLIC = path.join(__dirname, "..", "public");
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "homebento-demo-"));
const store = new Store(DIR);
const L = (de, en) => ({ de, en });
const now = () => Date.now();
const dayStr = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
// a smooth wobble per key, so values move a little between polls
const wob = (key, amp = 1, period = 90000) => {
	let hsh = 0;
	for (const ch of String(key)) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
	return Math.sin(now() / period + (hsh % 628) / 100) * amp;
};
const rnd = (key) => {
	let hsh = 2166136261;
	for (const ch of String(key)) hsh = Math.imul(hsh ^ ch.charCodeAt(0), 16777619) >>> 0;
	return (hsh % 10000) / 10000;
};

// ---------- services ----------

const SERVICES = [
	// media
	["Jellyfin", 8096, "jellyfin", "jellyfin"],
	["Sonarr", 8989, "sonarr", "sonarr"],
	["Radarr", 7878, "radarr", "radarr"],
	["Prowlarr", 9696, "prowlarr", "prowlarr"],
	["qBittorrent", 8082, "qbittorrent", "qbittorrent"],
	["Jellyseerr", 5055, "overseerr", "jellyseerr"],
	["Bazarr", 6767, "bazarr", "bazarr"],
	["Lidarr", 8686, "lidarr", "lidarr"],
	["Plex", 32400, "plex", "plex"],
	["Tautulli", 8181, "tautulli", "tautulli"],
	["SABnzbd", 8085, "sabnzbd", "sabnzbd"],
	// home
	["EVCC", 7070, "evcc", "evcc"],
	["OpenDTU", 80, "opendtu", "opendtu", "192.168.1.40"],
	["MagicMirror", 8080, "magicmirror", null, "192.168.1.20"],
	["Mirror Manager", 8090, "mmmanager", null, "192.168.1.20"],
	["Home Assistant", 8123, "homeassistant", "home-assistant"],
	["Frigate", 5000, "frigate", "frigate"],
	["Immich", 2283, "immich", "immich"],
	["Paperless", 8000, "paperless", "paperless-ngx"],
	["Nextcloud", 8443, "nextcloud", "nextcloud", null, "https"],
	// system
	["Portainer", 9443, "portainer", "portainer", null, "https"],
	["Proxmox", 8006, "proxmox", "proxmox", "192.168.1.5", "https"],
	["TrueNAS", 443, "truenas", "truenas-scale", "192.168.1.6", "https"],
	["Pi-hole", 8053, "pihole", "pi-hole"],
	["AdGuard Home", 3000, "adguard", "adguard-home"],
	["Traefik", 8088, "traefik", "traefik"],
	["Nginx Proxy Manager", 81, "nginxproxymanager", "nginx-proxy-manager"],
	["wg-easy", 51821, "wgeasy", "wireguard"],
	["Uptime Kuma", 3001, "uptimekuma", "uptime-kuma"],
	["Grafana", 3030, "grafana", "grafana"],
	["Prometheus", 9090, "prometheus", "prometheus"],
	["Glances", 61208, "glances", "glances"],
	["Syncthing", 8384, "syncthing", "syncthing"],
	["Scrutiny", 8087, "scrutiny", "scrutiny"],
	["Speedtest Tracker", 8765, "speedtest", "speedtest-tracker"],
	["Vaultwarden", 8222, "vaultwarden", "vaultwarden"],
	["Gitea", 3002, "gitea", "gitea"],
	["UniFi", 8443, "unifi", "unifi", "192.168.1.1", "https"],
	["FlareSolverr", 8191, null, "flaresolverr"],
	["Watchtower", 8070, "watchtower", "watchtower"],
	["Dozzle", 8089, null, "dozzle"]
];
const sid = {};
for (const [name, target, type, icon] of [["Router", "192.168.1.1", "ping", "router"], ["Printer", "192.168.1.30:631", "tcp", "printer"], ["NAS (SSH)", "192.168.1.6:22", "tcp", "synology"]]) {
	const s = store.saveService({ name, url: "", icon, checkType: type, checkTarget: target });
	sid[name] = s.id;
}
for (const [name, port, kind, icon, hostIp, proto] of SERVICES) {
	const s = store.saveService({ name, url: `${proto || "http"}://${hostIp || "192.168.1.10"}:${port}`, kind: kind && KINDS[kind] ? kind : null, icon: icon || "", container: hostIp ? null : (icon || name).toLowerCase().replace(/[^a-z0-9]+/g, "-") });
	sid[name] = s.id;
}
const svcTiles = (names) => names.map((n) => ({ type: "service", service: sid[n], w: 2, h: 2 }));

// ---------- pages ----------

store.config.title = "";
store.config.location = { name: "Zürich", lat: 47.3769, lon: 8.5417 };
const pages = [
	["Overview", [
		// every row full: 6 columns
		{ type: "clock", w: 2, h: 1, zones: [{ name: "New York", zone: "America/New_York" }, { name: "Tokio", zone: "Asia/Tokyo" }] },
		{ type: "weather", w: 2, h: 2 },
		{ type: "ical", w: 2, h: 2, calendars: [{ name: "Family", url: "https://demo.invalid/familie.ics", color: "#9dbcff" }, { name: "Work", url: "https://demo.invalid/arbeit.ics", color: "#f5b83d" }] },
		{ type: "downloads", w: 2, h: 1 },
		{ type: "jellyfin", w: 3, h: 2 },
		{ type: "calendar", w: 3, h: 2 },
		{ type: "host", w: 2, h: 2 },
		{ type: "markets", w: 2, h: 2, symbols: ["^GSPC", "NVDA", "AAPL"], fx: ["EUR", "USD"], crypto: ["bitcoin"], base: "CHF" },
		{ type: "holidays", w: 2, h: 2, canton: "ZH" },
		{ type: "notes", w: 2, h: 2, text: "## This week\n- [x] Check the backup\n- [ ] Clean up Sonarr series\n- [ ] Update **FlareSolverr**\n- Router firmware: see the [changelog](https://example.com)" },
		{ type: "rss", w: 2, h: 2, feeds: [{ name: "Tech-Feed", url: "https://demo.invalid/tech.xml" }, { name: "Local", url: "https://demo.invalid/lokal.xml" }] },
		{ type: "countdown", w: 2, h: 1, items: [{ name: "Autumn holidays", date: dayStr(9) }, { name: "Mia's birthday", date: dayStr(23), yearly: true }, { name: "Christmas", date: `${new Date().getFullYear()}-12-24`, yearly: true }] },
		{ type: "links", w: 2, h: 1, links: [{ name: "Router", url: "http://192.168.1.1" }, { name: "Printer", url: "http://192.168.1.30" }, { name: "GitHub", url: "https://github.com" }] }
	]],
	["Media", [
		// tall ones on top, four 2×1 below: full with 6 and with 8 columns
		{ type: "jellyfin", w: 3, h: 2 },
		{ type: "calendar", w: 3, h: 2 },
		{ type: "iframe", w: 2, h: 2, title: "Grafana · Streams", url: `http://localhost:${PORT}/demo-panel.html` },
		{ type: "downloads", w: 2, h: 1 },
		{ type: "api", w: 2, h: 1, title: "Jellyfin stats", api: { url: "http://192.168.1.10:3000/stats", fields: [{ label: "Plays (7 days)", path: "plays" }, { label: "Hours", path: "hours" }, { label: "Top", path: "top" }] } },
		{ type: "countdown", w: 2, h: 1, title: "In cinemas", items: [{ name: "Avatar 4", date: dayStr(42) }, { name: "Dune: Messiah", date: dayStr(95) }] },
		{ type: "storage", w: 2, h: 1 },
		...svcTiles(["Jellyfin", "Sonarr", "Radarr", "Prowlarr", "qBittorrent", "Jellyseerr", "Bazarr", "Lidarr", "Plex", "Tautulli", "SABnzbd"])
	]],
	["Home", [
		{ type: "camera", w: 3, h: 2, title: "Front door", url: "http://192.168.1.50/snapshot.jpg", mode: "snapshot", refresh: 3 },
		{ type: "weather", w: 3, h: 2, place: { name: "Zermatt", lat: 46.0207, lon: 7.7491 } },
		{ type: "mirror", w: 2, h: 2 },
		{ type: "clock", w: 2, h: 1, seconds: true, analog: true },
		{ type: "api", w: 2, h: 1, title: "Aare", api: { url: "https://aareguru.existenz.ch/v2018/current?city=bern", fields: [{ label: "Water", path: "aare.temperature", suffix: "°C" }, { label: "Flow", path: "aare.flow", suffix: "m³/s" }, { label: "Air", path: "weather.current.tt", suffix: "°C" }] } },
		{ type: "countdown", w: 2, h: 1, items: [{ name: "Ski trip", date: dayStr(68) }, { name: "Bin day: green waste", date: dayStr(2) }] },
		{ type: "holidays", w: 2, h: 1, canton: "BE" },
		...svcTiles(["EVCC", "OpenDTU", "MagicMirror", "Mirror Manager", "Home Assistant", "Frigate", "Immich", "Paperless", "Nextcloud", "Router", "Printer"])
	]],
	["System", [
		{ type: "host", w: 2, h: 2 },
		{ type: "disks", w: 2, h: 2 },
		{ type: "network", w: 2, h: 2 },
		{ type: "docker", w: 3, h: 2 },
		{ type: "uptime", w: 3, h: 2 },
		{ type: "releases", w: 2, h: 3, repos: ["jellyfin/jellyfin", "Sonarr/Sonarr", "Radarr/Radarr", "qbittorrent/qBittorrent", "home-assistant/core", "immich-app/immich", "louislam/uptime-kuma", "jjoeojieajfhpdsonf/HomeBento"], seen: {} },
		{ type: "events", w: 2, h: 3 },
		{ type: "tailscale", w: 2, h: 2 },
		{ type: "api", w: 2, h: 1, title: "Backup", api: { url: "http://192.168.1.6:8200/api/last", fields: [{ label: "Last", path: "last", format: "relative" }, { label: "Size", path: "size", format: "bytes" }, { label: "Took", path: "took", format: "duration" }] } },
		// three more 2×1: the page is full with 6 and with 8 columns
		{ type: "api", w: 2, h: 1, title: "Speedtest", api: { url: "http://192.168.1.10:8765/api/v1/results/latest", fields: [{ label: "↓ Mbit/s", path: "data.download" }, { label: "↑ Mbit/s", path: "data.upload" }, { label: "Ping", path: "data.ping", suffix: "ms" }] } },
		{ type: "api", w: 2, h: 1, title: "Internet", api: { url: "https://ipinfo.io/json", fields: [{ label: "Public IP", path: "ip" }, { label: "City", path: "city" }, { label: "Provider", path: "org" }] } },
		{ type: "api", w: 2, h: 1, title: "Server power", api: { url: "http://192.168.1.60/report", fields: [{ label: "Now", path: "power", suffix: "W" }, { label: "Today", path: "today", suffix: "kWh" }, { label: "Per month", path: "month", suffix: "CHF" }] } },
		...svcTiles(["Portainer", "Proxmox", "TrueNAS", "Pi-hole", "AdGuard Home", "Traefik", "Nginx Proxy Manager", "wg-easy", "Uptime Kuma", "Grafana", "Prometheus", "Glances", "Syncthing", "Scrutiny", "Speedtest Tracker", "Vaultwarden", "Gitea", "UniFi", "FlareSolverr", "Dozzle", "Watchtower", "NAS (SSH)"])
	]]
];
store.config.boards = [];
for (const [name, list] of pages) {
	const b = store.addBoard(name);
	store.setTiles(b.id, list);
}
store.save();

// ---------- status ----------

// Uptime Kuma is a little slow at times, FlareSolverr had a short outage this morning.
const status = (s) => {
	const base = 3 + Math.round(rnd(s.id) * 40);
	const slow = s.name === "Uptime Kuma" && Math.floor(now() / 40000) % 3 === 0;
	const ms = Math.max(1, Math.round(base + wob(s.id, base * 0.3, 20000))) + (slow ? 1900 : 0);
	const hrs = hours(s);
	const ok = hrs.filter((b) => b.ok !== null);
	const uptime = ok.length ? Math.round((ok.reduce((a, b) => a + b.ok, 0) / ok.length) * 1000) / 10 : null;
	const c = s.container ? container(s) : null;
	return { status: slow ? "slow" : "up", ms, since: now() - (3 * DAY + rnd(s.name) * 20 * HOUR), checked: now() - 20000, recent: Array.from({ length: 30 }, (_, i) => Math.round(base + Math.sin(i / 3 + rnd(s.id) * 6) * base * 0.25)), uptime, container: c };
};
const hours = (s) =>
	Array.from({ length: 24 }, (_, i) => {
		const dip = s.name === "FlareSolverr" && i === 15 ? 0.6 : s.name === "Uptime Kuma" && i === 20 ? 0.97 : 1;
		return { ok: dip, ms: Math.round(5 + rnd(`${s.id}${i}`) * 30) };
	});
const container = (s) => {
	const mem = (80 + rnd(s.name) * 900) * 1e6;
	return { state: "running", status: `Up ${3 + Math.round(rnd(s.name) * 9)} days`, cpu: Math.max(0.1, Math.round((rnd(`${s.name}c`) * 6 + wob(s.name, 1.2, 15000)) * 10) / 10), memory: Math.round(mem + wob(s.name, mem * 0.04)) };
};

// ---------- integration data ----------

const ago = (ms) => now() - ms;
const day0 = () => {
	const d = new Date();
	d.setHours(0, 0, 0, 0);
	return d.getTime();
};
const at = (days, h, m = 0) => day0() + days * DAY + h * HOUR + m * MIN;
const TITLES = ["Dune: Part Two", "Shōgun", "The Bear", "Civil War", "Fallout", "Arcane", "Severance", "Andor", "Oppenheimer", "Slow Horses", "The Last of Us", "Poor Things", "Blue Eye Samurai", "Past Lives"];

function data(s) {
	const k = s.kind;
	if (k === "jellyfin") {
		const prog = (offset, len) => ((now() + offset) % len) / len;
		return {
			now: [
				{ user: "Alex", device: "Apple TV", title: "Severance", episode: { season: 2, number: 4, name: "Woe's Hollow" }, year: 2025, progress: prog(0, 50 * MIN), paused: false, image: "severance" },
				{ user: "Sam", device: "iPad", title: "Dune: Part Two", episode: null, year: 2024, progress: prog(20 * MIN, 166 * MIN), paused: Math.floor(now() / 60000) % 4 === 0, image: "dune-part-two" }
			],
			sessions: 4,
			recent: TITLES.slice(0, 12).map((t) => ({ id: t.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: t, type: "series", year: 2024 })),
			counts: { movies: 412, series: 86, episodes: 3270 }
		};
	}
	if (k === "sonarr")
		return {
			items: [
				{ at: at(0, 21), title: "The Bear", sub: { season: 4, number: 3, name: "Bolognese" }, has: false, src: "sonarr", ref: "series-1" },
				{ at: at(1, 3), title: "Slow Horses", sub: { season: 5, number: 2, name: "Hard Lines" }, has: false, src: "sonarr", ref: "series-2" },
				{ at: at(2, 22), title: "Andor", sub: { season: 2, number: 9, name: "Welcome to the Rebellion" }, has: false, src: "sonarr", ref: "series-3" },
				{ at: at(4, 9), title: "Shōgun", sub: { season: 2, number: 1, name: "The Return" }, has: false, src: "sonarr", ref: "series-4" }
			],
			warnings: [],
			queue: 2,
			library: 86,
			size: 2.4e12,
			free: 2.3e12,
			wanted: 14,
			imported: [{ at: ago(5 * HOUR), title: "Arcane", sub: { season: 2, number: 9, name: "The Dirt Under Your Nails" }, ref: "series-5" }]
		};
	if (k === "radarr")
		return {
			items: [
				{ at: at(1, 0), title: "Mickey 17", sub: { release: "digital", year: 2025 }, has: false, src: "radarr", ref: "movie-1" },
				{ at: at(3, 0), title: "Sinners", sub: { release: "cinema", year: 2025 }, has: false, src: "radarr", ref: "movie-2" },
				{ at: at(9, 0), title: "Superman", sub: { release: "physical", year: 2025 }, has: false, src: "radarr", ref: "movie-3" }
			],
			warnings: ["Indexer Nyaa is unavailable due to failures for more than 6 hours"],
			queue: 1,
			library: 412,
			size: 3.1e12,
			free: 2.3e12,
			wanted: 9,
			imported: [{ at: ago(26 * HOUR), title: "Civil War", sub: { year: 2024 }, ref: "movie-4" }]
		};
	if (k === "prowlarr") return { indexers: 12, enabled: 11, failing: 1, warnings: [] };
	if (k === "qbittorrent") {
		const p = (off, len) => Math.min(0.999, ((now() + off) % len) / len);
		return {
			downloading: 3,
			seeding: 18,
			down: Math.round(18e6 + wob("dl", 6e6, 8000)),
			up: Math.round(2.1e6 + wob("ul", 0.6e6, 9000)),
			torrents: [
				{ name: "Arcane.S02.2160p.WEB-DL.DDP5.1.Atmos", progress: p(0, 9 * MIN), speed: 11e6, eta: 240, state: "downloading" },
				{ name: "Past.Lives.2023.1080p.BluRay.x264", progress: p(3 * MIN, 14 * MIN), speed: 6e6, eta: 610, state: "downloading" },
				{ name: "ubuntu-24.04.2-desktop-amd64.iso", progress: 0.42, speed: 1e6, eta: 1820, state: "downloading" }
			]
		};
	}
	if (k === "solar") {
		const m = (now() - day0()) / MIN;
		const sun = (x) => Math.max(0, Math.sin(((x - 440) / (1120 - 440)) * Math.PI)) * 6200;
		const points = [];
		for (let x = 0; x <= m; x += 15) points.push([x, Math.round(sun(x) * (0.85 + rnd(`p${x}`) * 0.3))]);
		const pv = Math.round(sun(m) * (0.9 + wob("pv", 0.08, 30000)));
		return { pv, use: Math.round(520 + wob("use", 180, 20000)), battery: Math.round(64 + wob("bat", 6, 600000)), kwp: 9.8, todayWh: 21400, today: { yield: 21400, use: 13800, self: 9100, covered: 11200, feed: 12300, import: 2600 }, points };
	}
	if (k === "mystrom")
		return {
			devices: [
				{ mac: "A1", name: "Coffee machine", online: true, on: Math.floor(now() / 120000) % 2 === 0, w: Math.floor(now() / 120000) % 2 === 0 ? Math.round(1150 + wob("k", 60)) : 0.4, room: "Kitchen", todayWh: 310, onSince: ago(4 * MIN), switchable: true },
				{ mac: "A2", name: "Desk", online: true, on: true, w: Math.round(96 + wob("s", 14, 9000)), room: "Office", todayWh: 820, onSince: ago(5 * HOUR), switchable: true },
				{ mac: "A3", name: "MagicMirror", online: true, on: true, w: Math.round(46 + wob("m", 2)), room: "Bedroom", todayWh: 650, onSince: ago(13 * HOUR), switchable: true },
				{ mac: "A4", name: "Washing machine", online: false, on: false, w: null, room: "Basement", todayWh: 0, switchable: true }
			].map((d) => ({ ...d, temp: 24, kind: "switch" })),
			get watts() {
				return this.devices.reduce((a, d) => a + (d.w || 0), 0);
			},
			todayWh: 1780,
			price: 0.27
		};
	if (k === "magicmirror") return { version: "2.33.0", started: ago(6 * HOUR), modules: 13, total: 15, active: ["clock", "calendar", "weather", "compliments", "newsfeed", "MMM-SwissOverlay", "MMM-AutoDimmer"].map((n, i) => ({ name: n, position: ["top_left", "top_left", "top_right", "lower_third", "bottom_bar", "fullscreen_above", null][i] })), language: "de" };
	if (k === "mmmanager") return { process: "online", restarts: 3, up: true, version: "1.8.0" };
	const p = PLUGINS[k];
	return p ? p() : null;
}

const m = (value, label, warn) => ({ value, label, ...(warn ? { warn: true } : {}) });
const PLUGINS = {
	overseerr: () => ({ metrics: [m(3, L("Offen", "Pending")), m(12, L("Genehmigt", "Approved")), m(2, L("In Arbeit", "Processing")), m(148, L("Verfügbar", "Available"))], summary: "Version 2.7.3" }),
	bazarr: () => ({ metrics: [m(23, L("Episoden ohne Untertitel", "Episodes missing subs")), m(4, L("Filme ohne Untertitel", "Movies missing subs")), m(1, L("Anbieter gedrosselt", "Providers throttled"), true)], summary: "Bazarr 1.5.2" }),
	lidarr: () => ({ metrics: [m(214, L("Künstler", "Artists")), m(0, L("Warteschlange", "Queue")), m(37, L("Fehlend", "Missing")), m(0, L("Warnungen", "Warnings"))] }),
	plex: () => ({ metrics: [m(1, "Streams"), m(398, L("Movies", "Movies")), m(81, L("Shows", "Shows")), m(1204, L("Künstler", "Artists"))], items: [{ title: "mum · Crime Scene", sub: "Samsung TV · 37 %", status: "ok" }] }),
	tautulli: () => ({ metrics: [m(1, "Streams"), m("8.4 Mbit/s", L("Bandbreite", "Bandwidth")), m(4, L("Bibliotheken", "Libraries"))], items: [{ title: "mum · Crime Scene", sub: "Samsung TV · direct play · 37 %", status: "ok" }] }),
	sabnzbd: () => ({ metrics: [m(`${(24 + wob("sab", 5)).toFixed(1)} MB/s`, "↓"), m(2, L("Warteschlange", "Queue")), m("8.1 GB", L("Übrig", "Left")), m(L("Läuft", "Running"), L("Status", "State"))], items: [{ title: "Andor.S02E09.1080p", sub: "62 % · 3.4 GB", status: "ok" }, { title: "Past.Lives.2023.2160p", sub: "queued · 4.7 GB", status: "warn" }] }),
	homeassistant: () => ({ metrics: [m(412, L("Entitäten", "Entities")), m(5, L("Lichter an", "Lights on")), m("21.4 °C", L("Wohnzimmer", "Living room")), m("48 %", L("Luftfeuchte", "Humidity"))], items: [{ title: "Living room ceiling", sub: "on · 80 %", status: "ok" }, { title: "Kitchen spots", sub: "on", status: "ok" }, { title: "Garage motion sensor", sub: "unavailable", status: "bad" }], warnings: ["Garage motion sensor is unavailable"], summary: "Home · 2026.10.1" }),
	frigate: () => ({ metrics: [m(4, L("Kameras", "Cameras")), m((14 + wob("fr", 3)).toFixed(1), L("Erkennungen/s", "Detections/s")), m("9 ms", L("Inferenz", "Inference")), m(37, L("Ereignisse heute", "Events today"))], items: [{ title: "person · Front door", sub: "14:32", status: "ok" }, { title: "car · Einfahrt", sub: "13:05", status: "ok" }, { title: "cat · Garten", sub: "11:48", status: "ok" }], summary: "0.16.1" }),
	immich: () => ({ metrics: [m("48 210", L("Fotos", "Photos")), m("3 104", "Videos"), m("612 GB", L("Speicher", "Storage")), m(3, L("Benutzer", "Users"))], items: [{ title: "Alex", sub: "402 GB", status: "ok" }, { title: "Sam", sub: "188 GB", status: "ok" }, { title: "Family", sub: "22 GB", status: "ok" }], summary: "v2.1.0" }),
	paperless: () => ({ metrics: [m(1834, L("Dokumente", "Documents")), m(6, "Inbox"), m(0, L("Fehler heute", "Failed today"))], summary: "2.1 Mio. Zeichen" }),
	nextcloud: () => ({ metrics: [m(3, L("Aktiv (5 min)", "Active (5 min)")), m("182 004", L("Dateien", "Files")), m("1.4 TB", L("Free", "Free")), m("31.0.9", "Version", true)], warnings: ["Nextcloud update available: 32.0.1"], summary: "4 users · 2 app updates" }),
	portainer: () => ({ metrics: [m("2/2", L("Umgebungen", "Environments")), m("38/41", L("Container", "Containers")), m(3, L("Gestoppt", "Stopped")), m(0, L("Ungesund", "Unhealthy"))], items: [{ title: "homeserver", sub: "31/33", status: "ok" }, { title: "raspberry", sub: "7/8", status: "ok" }] }),
	proxmox: () => ({ metrics: [m("9/11", "VMs & LXC"), m("2/2", "Nodes"), m(`${Math.round(18 + wob("px", 6))} %`, "CPU"), m("61 %", "RAM")], items: [{ title: "VM 100 · homeassistant", sub: "pve1 · CPU 3 % · RAM 41 %", status: "ok" }, { title: "LXC 101 · pihole", sub: "pve1 · CPU 1 % · RAM 22 %", status: "ok" }, { title: "VM 102 · windows11", sub: "pve2 · stopped", status: "warn" }, { title: "LXC 103 · media", sub: "pve2 · CPU 12 % · RAM 70 %", status: "ok" }] }),
	truenas: () => ({ metrics: [m("2/2", "Pools"), m(1, L("Meldungen", "Alerts"), true), m("23 d", "Uptime"), m("25.04.2", "Version")], items: [{ title: "tank", sub: "ONLINE · 71 % used", status: "ok" }, { title: "fast", sub: "ONLINE · 38 % used", status: "ok" }] }),
	pihole: () => ({ metrics: [m(Math.round(48210 + (now() % DAY) / 9000), L("Anfragen heute", "Queries today")), m(9204, L("Blockiert", "Blocked")), m("19.1 %", L("% blockiert", "% blocked")), m(L("An", "On"), L("Blockieren", "Blocking"))], summary: "158 210 domains on the blocklist" }),
	adguard: () => ({ metrics: [m(31877, L("DNS-Anfragen", "DNS queries")), m(4120, L("Blockiert", "Blocked")), m("12.9 %", L("% blockiert", "% blocked")), m(L("An", "On"), L("Schutz", "Protection"))], items: [{ title: "app-measurement.com", sub: "812", status: "ok" }, { title: "doubleclick.net", sub: "604", status: "ok" }], summary: "v0.107.63" }),
	traefik: () => ({ metrics: [m(24, "Routers"), m(22, "Services"), m(1, L("Fehler", "Errors"), true), m("3.5.1", "Version")], items: [{ title: "grafana@docker", sub: "service \"grafana\" does not exist", status: "bad" }] }),
	nginxproxymanager: () => ({ metrics: [m(14, "Proxy Hosts"), m(1, L("Zertifikate bald ab", "Certs expiring"), true), m(1, L("Deaktiviert", "Disabled")), m(9, L("Zertifikate", "Certificates"))], items: [{ title: "cloud.example.ch", sub: "certificate expires in 9 days", status: "warn" }, { title: "photos.example.ch", sub: "→ 192.168.1.10:2283", status: "ok" }], warnings: ["Certificate cloud.example.ch expires in 9 days"] }),
	wgeasy: () => ({ metrics: [m(6, L("Clients", "Clients")), m(2, L("Verbunden", "Connected")), m("41.2 GB", L("Verkehr", "Traffic"))], items: [{ title: "iPhone Alex", sub: "10.8.0.2 · ↓ 2.1 GB ↑ 310 MB", status: "ok" }, { title: "Laptop", sub: "10.8.0.3 · ↓ 12 GB ↑ 1.2 GB", status: "ok" }, { title: "iPad Sam", sub: "10.8.0.4", status: "warn" }], summary: "iPhone Alex, Laptop" }),
	uptimekuma: () => ({ metrics: [m(18, "Monitors"), m(1, L("Ausgefallen", "Down"), true), m("142 ms", L("Ø Antwort", "Avg response")), m("99.6 %", "Uptime")], items: [{ title: "Website", sub: "212 ms", status: "ok" }, { title: "Backup-Server", sub: "down · timeout", status: "bad" }, { title: "Mail", sub: "88 ms", status: "ok" }], warnings: ["Backup-Server is down"] }),
	grafana: () => ({ metrics: [m(14, "Dashboards"), m(0, L("Alarme", "Firing alerts")), m("13.2.4", "Version"), m("ok", L("Datenbank", "Database"))] }),
	prometheus: () => ({ metrics: [m(7, L("Ziele", "Targets")), m(0, L("ausgefallen", "down")), m(4, "Jobs")], items: [{ title: "node", sub: "192.168.1.10:9100", status: "ok" }, { title: "raspberry", sub: "192.168.1.20:9100", status: "ok" }, { title: "cadvisor", sub: "192.168.1.10:8081", status: "ok" }] }),
	glances: () => ({ metrics: [m(`${Math.round(12 + wob("gl", 5, 12000))} %`, "CPU"), m("47 %", "RAM"), m("0.84", "Load"), m("71 %", L("Volle Disk", "Fullest disk"))], items: [{ title: "/", sub: "41 %", status: "ok" }, { title: "/mnt/media", sub: "71 %", status: "ok" }, { title: "/mnt/backup", sub: "88 %", status: "warn" }] }),
	syncthing: () => ({ metrics: [m(5, L("Ordner", "Folders")), m("2/3", L("Geräte", "Devices")), m("100 %", "Sync"), m(0, L("Fehler", "Errors"))], items: [{ title: "Fotos", sub: "idle · 3 devices", status: "ok" }, { title: "Dokumente", sub: "idle · 2 devices", status: "ok" }] }),
	scrutiny: () => ({ metrics: [m(6, L("Disks", "Disks")), m(0, L("Defekt", "Failed")), m("41 °C", L("Max. Temperatur", "Max temperature"))], items: [{ title: "/dev/sda", sub: "Samsung 870 EVO · 34 °C · 21'400 h", status: "ok" }, { title: "/dev/sdb", sub: "WDC WD80EFZZ · 41 °C · 31'020 h", status: "ok" }] }),
	speedtest: () => ({ metrics: [m("912", "↓ Mbit/s"), m("483", "↑ Mbit/s"), m("6 ms", "Ping"), m("18 min", L("Letzter Test", "Last test"))] }),
	vaultwarden: () => ({ metrics: [m(L("Ja", "Yes"), L("Erreichbar", "Up")), m("4 ms", L("Antwort", "Response")), m("1.34.3", "Version")] }),
	gitea: () => ({ metrics: [m(37, L("Repositories", "Repositories")), m(2, L("Ungelesen", "Unread")), m(1, "Pull Requests")], items: [{ title: "homelab/ansible #12", sub: "Update docker role", status: "ok" }], summary: "1.24.6" }),
	// Watchtower updates containers on its own schedule (here: every night at 4:00)
	watchtower: () => ({ metrics: [m(38, L("Geprüft", "Scanned")), m(2, L("Aktualisiert", "Updated")), m(0, L("Fehlgeschlagen", "Failed"))], items: [{ title: "dozzle", sub: "amir20/dozzle:latest · updated 04:00", status: "ok" }, { title: "flaresolverr", sub: "ghcr.io/flaresolverr/flaresolverr:latest · updated 04:00", status: "ok" }], summary: "Last scan today 04:00 · next 04:00" }),
	evcc: () => ({ metrics: [m(`${(5.2 + wob("ev", 0.6)).toFixed(1)} kW`, "PV"), m(`${(0.6 + wob("eh", 0.2)).toFixed(1)} kW`, L("Haus", "Home")), m(`${(2.1 + wob("eg", 0.4)).toFixed(1)} kW`, L("Einspeisung", "Export")), m("68 %", L("Batterie", "Battery"))], items: [{ title: "Garage", sub: "Tesla Model 3 · 61 % · 7.4 kW · solar", status: "ok" }] }),
	opendtu: () => ({ metrics: [m(`${Math.round(1840 + wob("od", 120))} W`, L("Leistung", "Power")), m("9.6 kWh", L("Today", "Today")), m("3.2 MWh", L("Total", "Total")), m("2/2", L("Wechselrichter", "Inverters"))], items: [{ title: "HMS-1600 South", sub: "1'120 W · 100 %", status: "ok" }, { title: "HM-800 West", sub: "720 W · 100 %", status: "ok" }] }),
	unifi: () => ({ metrics: [m(43, "Clients"), m(6, L("Geräte", "Devices")), m(0, L("Meldungen", "Alerts")), m(31, "WLAN")], items: [{ title: "wan", sub: "ok", status: "ok" }, { title: "wlan", sub: "ok · 31 clients", status: "ok" }, { title: "lan", sub: "ok · 12 clients", status: "ok" }], summary: "WAN 203.0.113.24" })
};

// ---------- host, containers, events, tailscale, releases ----------

const host = () => ({ name: "homeserver", cpu: Math.round(9 + wob("cpu", 5, 12000)), cores: 8, memUsed: 11.8e9 + wob("mem", 0.4e9), memTotal: 32e9, diskUsed: 1.21e12, diskTotal: 2e12, temp: 47, uptime: 12 * DAY + 5 * HOUR, load: 0.8, net: { rx: 2.1e6 + wob("rx", 1.2e6, 10000), tx: 0.34e6 + wob("tx", 0.2e6, 11000) } });
const hostHistory = () => {
	const out = [];
	for (let t = now() - DAY; t <= now(); t += MIN) {
		const x = t / HOUR;
		const evening = Math.max(0, Math.sin(((t % DAY) / DAY) * Math.PI * 2 - 1.2));
		out.push([t, Math.round(8 + Math.sin(x) * 4 + rnd(t) * 6 + evening * 20), Math.round(36 + Math.sin(x / 5) * 3), 61, Math.round((0.6 + evening * 5 + rnd(`r${t}`) * 1.5) * 1e6), Math.round((0.15 + evening * 0.6 + rnd(`t${t}`) * 0.3) * 1e6), 45 + Math.round(evening * 8), 0.6 + evening]);
	}
	return out;
};
const containers = () => {
	const list = store.config.services.filter((s) => s.container);
	const top = list.map((s) => ({ name: s.container, ...container(s) })).sort((a, b) => b.memory - a.memory);
	return { running: list.length + 3, stopped: 2, stoppedNames: ["windows-backup", "old-nextcloud"], top: top.slice(0, 8) };
};
const EVENTS = [
	[ago(40 * MIN), "Uptime Kuma", "slow", null],
	[ago(39 * MIN), "Uptime Kuma", "up", null],
	[ago(5 * HOUR), "FlareSolverr", "down", "Connection refused"],
	[ago(5 * HOUR - 6 * MIN), "FlareSolverr", "action", "Restarted"],
	[ago(5 * HOUR - 5 * MIN), "FlareSolverr", "up", null],
	[ago(26 * HOUR), "qBittorrent", "action", "Updated"]
];
const events = () => EVENTS.map(([t, name, to, detail]) => ({ t, sid: sid[name], name, to, detail }));
const tailscale = () => {
	const dns = "homeserver.tail1234.ts.net";
	const share = ["Jellyfin", "Immich", "Home Assistant"];
	const links = Object.fromEntries(share.map((n) => [sid[n], `https://${dns}:${store.config.services.find((s) => s.id === sid[n]).url.split(":").pop()}`]));
	const local = Object.fromEntries(store.config.services.filter((s) => s.url.includes("192.168.1.10")).map((s) => [s.id, true]));
	const mappings = share.map((n) => {
		const url = links[sid[n]];
		return { host: dns, port: Number(url.split(":").pop()), path: "/", proxy: `http://127.0.0.1:${url.split(":").pop()}`, url, funnel: false };
	});
	mappings.unshift({ host: dns, port: 443, path: "/", proxy: "http://127.0.0.1:8095", url: `https://${dns}`, funnel: false });
	return { available: true, running: true, dnsName: dns, tailnet: "demo", https: true, mappings, links, local, self: { port: 8095, url: `https://${dns}` } };
};
const RELEASES = {
	"jjoeojieajfhpdsonf/HomeBento": ["v0.13.0", 1 * DAY, null, null],
	"jellyfin/jellyfin": ["v10.11.2", 3 * DAY, "Jellyfin", "10.11.2"],
	"Sonarr/Sonarr": ["v4.0.16.2944", 6 * DAY, "Sonarr", "4.0.15.2941"],
	"Radarr/Radarr": ["v6.0.4.10291", 9 * DAY, "Radarr", "6.0.4.10291"],
	"qbittorrent/qBittorrent": ["release-5.2.4", 2 * DAY, "qBittorrent", "5.2.2"],
	"home-assistant/core": ["2026.10.2", 4 * DAY, "Home Assistant", "2026.10.1"],
	"immich-app/immich": ["v2.1.0", 12 * DAY, "Immich", "2.1.0"],
	"nextcloud/server": ["v32.0.1", 5 * DAY, "Nextcloud", "31.0.9"],
	"louislam/uptime-kuma": ["2.0.2", 20 * DAY, "Uptime Kuma", "2.0.2"]
};
const releases = (repos) =>
	Object.fromEntries(
		repos.map((repo) => {
			const r = RELEASES[repo];
			if (!r) return [repo, { repo, error: "Repository not found" }];
			const [tag, age, svc, running] = r;
			const latest = { tag, name: tag, date: now() - age, url: `https://github.com/${repo}/releases/tag/${tag}`, prerelease: false };
			const out = { repo, latest, recent: [latest] };
			if (svc) {
				out.service = sid[svc];
				out.running = running;
				out.current = running.replace(/^v/, "") === tag.replace(/^(v|release-)/, "");
			}
			return [repo, out];
		})
	);

// ---------- general tiles ----------

async function weatherFor(p) {
	try {
		const w = await widgets.weather(p.lat, p.lon);
		if (w && w.now) return { place: p, ...w };
	} catch {
		// offline: made-up weather below
	}
	const h0 = Math.floor(now() / HOUR) * HOUR;
	return {
		place: p,
		now: { temp: 14.2, feels: 12.8, humidity: 64, wind: 9, code: 2, day: true, rain: 0 },
		hours: Array.from({ length: 24 }, (_, i) => ({ t: h0 + i * HOUR, temp: 14 + Math.sin(i / 4) * 4, rain: i > 6 && i < 10 ? 60 : 5, code: i > 6 && i < 10 ? 61 : 2, day: ((new Date(h0 + i * HOUR).getHours() + 18) % 24) < 12 })),
		days: Array.from({ length: 6 }, (_, i) => ({ date: new Date(day0() + i * DAY).toISOString().slice(0, 10), code: [2, 61, 3, 0, 1, 80][i], max: [17, 13, 15, 19, 21, 16][i], min: [8, 7, 6, 7, 9, 10][i], rain: [10, 80, 20, 0, 5, 55][i], sunrise: `${new Date(day0() + i * DAY).toISOString().slice(0, 10)}T07:41`, sunset: `${new Date(day0() + i * DAY).toISOString().slice(0, 10)}T18:32` }))
	};
}
const disks = () => [
	{ mount: "/", device: "nvme0n1p2", type: "ext4", total: 500e9, used: 204e9 },
	{ mount: "/mnt/media", device: "sdb1", type: "xfs", total: 8e12, used: 5.7e12 },
	{ mount: "/mnt/backup", device: "sdc1", type: "ext4", total: 4e12, used: 3.66e12 },
	{ mount: "/boot", device: "nvme0n1p1", type: "vfat", total: 1e9, used: 0.12e9 }
];
const ical = () => ({
	events: [
		{ t: at(0, 18, 30), end: at(0, 19, 30), allDay: false, title: "Volleyball", where: "Letzi gym", cal: 0 },
		{ t: at(1, 0), end: at(2, 0), allDay: true, title: "Bin day: cardboard", where: "", cal: 0 },
		{ t: at(1, 9), end: at(1, 10), allDay: false, title: "Daily", where: "Teams", cal: 1 },
		{ t: at(1, 14), end: at(1, 15, 30), allDay: false, title: "Review release 0.13", where: "Meeting room 2", cal: 1 },
		{ t: at(2, 19), end: at(2, 22), allDay: false, title: "Mia's birthday", where: "Rosengarten restaurant", cal: 0 },
		{ t: at(4, 10), end: at(4, 11), allDay: false, title: "Dentist", where: "", cal: 0 },
		{ t: at(6, 0), end: at(7, 0), allDay: true, title: "Hike on the Rigi", where: "", cal: 0 }
	],
	errors: []
});
const rss = () => ({
	items: [
		["Jellyfin 10.11 brings faster library scans", "Tech-Feed", 35 * MIN],
		["City council approves a new bike path along the river", "Local", 2 * HOUR],
		["Home Assistant: what the October update changes for energy dashboards", "Tech-Feed", 3 * HOUR],
		["Farmers' market moves indoors for the winter", "Local", 5 * HOUR],
		["Why self-hosting is getting popular again", "Tech-Feed", 8 * HOUR],
		["Strong föhn winds expected this weekend", "Local", 11 * HOUR],
		["New Raspberry Pi generation: first tests", "Tech-Feed", 22 * HOUR]
	].map(([title, source, age], i) => ({ title, link: "https://example.com/", date: now() - age, source, feed: source === "Local" ? 1 : 0, i })),
	errors: []
});

// ---------- own API tiles, markets ----------

function apiDemo(t) {
	const v = (label, text, state) => ({ label, text, state: state || null });
	if (t.title === "Aare") return { values: [v("Water", `${(14.2 + wob("aare", 0.2, 600000)).toFixed(1)} °C`), v("Flow", "112 m³/s"), v("Air", "12 °C")], items: [{ title: "Bern, Schönau", sub: "“a bit chilly”", status: "ok" }], at: now() };
	if (t.title === "Speedtest") return { values: [v("↓ Mbit/s", "912"), v("↑ Mbit/s", "483"), v("Ping", "6 ms")], items: [], at: now() };
	if (t.title === "Internet") return { values: [v("Public IP", "203.0.113.24"), v("City", "Zürich"), v("Provider", "Init7")], items: [], at: now() };
	if (t.title === "Server power") return { values: [v("Now", `${Math.round(58 + wob("srv", 6, 20000))} W`), v("Today", "1.2 kWh"), v("Per month", "11.20 CHF")], items: [], at: now() };
	if (t.title === "Backup") return { values: [v("Last", "vor 6 h"), v("Size", "412 GB"), v("Took", "38 min")], items: [], at: now() };
	return { values: [v("Plays (7 days)", "84"), v("Hours", "61"), v("Top", "Alex")], items: [], at: now() };
}
function marketsDemo(t) {
	const q = (symbol, name, price, cur, pct) => {
		const p = price * (1 + wob(symbol, 0.004, 40000));
		return { symbol, name, price: Math.round(p * 100) / 100, currency: cur, change: (p * pct) / 100, changePct: Math.round((pct + wob(`${symbol}c`, 0.3, 40000)) * 100) / 100, marketState: "REGULAR", spark: Array.from({ length: 16 }, (_, i) => p * (1 + Math.sin(i / 2.5 + rnd(symbol) * 5) * 0.004 + (i * pct) / 1600)) };
	};
	const all = { "^GSPC": q("^GSPC", "S&P 500", 6684, "USD", 0.42), NVDA: q("NVDA", "Nvidia", 183.2, "USD", -0.8), AAPL: q("AAPL", "Apple", 231.4, "USD", 1.2) };
	return {
		quotes: (t.symbols || []).map((sym) => all[sym] || q(sym, sym, 100, "CHF", 0.1)),
		fx: (t.fx || []).map((c) => ({ pair: `CHF/${c}`, rate: c === "EUR" ? 1.0712 : c === "USD" ? 1.2468 : 1, changePct: c === "EUR" ? 0.12 : -0.31 })),
		crypto: (t.crypto || []).map((id) => ({ id, price: Math.round(84210 + wob(id, 600, 30000)), changePct: 2.4 }))
	};
}

// a camera picture that changes: an entrance with the time on it
function cameraDemo() {
	const time = new Date().toLocaleTimeString("de-CH");
	const date = new Date().toLocaleDateString("de-CH");
	const leaf = Math.round(wob("leaf", 8, 4000));
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3b4a5c"/><stop offset="1" stop-color="#1d242c"/></linearGradient><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a4d48"/><stop offset="1" stop-color="#2a2c29"/></linearGradient></defs><rect width="640" height="360" fill="url(#s)"/><rect y="230" width="640" height="130" fill="url(#g)"/><rect x="250" y="90" width="140" height="160" rx="4" fill="#5b4636"/><rect x="262" y="104" width="116" height="146" fill="#6d5442"/><circle cx="364" cy="180" r="5" fill="#c9b37a"/><rect x="60" y="120" width="120" height="80" fill="#2c3e50" stroke="#566" stroke-width="4"/><rect x="460" y="120" width="120" height="80" fill="#2c3e50" stroke="#566" stroke-width="4"/><path d="M250 250 L200 360 L440 360 L390 250Z" fill="#6b6b66"/><g transform="translate(${560 + leaf} 210)"><circle r="34" fill="#2f5a3a"/><circle cx="-22" cy="12" r="26" fill="#2a5235"/></g><rect x="12" y="12" width="210" height="26" rx="4" fill="rgba(0,0,0,.45)"/><text x="22" y="30" font-family="monospace" font-size="15" fill="#e8e8e8">${date} ${time}</text><text x="560" y="345" font-family="monospace" font-size="13" fill="rgba(255,255,255,.6)">CAM 1</text></svg>`;
}

// ---------- messages (kept in memory) ----------

const alertsCfg = {
	channels: [
		{ id: "a1b2c3d4e5", type: "telegram", name: "Alex", enabled: true, fields: { chatId: "123456789" }, events: { down: true, up: true, warn: true, resources: true }, secrets: { token: true }, error: null },
		{ id: "f6a7b8c9d0", type: "ntfy", name: "Family", enabled: true, fields: { url: "https://ntfy.sh/homebento-demo" }, events: { down: true, up: false, warn: false, resources: false }, secrets: {}, error: null }
	],
	delay: 2,
	limits: { disk: 90, temp: 80, memory: 95, certDays: 14 },
	mutedUntil: null,
	lang: "en"
};
const alertsView = () => ({ ...alertsCfg, env: false, types: notify.CHANNELS, active: [{ key: "disk:/mnt/backup", kind: "disk", name: "/mnt/backup", value: 92, since: now() - 3 * HOUR }] });

// ---------- HTTP ----------

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });
const svc = (id) => store.service(id);

route("GET", "/api/state", () => ({
	tailscale: tailscale(),
	version: `${require("../package.json").version} · Demo`,
	config: store.public(),
	kinds: Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { label: v.label, tile: v.tile, fields: v.fields.map(({ key, label, help, secret }) => ({ key, label, help, secret: !!secret })) }])),
	docker: true,
	host: "homeserver",
	auth: false,
	notify: true,
	checkSeconds: 60,
	selfHosts: ["192.168.1.10", "localhost", "127.0.0.1"],
	cantons: holidays.CANTONS
}));

route("GET", "/api/live", async (body, p, query) => {
	const cfg = store.config;
	const board = cfg.boards.find((b) => b.id === query.get("board")) || cfg.boards[0];
	const types = new Set(board.tiles.map((t) => t.type));
	const st = {};
	const d = {};
	const hrs = {};
	for (const s of cfg.services) {
		st[s.id] = status(s);
		hrs[s.id] = hours(s);
		if (s.kind) {
			const x = data(s);
			if (x) d[s.id] = { data: x };
		}
	}
	const out = { at: now(), status: st, data: d, hours: hrs, host: host(), containers: types.has("docker") ? containers() : null, events: types.has("events") ? events() : null, tailscale: types.has("tailscale") ? tailscale() : null, releases: null };
	const repos = [...new Set(board.tiles.filter((t) => t.type === "releases").flatMap((t) => t.repos || []))];
	if (repos.length) out.releases = releases(repos);
	if (types.has("weather")) {
		out.weather = {};
		for (const t of board.tiles.filter((x) => x.type === "weather")) {
			const place = t.place || cfg.location;
			out.weather[t.id] = place ? await weatherFor(place) : { error: "no-place" };
		}
	}
	if (types.has("disks")) out.disks = disks();
	out.alerts = [{ key: "disk:/mnt/backup", kind: "disk", name: "/mnt/backup", value: 92, since: now() - 3 * HOUR, sid: null }];
	if (types.has("api")) out.api = Object.fromEntries(board.tiles.filter((t) => t.type === "api").map((t) => [t.id, apiDemo(t)]));
	if (types.has("markets")) out.markets = Object.fromEntries(board.tiles.filter((t) => t.type === "markets").map((t) => [t.id, marketsDemo(t)]));
	if (types.has("holidays")) out.holidays = Object.fromEntries(board.tiles.filter((t) => t.type === "holidays").map((t) => [t.id, holidays.next(t.canton || "ZH", new Date(), 8)]));
	if (types.has("network")) out.net = hostHistory().slice(-180).map((x) => [x[0], x[4], x[5]]);
	if (types.has("ical")) out.ical = Object.fromEntries(board.tiles.filter((t) => t.type === "ical" && (t.calendars || []).length).map((t) => [t.id, ical()]));
	if (types.has("rss")) out.rss = Object.fromEntries(board.tiles.filter((t) => t.type === "rss" && (t.feeds || []).length).map((t) => [t.id, rss()]));
	return out;
});

route("GET", "/api/services/:id", (body, p) => {
	const s = svc(p.id);
	return {
		status: status(s),
		hours: hours(s),
		days: Array.from({ length: 30 }, (_, i) => (s.name === "FlareSolverr" && i === 29 ? 0.97 : i === 12 && s.name === "Uptime Kuma" ? 0.99 : 1)),
		uptime: { day: 100, week: 99.9, month: s.name === "FlareSolverr" ? 99.8 : 100 },
		events: events().filter((e) => e.sid === s.id),
		container: s.container ? { ...container(s), image: `lscr.io/linuxserver/${s.container}:latest` } : null,
		release: releaseOf(s)
	};
});
route("GET", "/api/services/:id/logs", (body, p) => {
	const s = svc(p.id);
	const lines = [];
	for (let i = 40; i > 0; i--) {
		const t = new Date(now() - i * 47000).toISOString();
		const lvl = i % 13 === 0 ? "WARN" : i % 29 === 0 ? "ERROR" : "INFO";
		lines.push(`${t} [${lvl}] ${s.name}: ${lvl === "INFO" ? ["Checking for updates", "Request completed in 12 ms", "Scheduled task finished", "Health check ok"][i % 4] : lvl === "WARN" ? "Slow response from upstream (1.8 s)" : "Connection reset by peer, retrying"}`);
	}
	return { text: lines.join("\n") };
});
route("POST", "/api/services/:id/check", (body, p) => {
	const s = svc(p.id);
	return { ...status(s), data: s.kind ? { data: data(s) } : null };
});
route("POST", "/api/services/:id/action", (body, p) => {
	const s = svc(p.id);
	if (body.what === "recheck") return { ok: true, indexers: 5, valid: 5 };
	EVENTS.unshift([now(), s.name, "action", body.what === "relay" ? "Switched" : "Restarted"]);
	return { container: { state: "running", status: "Up 1 second" } };
});
// The update of a container, played through: pull, swap, check, done (takes about 12 seconds).
const jobs = new Map();
function releaseOf(s) {
	const e = Object.entries(RELEASES).find(([, r]) => r[2] === s.name);
	if (!e) return undefined;
	const [repo, [tag, age, , running]] = e;
	return { repo, latest: { tag, name: tag, date: now() - age, url: `https://github.com/${repo}/releases/tag/${tag}` }, running, current: running.replace(/^v/, "") === tag.replace(/^(v|release-)/, "") };
}
route("POST", "/api/services/:id/update", (body, p) => {
	const s = svc(p.id);
	const rel = releaseOf(s);
	const image = `lscr.io/linuxserver/${s.container}:latest`;
	const steps = [
		[0, `Pulling ${image} …`],
		[2500, "Downloaded newer image (sha256:4f1c…a92e, 143 MB)"],
		[3500, `Renaming the running container to ${s.container}-old`],
		[4500, "Creating the new container with the same volumes, ports, networks and environment"],
		[6000, "Stopping the old container …"],
		[7000, "Starting the new container …"],
		[8500, "Waiting until the service answers …"],
		[11000, `${s.name} answers (HTTP 200 in 31 ms)`],
		[11500, `Removing the old container ${s.container}-old`]
	];
	const job = { id: Date.now().toString(36), sid: s.id, name: s.name, started: now(), steps, rel };
	jobs.set(job.id, job);
	return { job: job.id };
});
route("GET", "/api/updates/:id", (body, p) => {
	const j = jobs.get(p.id);
	if (!j) throw new UserError("Unknown update");
	const dt = now() - j.started;
	const log = j.steps.filter(([at]) => at <= dt).map(([at, line]) => `${new Date(j.started + at).toLocaleTimeString("de-CH")} ${line}`);
	const done = dt > 12000;
	// which step runs, and how far the download is (143 MB in 9 layers over 2.5 s)
	const step = dt < 2500 ? "pull" : dt < 6000 ? "swap" : dt < 8500 ? "start" : dt < 11500 ? "check" : "clean";
	const f = Math.min(1, dt / 2500);
	const progress = { layers: 9, done: Math.floor(f * 9), current: Math.round(f * 143e6), total: 143e6 };
	if (done && j.rel && !j.applied) {
		// from now on it runs the new version
		const r = RELEASES[j.rel.repo];
		r[3] = r[0].replace(/^(v|release-)/, "");
		j.applied = true;
		EVENTS.unshift([now(), j.name, "action", "Updated"]);
	}
	return { id: j.id, sid: j.sid, name: j.name, state: done ? "done" : "running", step, progress, log, updated: done, started: j.started };
});
route("POST", "/api/services/:id/tailscale", () => tailscale());
route("POST", "/api/tailscale/remove", () => tailscale());
route("POST", "/api/tailscale/self", () => tailscale());
route("POST", "/api/services", (body) => ({ service: store.public().services.find((x) => x.id === store.saveService(body).id) }));
route("POST", "/api/services/:id", (body, p) => ({ service: store.public().services.find((x) => x.id === store.saveService(body, p.id).id) }));
route("POST", "/api/services/:id/delete", (body, p) => store.removeService(p.id));
route("POST", "/api/test", () => ({ ok: true, detail: "HTTP 200 · 4 ms (demo)" }));
route("POST", "/api/boards", (body) => ({ board: store.addBoard(body.name) }));
route("POST", "/api/boards/order", (body) => store.orderBoards(body.ids));
route("POST", "/api/boards/:id", (body, p) => store.renameBoard(p.id, body.name));
route("POST", "/api/boards/:id/delete", (body, p) => store.removeBoard(p.id));
route("POST", "/api/boards/:id/tiles", (body, p) => ({ board: store.setTiles(p.id, body.tiles) }));
route("POST", "/api/settings", (body) => {
	if (body.location !== undefined) store.setLocation(body.location);
	if (body.title !== undefined) store.setTitle(body.title);
	if (body.width !== undefined) store.setWidth(body.width);
	if (body.theme !== undefined) store.setTheme(body.theme);
	if (body.columns !== undefined) store.setColumns(body.columns);
});
route("GET", "/api/alerts", () => alertsView());
route("POST", "/api/alerts", (body) => {
	if (Array.isArray(body.channels)) alertsCfg.channels = body.channels.map((c) => ({ ...c, secrets: { ...((alertsCfg.channels.find((x) => x.id === c.id) || {}).secrets || {}), ...Object.fromEntries(Object.keys((body.secrets || {})[c.id] || {}).filter((k) => body.secrets[c.id][k]).map((k) => [k, true])) }, error: null }));
	for (const k of ["delay", "limits", "lang"]) if (body[k] !== undefined) alertsCfg[k] = body[k];
	if (body.mutedUntil !== undefined) alertsCfg.mutedUntil = body.mutedUntil > now() ? body.mutedUntil : null;
	return alertsView();
});
route("POST", "/api/alerts/test", () => ({ ok: true }));
route("POST", "/api/services/:id/mute", (body, p) => {
	const s = store.muteService(p.id, body.minutes ? now() + Number(body.minutes) * MIN : null);
	return { mutedUntil: s.mutedUntil || null };
});
route("GET", "/api/tiles/:id/secrets", () => ({ secrets: {} }));
route("POST", "/api/tiles/:id/secrets", () => ({ secrets: {} }));
route("POST", "/api/api-preview", () => ({ status: 200, ms: 42, json: { aare: { temperature: 14.2, flow: 112, location: "Bern" }, weather: { current: { tt: 12 } } }, paths: [{ path: "aare", sample: "{3}", type: "object" }, { path: "aare.temperature", sample: "14.2", type: "number" }, { path: "aare.flow", sample: "112", type: "number" }, { path: "aare.location", sample: "Bern", type: "string" }, { path: "weather.current.tt", sample: "12", type: "number" }] }));
route("GET", "/api/config/export", () => store.exportConfig(false));
route("POST", "/api/config/import", () => {
	throw new UserError("Not in the demo");
});
route("GET", "/api/backups", () => ({ items: [0, 1, 2].map((i) => ({ name: `config-${new Date(now() - i * DAY).toISOString().slice(0, 10)}-04-00-daily.json`, size: 18000 })) }));
route("POST", "/api/backups", () => ({ name: "demo" }));
route("POST", "/api/backups/:name/restore", () => {
	throw new UserError("Not in the demo");
});
route("POST", "/api/import", (body) => {
	if (body.apply) throw new UserError("Not in the demo – the preview works though");
	const r = importers.importConfig(String(body.text || ""), String(body.filename || ""));
	return { source: r.source, groups: r.groups.map((g) => ({ name: g.name, services: g.services.map((x) => ({ ...x, secrets: Object.fromEntries(Object.keys(x.secrets || {}).map((k) => [k, true])) })) })), links: r.links, warnings: r.warnings };
});

route("GET", "/api/geocode", async (body, p, query) => {
	try {
		return { items: await widgets.geocode(String(query.get("q") || "").slice(0, 80), query.get("lang") === "en" ? "en" : "de") };
	} catch {
		return { items: [{ name: "Zürich", region: "Zürich, CH", lat: 47.3769, lon: 8.5417 }, { name: "Bern", region: "Bern, CH", lat: 46.948, lon: 7.4474 }] };
	}
});
route("GET", "/api/host/history", () => ({ points: hostHistory() }));
route("GET", "/api/disks", () => ({ items: disks() }));
route("GET", "/api/containers", () => ({ items: store.config.services.filter((s) => s.container).map((s) => ({ name: s.container, image: `lscr.io/linuxserver/${s.container}:latest`, state: "running" })) }));
route("GET", "/api/discover", () => ({ items: [{ name: "Audiobookshelf", url: "http://192.168.1.10:13378", icon: "audiobookshelf", image: "ghcr.io/advplyr/audiobookshelf", state: "running", container: "audiobookshelf" }, { name: "Mealie", url: "http://192.168.1.10:9925", icon: "mealie", image: "ghcr.io/mealie-recipes/mealie", state: "running", container: "mealie" }] }));
route("GET", "/api/releases/suggest", () => ({ items: Object.entries(RELEASES).filter(([, r]) => r[2]).map(([repo, r]) => ({ service: sid[r[2]], repo })) }));
route("GET", "/api/releases/check", (body, p, query) => ({ repo: query.get("repo"), ...(releases([query.get("repo")])[query.get("repo")] || {}) }));
route("GET", "/api/releases/notes", (body, p, query) => ({ repo: query.get("repo"), tag: query.get("tag"), name: query.get("tag"), date: now() - DAY, url: "https://github.com", body: "## What's new\n\n- Faster library scans\n- Fixed a crash when a subtitle file is empty\n- Updated translations\n\n**Full changelog** on GitHub." }));
route("GET", "/api/media/:id/:ref", (body, p) => ({ title: decodeURIComponent(p.ref).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()), year: 2024, overview: "A demo description: HomeBento shows the plot, genres, rating and links to open it in Jellyfin, Sonarr or Radarr here.", genres: ["Drama", "Science-Fiction"], rating: 8.4, certification: "12", runtime: 54, type: "series", seasons: 2, links: [{ kind: "jellyfin", name: "Jellyfin", url: "http://192.168.1.10:8096" }] }));

// posters: a calm gradient per title
function poster(ref) {
	const hue = Math.round(rnd(ref) * 360);
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 300"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 52%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 40% 22%)"/></linearGradient></defs><rect width="200" height="300" fill="url(#g)"/><circle cx="${60 + rnd(ref + "x") * 80}" cy="${70 + rnd(ref + "y") * 60}" r="${30 + rnd(ref + "r") * 40}" fill="rgba(255,255,255,.12)"/></svg>`;
}

const server = http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://demo");
	if (url.pathname.startsWith("/api/camera/")) {
		res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
		return res.end(cameraDemo());
	}
	if (url.pathname.startsWith("/api/img/")) {
		res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "max-age=3600" });
		return res.end(poster(url.pathname));
	}
	if (url.pathname.startsWith("/api/")) {
		const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
		let body = {};
		if (req.method === "POST") {
			const chunks = [];
			for await (const c of req) chunks.push(c);
			try {
				body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
			} catch {
				body = {};
			}
		}
		try {
			const out = r ? await r.handler(body, url.pathname.match(r.re).groups || {}, url.searchParams) : {};
			res.writeHead(200, { "Content-Type": "application/json" });
			return res.end(JSON.stringify(out === undefined ? {} : out));
		} catch (err) {
			res.writeHead(err instanceof UserError ? 400 : 500, { "Content-Type": "application/json" });
			return res.end(JSON.stringify({ error: err.message }));
		}
	}
	// the example page for the "web page" tile
	if (url.pathname === "/demo-panel.html") {
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
		return res.end(fs.readFileSync(path.join(__dirname, "panel.html")));
	}
	const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
	const file = path.join(PUBLIC, rel);
	if (!file.startsWith(PUBLIC + path.sep)) return res.writeHead(404).end();
	fs.readFile(file, (err, buf) => {
		if (err) return res.writeHead(404).end("Not found");
		res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
		res.end(buf);
	});
});
server.listen(PORT, () => console.log(`HomeBento demo on http://localhost:${PORT}`));
process.on("SIGINT", () => {
	fs.rmSync(DIR, { recursive: true, force: true });
	process.exit(0);
});
