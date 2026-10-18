"use strict";
// Importers for the configuration of other dashboards, so people can switch to HomeBento:
// Homepage (services.yaml, bookmarks.yaml), Dashy (conf.yml), Homer (config.yml), Heimdall (JSON
// export) and browser bookmarks (Netscape HTML). The result is a preview the web app can show
// before anything is saved:
//   { source, groups: [{ name, services: [{ name, url, icon, description, kind, secrets, container }] }],
//     links: [{ name, url, group }], warnings: ["…"] }
// Logins are only taken over when the file names them for a known integration; nothing is invented.
const yaml = require("./yaml");
const { KINDS, guessKind } = require("./kinds");

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v === null || v === undefined || typeof v === "object" ? "" : String(v).trim());
const isHttp = (u) => /^https?:\/\/[^/\s]+/i.test(u);

// Widget / app types of other dashboards → HomeBento kinds (after lowercasing and dropping
// everything but letters and digits). Types that are already kind names need no entry.
const TYPES = {
	jellyseerr: "overseerr",
	seerr: "overseerr",
	npm: "nginxproxymanager",
	paperlessngx: "paperless",
	paperlessng: "paperless",
	adguardhome: "adguard",
	truenasscale: "truenas",
	speedtesttracker: "speedtest",
	unificonsole: "unifi",
	forgejo: "gitea",
	wireguardeasy: "wgeasy",
	hass: "homeassistant",
	homeassistantapi: "homeassistant",
	piholev6: "pihole",
	changedetectionio: "changedetection",
	diskstation: "synology",
	hoarder: "karakeep",
	wud: "whatsupdocker"
};

function kindOfType(type) {
	const t = str(type).toLowerCase().replace(/[^a-z0-9]/g, "");
	if (!t) return null;
	const k = TYPES[t] || t;
	if (KINDS[k]) return k;
	const g = guessKind(t);
	return g && KINDS[g] ? g : null;
}

// Template values like {{HOMEPAGE_VAR_SONARR_KEY}} only work inside the other dashboard.
const isTemplate = (v) => /\{\{.*\}\}|^\$\{.+\}$/.test(v);

function fieldKeys(kind) {
	return kind && KINDS[kind] ? (KINDS[kind].fields || []).map((f) => f.key) : [];
}

// Where an API key goes for a kind: its apiKey or token field, or the password (Pi-hole).
function keyField(keys) {
	return ["apiKey", "token", "password"].find((k) => keys.includes(k)) || null;
}

// Logins from a widget-like object { key, username, password, … } for a known kind.
// Values the integration has no field for are skipped with a warning.
function secretsFor(kind, src, who, warn) {
	const keys = fieldKeys(kind);
	const out = {};
	const skipped = [];
	const set = (field, value, from) => {
		const v = str(value);
		if (!v) return;
		if (isTemplate(v)) {
			warn(`${who}: "${from}" uses a variable of the other dashboard – enter it in HomeBento`);
			return;
		}
		if (!field || !keys.includes(field) || field in out) {
			skipped.push(from);
			return;
		}
		out[field] = v;
	};
	if (kind === "proxmox") {
		// Homepage: username = token id (user@realm!name), password = token secret;
		// Homer: api_token = "PVEAPIToken=user@realm!name=secret"
		const pair = /^(?:PVEAPIToken=)?([^=\s]+!?[^=\s]*)=(\S+)$/.exec(str(src.key));
		if (pair) {
			set("tokenId", pair[1], "key");
			set("tokenSecret", pair[2], "key");
		} else set(null, src.key, "key");
		set("tokenId", src.username, "username");
		set("tokenSecret", src.password, "password");
	} else if (keys.includes("apiSecret") && !keys.includes("password")) {
		// OPNsense: Homepage puts the API key in username and its secret in password
		set("apiKey", src.key ?? src.username, src.key !== undefined ? "key" : "username");
		set("apiSecret", src.password, "password");
	} else {
		set(keyField(keys), src.key, "key");
		set(keys.includes("username") ? "username" : keys.includes("account") ? "account" : null, src.username, "username");
		set("password", src.password, "password");
	}
	// other settings with the same name as a field, e.g. Homepage's unifi "site"
	for (const k of keys) if (!(k in out) && !["key", "username", "account", "password", "tokenId", "tokenSecret", "apiSecret"].includes(k) && src[k] !== undefined) set(k, src[k], k);
	if (skipped.length) warn(`${who}: ${skipped.map((s) => `"${s}"`).join(", ")} not used by the ${str(KINDS[kind].label?.en || KINDS[kind].label)} integration – skipped`);
	return out;
}

// Icon of another dashboard → HomeBento icon: a dashboard-icons name or an image address.
function iconOf(icon, who, warn) {
	let s = str(icon);
	if (!s || /^(?:favicon|favicon-local|generative|none)$/i.test(s)) return "";
	if (isHttp(s)) return s;
	if (/^(?:mdi|si|fa[a-z]?)[-\s]/i.test(s) || /^fa[a-z]? /i.test(s)) {
		warn(`${who}: icon "${s}" (Material Design / Simple Icons / Font Awesome) is not available – the default icon is used`);
		return "";
	}
	if (s.includes("/") || s.includes("\\")) {
		warn(`${who}: local icon file "${s}" is not available – the default icon is used`);
		return "";
	}
	// Dashy: hl- = dashboard-icons, sh- = selfh.st (mostly the same names); Homepage: sh-
	s = s.replace(/^(?:hl|sh|di)-/i, "").replace(/\.(?:png|svg|webp|jpe?g|gif|ico)$/i, "").toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]*$/.test(s)) {
		warn(`${who}: icon "${str(icon)}" is not available – the default icon is used`);
		return "";
	}
	return s;
}

function cleanUrl(u, who, warn) {
	const s = str(u);
	if (!s) return "";
	if (isTemplate(s)) {
		warn(`${who}: address "${s}" uses a variable of the other dashboard – enter it in HomeBento`);
		return "";
	}
	if (!isHttp(s)) {
		warn(`${who}: address "${s}" does not start with http:// or https:// – left empty`);
		return "";
	}
	return s;
}

const iconHint = (icon) => str(icon).replace(/^.*[/\\]/, "").replace(/\.[a-z]+$/i, "");

// ---------- Homepage ----------

const homepageGroup = (x) => isObj(x) && Object.keys(x).length === 1 && (Array.isArray(Object.values(x)[0]) || Object.values(x)[0] === null);

function fromHomepage(doc, res, warn) {
	const walk = (name, list, parents) => {
		const path = [...parents, str(name) || "Imported"];
		const group = { name: path.join(" / "), services: [] };
		res.groups.push(group);
		for (const item of list || []) {
			if (!isObj(item)) {
				warn(`${group.name}: entry "${str(item)}" is not a service – skipped`);
				continue;
			}
			// bookmarks.yaml: { Name: [{ abbr, href }] }
			for (const [key, val] of Object.entries(item)) {
				if (Array.isArray(val) && val.some((x) => isObj(x) && ("href" in x || "abbr" in x))) {
					for (const b of val) {
						if (!isObj(b)) continue;
						const url = cleanUrl(b.href, str(key), warn);
						if (url) res.links.push({ name: str(key), url, group: group.name });
					}
				} else if (Array.isArray(val)) walk(key, val, path);
				else group.services.push(homepageService(str(key), isObj(val) ? val : {}, warn));
			}
		}
	};
	for (const g of doc) {
		const [name, list] = Object.entries(g)[0];
		walk(name, list, []);
	}
}

function homepageService(name, def, warn) {
	let widget = isObj(def.widget) ? def.widget : null;
	if (!widget && Array.isArray(def.widgets)) {
		widget = def.widgets.find(isObj) || null;
		if (def.widgets.length > 1) warn(`${name}: only the first of ${def.widgets.length} widgets is imported`);
	}
	const url = cleanUrl(def.href, name, warn) || (widget ? cleanUrl(widget.url, name, warn) : "") || (!def.href && !widget && isHttp(str(def.siteMonitor)) ? str(def.siteMonitor) : "");
	const container = str(def.container) || null;
	let kind = null;
	let secrets = {};
	if (widget && str(widget.type)) {
		kind = kindOfType(widget.type);
		if (kind) secrets = secretsFor(kind, { ...widget, key: widget.key ?? widget.apiKey ?? widget.token }, name, warn);
	}
	if (!kind) {
		kind = guessKind(name, container, iconHint(def.icon));
		if (widget && str(widget.type) && !kind) warn(`${name}: Homepage widget "${str(widget.type)}" has no HomeBento integration – imported as a plain service`);
		else if (widget && str(widget.type) && kind) warn(`${name}: Homepage widget "${str(widget.type)}" is not supported – recognised as ${kind}, logins not imported`);
	}
	return { name, url, icon: iconOf(def.icon, name, warn), description: str(def.description), kind, secrets, container };
}

// ---------- Dashy ----------

function fromDashy(doc, res, warn) {
	if (Array.isArray(doc.pages) && doc.pages.length) warn(`Dashy pages (${doc.pages.length}) are not imported – import the file of each page on its own`);
	for (const sec of doc.sections) {
		if (!isObj(sec)) continue;
		const group = { name: str(sec.name) || "Imported", services: [] };
		if (Array.isArray(sec.widgets) && sec.widgets.length) warn(`${group.name}: Dashy widgets are not imported`);
		for (const it of Array.isArray(sec.items) ? sec.items : []) {
			if (!isObj(it)) continue;
			const name = str(it.title) || str(it.name);
			if (!name) continue;
			if (Array.isArray(it.subItems) && it.subItems.length) warn(`${name}: ${it.subItems.length} sub-items are not imported`);
			group.services.push({
				name,
				url: cleanUrl(it.url, name, warn),
				icon: iconOf(it.icon, name, warn),
				description: str(it.description),
				kind: guessKind(name, iconHint(it.icon)),
				secrets: {},
				container: null
			});
		}
		res.groups.push(group);
	}
}

// ---------- Homer ----------

function fromHomer(doc, res, warn) {
	for (const sec of doc.services) {
		if (!isObj(sec)) continue;
		const group = { name: str(sec.name) || "Imported", services: [] };
		for (const it of Array.isArray(sec.items) ? sec.items : []) {
			if (!isObj(it)) continue;
			const name = str(it.name);
			if (!name) continue;
			let kind = it.type ? kindOfType(it.type) : null;
			const secrets = kind ? secretsFor(kind, { ...it, key: it.apikey ?? it.apiKey ?? it.api_key ?? it.token ?? it.api_token }, name, warn) : {};
			if (!kind) kind = guessKind(name, iconHint(it.logo));
			// logo is an image (path or address), icon a Font Awesome class
			const icon = it.logo ? iconOf(it.logo, name, warn) : iconOf(it.icon, name, warn);
			group.services.push({ name, url: cleanUrl(it.url, name, warn), icon, description: str(it.subtitle), kind, secrets, container: null });
		}
		res.groups.push(group);
	}
}

// ---------- Heimdall ----------

function heimdallItems(doc) {
	const list = Array.isArray(doc) ? doc : isObj(doc) ? doc.items || doc.apps : null;
	return Array.isArray(list) && list.some((x) => isObj(x) && (x.title || x.name) && (x.url || x.link)) ? list : null;
}

function fromHeimdall(doc, res, warn) {
	const group = { name: "Heimdall", services: [] };
	for (const it of heimdallItems(doc)) {
		if (!isObj(it) || it.type === 1 || it.deleted_at) continue; // type 1 = tag (folder)
		const name = str(it.title) || str(it.name);
		const link = str(it.url) || str(it.link);
		if (!name || !link) continue;
		// Heimdall stores uploaded icons as files; only full addresses are usable
		const icon = isHttp(str(it.icon)) ? str(it.icon) : "";
		const app = str(it.class).split("\\").pop();
		group.services.push({ name, url: cleanUrl(link, name, warn), icon, description: str(it.description) || str(it.appdescription), kind: guessKind(name, app, iconHint(it.icon)), secrets: {}, container: null });
	}
	res.groups.push(group);
}

// ---------- browser bookmarks ----------

function decode(s) {
	return s
		.replace(/<[^>]*>/g, "")
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
		.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " })[e])
		.replace(/\s+/g, " ")
		.trim();
}

function fromBookmarks(text, res, warn) {
	const stack = [];
	let pending = null;
	let skipped = 0;
	const re = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<a\b([^>]*)>([\s\S]*?)<\/a>|<dl\b[^>]*>|<\/dl\s*>/gi;
	for (let m; (m = re.exec(text)); ) {
		const tag = m[0].slice(0, 3).toLowerCase();
		if (tag === "<h3") pending = decode(m[1]);
		else if (tag === "<dl") {
			stack.push(pending);
			pending = null;
		} else if (tag === "</d") stack.pop();
		else {
			const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[2]);
			const url = href ? decode(href[1] ?? href[2] ?? href[3]) : "";
			if (!isHttp(url)) {
				skipped++;
				continue;
			}
			const group = stack.filter(Boolean).join(" / ") || "Bookmarks";
			res.links.push({ name: decode(m[3]) || url.replace(/^https?:\/\//, ""), url, group });
		}
	}
	if (skipped) warn(`${skipped} bookmark${skipped === 1 ? "" : "s"} without an http(s) address skipped`);
}

// ---------- detection ----------

const isBookmarksHtml = (t, name) => /^<!doctype netscape-bookmark-file/i.test(t.trimStart()) || /<dt>\s*<a\s[^>]*href\s*=/i.test(t) || (/\.html?$/.test(name) && /<a\s[^>]*href\s*=/i.test(t));

function kindOfDoc(doc) {
	if (Array.isArray(doc)) {
		if (doc.length && doc.every(homepageGroup)) return "homepage";
		return heimdallItems(doc) ? "heimdall" : null;
	}
	if (!isObj(doc)) return null;
	if (Array.isArray(doc.sections)) return "dashy";
	if (Array.isArray(doc.services)) return "homer";
	return heimdallItems(doc) ? "heimdall" : null;
}

// JSON first (Heimdall), then YAML; throws the YAML error when neither can be read.
function load(text) {
	const t = text.trimStart();
	if (t[0] === "[" || t[0] === "{") {
		try {
			return JSON.parse(t);
		} catch {
			// not JSON, maybe YAML flow style
		}
	}
	return yaml.parse(text);
}

function prepare(text, filename) {
	return { t: String(text ?? "").replace(/^﻿/, ""), name: String(filename || "").toLowerCase() };
}

// → "homepage" | "dashy" | "homer" | "heimdall" | "bookmarks" | null
function detect(text, filename) {
	const { t, name } = prepare(text, filename);
	if (!t.trim()) return null;
	if (isBookmarksHtml(t, name)) return "bookmarks";
	try {
		return kindOfDoc(load(t));
	} catch {
		return null;
	}
}

function importConfig(text, filename) {
	const { t, name } = prepare(text, filename);
	if (!t.trim()) throw new Error("The file is empty");
	const res = { source: null, groups: [], links: [], warnings: [] };
	const warn = (msg) => {
		if (!res.warnings.includes(msg)) res.warnings.push(msg);
	};
	if (isBookmarksHtml(t, name)) {
		res.source = "bookmarks";
		fromBookmarks(t, res, warn);
	} else {
		const doc = load(t);
		res.source = kindOfDoc(doc);
		if (res.source === "homepage") fromHomepage(doc, res, warn);
		else if (res.source === "dashy") fromDashy(doc, res, warn);
		else if (res.source === "homer") fromHomer(doc, res, warn);
		else if (res.source === "heimdall") fromHeimdall(doc, res, warn);
		else throw new Error("Unknown file: expected a Homepage services.yaml or bookmarks.yaml, a Dashy conf.yml, a Homer config.yml, a Heimdall JSON export or a browser bookmarks file");
	}
	res.groups = res.groups.filter((g) => g.services.length);
	return res;
}

module.exports = { detect, importConfig };
