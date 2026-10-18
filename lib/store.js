"use strict";
// Configuration (services, boards, tiles) in data/config.json, logins in data/secrets.json.
// Secrets never leave the server: the web app only learns whether one is set.
const path = require("node:path");
const { readJSON, writeJSON, id } = require("./util");
const { UserError } = require("./errors");
const { KINDS } = require("./kinds");

const TILE_TYPES = ["service", "status", "host", "uptime", "jellyfin", "recent", "calendar", "downloads", "solar", "links", "notes", "docker", "events", "tailscale", "releases", "mystrom", "energy", "mirror", "weather", "clock", "disks", "network", "ical", "rss", "iframe", "api", "markets", "holidays", "countdown", "camera", "arr"];
const CHECK_TYPES = ["http", "keyword", "tcp", "ping", "dns"];
const CHANNEL_TYPES = ["ntfy", "gotify", "telegram", "pushover", "discord", "slack", "webhook", "email"];
const str = (v, n) => String(v ?? "").trim().slice(0, n);
const httpUrl = (u) => (/^https?:\/\/[^\s]+$/i.test(String(u || "").trim()) ? String(u).trim().slice(0, 1000) : "");
const num = (v, min, max, def) => (Number.isFinite(+v) && v !== "" && v !== null ? Math.min(max, Math.max(min, +v)) : def);
const SIZES = [[1, 1], [2, 1], [1, 2], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3]];

function defaults() {
	return {
		version: 1,
		title: "",
		services: [],
		boards: [
			{
				id: id(),
				name: "",
				tiles: [
					{ id: id(), type: "status", w: 2, h: 1 },
					{ id: id(), type: "host", w: 2, h: 2 },
					{ id: id(), type: "uptime", w: 2, h: 2 }
				]
			}
		]
	};
}

class Store {
	constructor(dir) {
		this.file = path.join(dir, "config.json");
		this.secretsFile = path.join(dir, "secrets.json");
		this.config = readJSON(this.file, null) || defaults();
		this.secrets = readJSON(this.secretsFile, {});
		if (!this.config.boards.length) this.config.boards = defaults().boards;
	}

	save() {
		writeJSON(this.file, this.config);
	}

	service(sid) {
		const s = this.config.services.find((x) => x.id === sid);
		if (!s) throw new UserError("Service not found");
		return s;
	}

	board(bid) {
		const b = this.config.boards.find((x) => x.id === bid);
		if (!b) throw new UserError("Board not found");
		return b;
	}

	// Config for the web app: secrets replaced by "is set" flags.
	public() {
		return {
			...this.config,
			services: this.config.services.map((s) => ({ ...s, secrets: Object.fromEntries(Object.keys(this.secrets[s.id] || {}).map((k) => [k, true])) }))
		};
	}

	// ---------- services ----------

	saveService(input, sid) {
		const s = sid ? this.service(sid) : { id: id() };
		const name = String(input.name ?? s.name ?? "").trim();
		if (!name) throw new UserError("Please enter a name");
		const url = String(input.url ?? s.url ?? "").trim();
		if (url && !/^https?:\/\/[^/\s]+/i.test(url)) throw new UserError("The address must start with http:// or https://");
		s.name = name.slice(0, 60);
		s.url = url;
		s.icon = String(input.icon ?? s.icon ?? "").trim().slice(0, 200);
		s.kind = input.kind !== undefined ? (KINDS[input.kind] ? input.kind : null) : s.kind || null;
		s.container = input.container !== undefined ? String(input.container || "").trim() || null : s.container || null;
		s.check = input.check !== undefined ? input.check !== false : s.check !== false;
		s.insecure = input.insecure !== undefined ? !!input.insecure : !!s.insecure;
		// how it's checked: HTTP (default), HTTP with a text, TCP port, ping or DNS
		if (input.checkType !== undefined) {
			const type = CHECK_TYPES.includes(input.checkType) ? input.checkType : "http";
			if (type === "http") delete s.checkType;
			else s.checkType = type;
			for (const [k, n] of [["checkTarget", 300], ["keyword", 200], ["codes", 60], ["dnsServer", 100], ["dnsExpect", 200]]) {
				const v = str(input[k], n);
				if (v) s[k] = v;
				else delete s[k];
			}
			if (s.codes && !/^\d{3}(-\d{3})?(,\s*\d{3}(-\d{3})?)*$/.test(s.codes)) throw new UserError("Status codes like 200-299,401");
			if (input.keywordAbsent) s.keywordAbsent = true;
			else delete s.keywordAbsent;
			if (["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "PTR"].includes(input.dnsType) && input.dnsType !== "A") s.dnsType = input.dnsType;
			else delete s.dnsType;
			if (s.checkType === "keyword" && !s.keyword) throw new UserError("Please enter the text to look for");
		}
		if (input.certWarn !== undefined) {
			if (input.certWarn === false) s.certWarn = false;
			else delete s.certWarn;
		}
		// optional address from outside the home network (e.g. its Tailscale address)
		const away = String(input.urlAway ?? s.urlAway ?? "").trim();
		if (away && !/^https?:\/\/[^/\s]+/i.test(away)) throw new UserError("The address away from home must start with http:// or https://");
		if (away) s.urlAway = away.slice(0, 500);
		else delete s.urlAway;
		if (!sid) this.config.services.push(s);
		// logins: empty string removes, undefined keeps
		if (input.secrets && typeof input.secrets === "object") {
			const cur = { ...(this.secrets[s.id] || {}) };
			for (const [k, v] of Object.entries(input.secrets)) {
				if (v === undefined || v === null) continue;
				if (v === "") delete cur[k];
				else cur[k] = String(v);
			}
			if (Object.keys(cur).length) this.secrets[s.id] = cur;
			else delete this.secrets[s.id];
			writeJSON(this.secretsFile, this.secrets, 0o600);
		}
		this.save();
		return s;
	}

	removeService(sid) {
		this.service(sid);
		this.config.services = this.config.services.filter((s) => s.id !== sid);
		for (const b of this.config.boards) b.tiles = b.tiles.filter((t) => t.service !== sid);
		delete this.secrets[sid];
		writeJSON(this.secretsFile, this.secrets, 0o600);
		this.save();
	}

	secretsOf(sid) {
		return this.secrets[sid] || {};
	}

	// Logins of other things than services ("tile:<id>", "channel:<id>"): "" removes, undefined keeps.
	mergeSecrets(key, input) {
		if (!input || typeof input !== "object") return;
		const cur = { ...(this.secrets[key] || {}) };
		for (const [k, v] of Object.entries(input)) {
			if (v === undefined || v === null) continue;
			if (v === "") delete cur[k];
			else cur[String(k).slice(0, 100)] = String(v).slice(0, 4000);
		}
		if (Object.keys(cur).length) this.secrets[key] = cur;
		else delete this.secrets[key];
		writeJSON(this.secretsFile, this.secrets, 0o600);
	}

	// A service is muted until a time (maintenance): no messages, problems shown calmer.
	muteService(sid, until) {
		const s = this.service(sid);
		if (until && until > Date.now()) s.mutedUntil = Math.min(Number(until), Date.now() + 30 * 86400000);
		else delete s.mutedUntil;
		this.save();
		return s;
	}

	setSecret(sid, key, value) {
		this.secrets[sid] = { ...(this.secrets[sid] || {}), [key]: String(value) };
		writeJSON(this.secretsFile, this.secrets, 0o600);
	}

	// ---------- boards and tiles ----------

	addBoard(name) {
		const b = { id: id(), name: String(name || "").trim().slice(0, 40), tiles: [] };
		this.config.boards.push(b);
		this.save();
		return b;
	}

	renameBoard(bid, name) {
		this.board(bid).name = String(name || "").trim().slice(0, 40);
		this.save();
	}

	// new order of the pages (ids); unknown ids are ignored, missing ones keep their place at the end
	orderBoards(ids) {
		const byId = new Map(this.config.boards.map((b) => [b.id, b]));
		const first = (Array.isArray(ids) ? ids : []).map((x) => byId.get(x)).filter(Boolean);
		this.config.boards = [...new Set([...first, ...this.config.boards])];
		this.save();
	}

	removeBoard(bid) {
		this.board(bid);
		if (this.config.boards.length === 1) throw new UserError("The last board can't be removed");
		this.config.boards = this.config.boards.filter((b) => b.id !== bid);
		this.save();
	}

	// Replaces the tiles of a board (order, sizes, added and removed tiles) after checking them.
	setTiles(bid, tiles) {
		const b = this.board(bid);
		if (!Array.isArray(tiles)) throw new UserError("Invalid layout");
		const known = new Set(this.config.services.map((s) => s.id));
		b.tiles = tiles
			.filter((t) => t && TILE_TYPES.includes(t.type))
			.map((t) => {
				const [w, h] = SIZES.find(([w, h]) => w === t.w && h === t.h) || [1, 1];
				const tile = { id: typeof t.id === "string" && /^[a-f0-9]{10}$/.test(t.id) ? t.id : id(), type: t.type, w, h };
				if (t.service && known.has(t.service)) tile.service = t.service;
				if (t.type === "links" && Array.isArray(t.links)) tile.links = t.links.slice(0, 20).map((l) => ({ name: String(l.name || "").slice(0, 40), url: String(l.url || "").slice(0, 300) })).filter((l) => /^https?:\/\//.test(l.url));
				// notes are Markdown text (an older list of entries becomes a checklist)
				if (t.type === "notes" && Array.isArray(t.archive)) tile.archive = t.archive.slice(-500).map((a) => ({ text: String((a && a.text) || "").slice(0, 1000), at: Number(a && a.at) || Date.now() })).filter((a) => a.text.trim());
				if (t.type === "notes") tile.text = typeof t.text === "string" ? t.text.slice(0, 20000) : (Array.isArray(t.notes) ? t.notes : []).map((n) => `- [${n.done ? "x" : " "}] ${String(n.text || "")}`).join("\n");
				// releases: subscribed GitHub repositories and the newest tag already seen per repository
				if (t.type === "releases") {
					tile.repos = [...new Set((Array.isArray(t.repos) ? t.repos : []).filter((r) => typeof r === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(r)))].slice(0, 60);
					tile.seen = Object.fromEntries(Object.entries(t.seen && typeof t.seen === "object" ? t.seen : {}).filter(([r, v]) => tile.repos.includes(r) && typeof v === "string").map(([r, v]) => [r, v.slice(0, 100)]));
				}
				const url = (u) => /^(https?|webcals?):\/\/[^\s]+$/i.test(String(u || "").trim()) ? String(u).trim().slice(0, 1000) : null;
				if (t.type === "weather" && t.place && Number.isFinite(+t.place.lat) && Number.isFinite(+t.place.lon)) tile.place = { name: String(t.place.name || "").slice(0, 60), lat: +t.place.lat, lon: +t.place.lon };
				if (t.type === "clock") {
					tile.seconds = !!t.seconds;
					if (t.analog) tile.analog = true;
					// more places: [{ name, zone }] with an IANA time zone
					tile.zones = (Array.isArray(t.zones) ? t.zones : []).filter((z) => z && /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(z.zone || "")).map((z) => ({ name: String(z.name || "").slice(0, 30), zone: z.zone })).slice(0, 4);
				}
				// each calendar keeps an id: its login (private calendars) is a secret of the tile under that id
				if (t.type === "ical") tile.calendars = (Array.isArray(t.calendars) ? t.calendars : []).map((c) => ({ id: /^[a-f0-9]{10}$/.test((c && c.id) || "") ? c.id : id(), name: String((c && c.name) || "").slice(0, 40), url: url(c && c.url), color: /^#[0-9a-f]{6}$/i.test((c && c.color) || "") ? c.color : "#9dbcff" })).filter((c) => c.url).slice(0, 10);
				if (t.type === "rss") tile.feeds = (Array.isArray(t.feeds) ? t.feeds : []).map((f) => ({ name: String((f && f.name) || "").slice(0, 40), url: url(f && f.url) })).filter((f) => f.url && /^https?:/i.test(f.url)).slice(0, 15);
				if (t.type === "iframe" && url(t.url) && /^https?:/i.test(t.url)) tile.url = url(t.url);
				// own API: address, what to read, how to show it (header values are secrets of "tile:<id>")
				if (t.type === "api" && t.api && typeof t.api === "object") {
					const a = t.api;
					const fieldOf = (f) => ({ label: str(f.label, 40), path: str(f.path, 200), format: str(f.format || "auto", 20), ...Object.fromEntries(["decimals", "scale", "warnAbove", "warnBelow", "badAbove", "badBelow"].filter((k) => f[k] !== undefined && f[k] !== "" && Number.isFinite(+f[k])).map((k) => [k, +f[k]])), ...Object.fromEntries(["prefix", "suffix"].filter((k) => f[k]).map((k) => [k, str(f[k], 20)])) });
					tile.api = {
						url: httpUrl(a.url),
						method: a.method === "POST" ? "POST" : "GET",
						body: a.method === "POST" ? str(a.body, 4000) : undefined,
						headers: (Array.isArray(a.headers) ? a.headers : []).map((x) => ({ name: str(x && x.name, 60) })).filter((x) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(x.name)).slice(0, 6),
						insecure: !!a.insecure,
						ttl: num(a.ttl, 5, 86400, 60),
						fields: (Array.isArray(a.fields) ? a.fields : []).filter((f) => f && typeof f === "object").map(fieldOf).slice(0, 12),
						list: a.list && (a.list.path !== undefined || a.list.title) ? { path: str(a.list.path, 200), title: str(a.list.title, 200), sub: str(a.list.sub, 200), status: str(a.list.status, 200), okValues: str(a.list.okValues, 200), max: num(a.list.max, 1, 50, 10) } : undefined
					};
				}
				// shares, indices, currencies and coins
				if (t.type === "markets") {
					const list = (v, re, n) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => re.test(x)))].slice(0, n);
					tile.symbols = list(t.symbols, /^[A-Za-z0-9.^=-]{1,20}$/, 12);
					tile.fx = list(t.fx, /^[A-Z]{3}$/, 8);
					tile.crypto = list(t.crypto, /^[a-z0-9-]{1,40}$/, 8);
					tile.base = /^[A-Z]{3}$/.test(t.base || "") ? t.base : "CHF";
				}
				if (t.type === "holidays") tile.canton = /^[A-Z]{2}$/.test(t.canton || "") ? t.canton : "ZH";
				// days until something: [{ name, date: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM", yearly }]
				if (t.type === "countdown") tile.items = (Array.isArray(t.items) ? t.items : []).filter((c) => c && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(c.date || "")).map((c) => ({ name: str(c.name, 40), date: c.date, ...(c.yearly ? { yearly: true } : {}) })).slice(0, 8);
				// a camera: a still image (refreshed) or an MJPEG stream, loaded through HomeBento
				if (t.type === "camera") {
					tile.url = httpUrl(t.url);
					tile.mode = t.mode === "mjpeg" ? "mjpeg" : "snapshot";
					tile.refresh = num(t.refresh, 1, 600, 5);
					tile.insecure = !!t.insecure;
				}
				if (t.title) tile.title = String(t.title).slice(0, 40);
				return tile;
			})
			.filter((t) => t.type !== "service" || t.service);
		this.save();
		return b;
	}

	// Messages: where they go, what's worth one, limits for the server, quiet times.
	setAlerts(input) {
		const cur = this.config.alerts || {};
		const a = { ...cur };
		if (Array.isArray(input.channels)) {
			a.channels = input.channels.slice(0, 10).map((c) => ({
				id: typeof c.id === "string" && /^[a-f0-9]{10}$/.test(c.id) ? c.id : id(),
				type: CHANNEL_TYPES.includes(c.type) ? c.type : "ntfy",
				name: str(c.name, 40),
				enabled: c.enabled !== false,
				// the visible settings (addresses, chat ids …); passwords and tokens go to the secrets
				fields: Object.fromEntries(Object.entries(c.fields && typeof c.fields === "object" ? c.fields : {}).map(([k, v]) => [str(k, 40), str(v, 500)]).filter(([k, v]) => k && v)),
				events: { down: c.events ? c.events.down !== false : true, up: c.events ? c.events.up !== false : true, warn: c.events ? !!c.events.warn : true, resources: c.events ? c.events.resources !== false : true }
			}));
			// secrets of removed channels go too
			const ids = new Set(a.channels.map((c) => c.id));
			for (const k of Object.keys(this.secrets)) if (k.startsWith("channel:") && !ids.has(k.slice(8))) delete this.secrets[k];
			writeJSON(this.secretsFile, this.secrets, 0o600);
		}
		if (input.delay !== undefined) a.delay = num(input.delay, 0, 60, 0);
		if (input.limits && typeof input.limits === "object") a.limits = { disk: num(input.limits.disk, 50, 100, 90), temp: num(input.limits.temp, 40, 110, 80), memory: num(input.limits.memory, 50, 100, 95), certDays: num(input.limits.certDays, 0, 90, 14) };
		if (input.mutedUntil !== undefined) {
			if (input.mutedUntil && +input.mutedUntil > Date.now()) a.mutedUntil = Math.min(+input.mutedUntil, Date.now() + 30 * 86400000);
			else delete a.mutedUntil;
		}
		this.config.alerts = a;
		this.save();
		return a;
	}

	// The whole configuration as a file (logins only when asked for).
	exportConfig(withSecrets) {
		return { homebento: 1, exported: new Date().toISOString(), config: this.config, ...(withSecrets ? { secrets: this.secrets } : {}) };
	}

	// Takes over an exported file: services and pages are checked like when they're made by hand.
	importConfig(data) {
		const cfg = data && data.homebento && data.config;
		if (!cfg || !Array.isArray(cfg.services) || !Array.isArray(cfg.boards)) throw new UserError("Not a HomeBento export");
		const before = JSON.stringify({ config: this.config, secrets: this.secrets });
		try {
			this.config = { ...defaults(), title: str(cfg.title, 40), services: [], boards: [] };
			if (cfg.location) this.setLocation(cfg.location);
			this.secrets = {};
			for (const s of cfg.services) {
				const saved = this.saveService({ ...s, id: undefined, secrets: (data.secrets && data.secrets[s.id]) || {} });
				// keep the ids: tiles point to them
				const old = saved.id;
				saved.id = /^[a-f0-9]{10}$/.test(s.id || "") ? s.id : old;
				if (this.secrets[old]) (this.secrets[saved.id] = this.secrets[old]), old !== saved.id && delete this.secrets[old];
			}
			for (const b of cfg.boards) {
				const nb = this.addBoard(b.name);
				if (/^[a-f0-9]{10}$/.test(b.id || "")) nb.id = b.id;
				this.setTiles(nb.id, Array.isArray(b.tiles) ? b.tiles : []);
			}
			if (!this.config.boards.length) this.config.boards = defaults().boards;
			if (cfg.alerts) this.setAlerts(cfg.alerts);
			if (data.secrets) for (const [k, v] of Object.entries(data.secrets)) if (/^(tile|channel):/.test(k)) this.mergeSecrets(k, v);
			this.save();
			writeJSON(this.secretsFile, this.secrets, 0o600);
		} catch (err) {
			const old = JSON.parse(before);
			this.config = old.config;
			this.secrets = old.secrets;
			throw err;
		}
	}

	// where the weather is (and anything else that needs a place)
	setLocation(place) {
		if (!place) delete this.config.location;
		else if (Number.isFinite(+place.lat) && Number.isFinite(+place.lon)) this.config.location = { name: String(place.name || "").slice(0, 60), lat: +place.lat, lon: +place.lon };
		this.save();
	}

	setTitle(title) {
		this.config.title = String(title || "").trim().slice(0, 40);
		this.save();
	}

	// the number of columns of the tiles: 6, 8 or 10 (the same on every screen)
	setColumns(n) {
		if ([6, 8, 10].includes(Number(n))) this.config.columns = Number(n);
		else delete this.config.columns;
		this.save();
	}

	// how wide the page may get, in percent of the screen
	setWidth(width) {
		// percent of the screen (50–100); anything else: the usual 1480 px at most
		if (Number.isFinite(+width) && +width >= 50 && +width <= 100) this.config.width = Math.round(+width);
		else delete this.config.width;
		this.save();
	}


}

module.exports = { Store, TILE_TYPES, SIZES, CHECK_TYPES, CHANNEL_TYPES };
