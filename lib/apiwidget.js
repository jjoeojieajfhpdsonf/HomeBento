"use strict";
// Data for the "custom API" tile: fetch any JSON URL, pick values by path and format them.
// get() reads a path, paths() suggests paths for the settings form, format() turns a value into
// text (+ threshold state), fetchApi() builds the tile (cached), preview() is one uncached test call.
const crypto = require("node:crypto");
const { request } = require("./util");

const MAX_BYTES = 2_000_000;
const PREVIEW_CHARS = 50_000;
const STALE_MS = 10 * 60000;
const DASH = "–";

// ---------- paths ----------

const WILD = Symbol("*");
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// "data.temp", "items[0].name", "items.0.name", "['key with.dot']", "items[*].name", "$.a" → segments.
// Keys are strings, bracket indices numbers, wildcards WILD. Returns null when malformed.
function parsePath(path) {
	const s = String(path == null ? "" : path).trim().replace(/^\$(?=\.|\[|$)/, "");
	const out = [];
	let i = 0;
	while (i < s.length) {
		const c = s[i];
		if (c === ".") {
			i++;
			continue;
		}
		if (c === "[") {
			let j = i + 1;
			while (s[j] === " ") j++;
			const q = s[j];
			if (q === "'" || q === '"') {
				let key = "";
				for (j++; j < s.length && s[j] !== q; j++) key += s[j] === "\\" && j + 1 < s.length ? s[++j] : s[j];
				if (s[j] !== q) return null;
				j++;
				while (s[j] === " ") j++;
				if (s[j] !== "]") return null;
				out.push(key);
				i = j + 1;
			} else {
				const end = s.indexOf("]", j);
				if (end < 0) return null;
				const inner = s.slice(j, end).trim();
				if (inner === "*") out.push(WILD);
				else if (/^-?\d+$/.test(inner)) out.push(Number(inner));
				else if (inner) out.push(inner);
				else return null;
				i = end + 1;
			}
			continue;
		}
		let j = i;
		while (j < s.length && s[j] !== "." && s[j] !== "[") j++;
		const key = s.slice(i, j).trim();
		out.push(key === "*" ? WILD : key);
		i = j;
	}
	return out;
}

function step(v, seg) {
	if (v === null || v === undefined) return undefined;
	if (Array.isArray(v) || typeof v === "string") {
		if (seg === "length") return v.length;
		const n = typeof seg === "number" ? seg : /^-?\d+$/.test(seg) ? Number(seg) : NaN;
		if (!Number.isInteger(n)) return undefined;
		return typeof v === "string" ? undefined : v[n < 0 ? v.length + n : n];
	}
	if (typeof v === "object") return hasOwn(v, String(seg)) ? v[String(seg)] : undefined;
	return undefined;
}

function walk(v, segs, i) {
	for (; i < segs.length; i++) {
		if (v === null || v === undefined) return undefined;
		if (segs[i] === WILD) {
			if (typeof v !== "object") return undefined;
			const rest = segs.slice(i + 1);
			const nested = rest.includes(WILD);
			const out = [];
			for (const x of Array.isArray(v) ? v : Object.values(v)) {
				const r = walk(x, segs, i + 1);
				if (r === undefined) continue;
				if (nested && Array.isArray(r)) out.push(...r);
				else out.push(r);
			}
			return out;
		}
		v = step(v, segs[i]);
	}
	return v;
}

// Reads a value by path. Never throws; undefined when missing. "" returns the whole value.
function get(obj, path) {
	if (path === null || path === undefined) return undefined;
	try {
		const segs = parsePath(path);
		return segs ? walk(obj, segs, 0) : undefined;
	} catch {
		return undefined;
	}
}

function joinPath(base, key) {
	if (typeof key === "number") return `${base}[${key}]`;
	if (/^[A-Za-z_$][\w$-]*$/.test(key) && key !== "length") return base ? `${base}.${key}` : key;
	return `${base}['${key.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}']`;
}

function typeOf(v) {
	if (Array.isArray(v)) return "array";
	if (v === null) return "string";
	if (typeof v === "object") return "object";
	if (typeof v === "number" || typeof v === "boolean") return typeof v;
	return "string";
}

function sample(v) {
	if (Array.isArray(v)) return `[${v.length}]`;
	if (v === null) return "null";
	if (typeof v === "object") return `{${Object.keys(v).length}}`;
	const s = String(v);
	return s.length > 40 ? `${s.slice(0, 39)}…` : s;
}

// Flattens JSON into path suggestions for the settings form. Arrays appear once as the array itself
// ("items", type array – usable as list path), "items.length" and their first item ("items[0].x").
function paths(obj, { max = 300 } = {}) {
	const out = [];
	const add = (path, v, type = typeOf(v)) => out.length < max && out.push({ path, sample: sample(v), type });
	const visit = (v, path, depth) => {
		if (out.length >= max) return;
		if (Array.isArray(v)) {
			add(path, v);
			add(path ? `${path}.length` : "length", v.length);
			const first = v.find((x) => x !== null && x !== undefined);
			if (first !== undefined && depth < 6) visit(first, joinPath(path, 0), depth + 1);
		} else if (v && typeof v === "object") {
			const keys = Object.keys(v);
			if (!keys.length || depth >= 6) {
				if (path) add(path, v);
				return;
			}
			for (const k of keys) visit(v[k], joinPath(path, k), depth + 1);
		} else if (path) add(path, v);
		else add("", v);
	};
	visit(obj, "", 0);
	return out;
}

// ---------- formatting ----------

const num = (x) => (x === "" || x === null || x === undefined || typeof x === "boolean" ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const nf = (v, min, max) => new Intl.NumberFormat("de-CH", { minimumFractionDigits: min, maximumFractionDigits: max }).format(v).replace(/’/g, "'");
const fixed = (v, d, fallback) => {
	const n = num(d);
	const dec = n === null ? fallback : Math.max(0, Math.min(6, Math.round(n)));
	return nf(v, dec, dec);
};

function scaled(v, units, base, decimals) {
	let i = 0;
	while (Math.abs(v) >= base && i < units.length - 1) {
		v /= base;
		i++;
	}
	return `${fixed(v, decimals, i ? 1 : 0)} ${units[i]}`;
}

function duration(sec) {
	const s = Math.abs(sec);
	const sign = sec < 0 ? "-" : "";
	const d = Math.floor(s / 86400);
	const h = Math.floor((s % 86400) / 3600);
	const m = Math.floor((s % 3600) / 60);
	if (d) return `${sign}${d} d${h ? ` ${h} h` : ""}`;
	if (h) return `${sign}${h} h${m ? ` ${m} min` : ""}`;
	if (m) return `${sign}${m} min`;
	return `${sign}${Math.round(s)} s`;
}

// ISO string, epoch seconds or epoch milliseconds → ms (or null).
function toTime(v) {
	if (v instanceof Date) return v.getTime();
	const n = typeof v === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v;
	if (typeof n === "number" && Number.isFinite(n)) return Math.abs(n) < 1e11 ? n * 1000 : n;
	if (typeof n !== "string" || !n.trim()) return null;
	const t = Date.parse(n);
	return Number.isFinite(t) ? t : null;
}

function dateText(t, timeZone) {
	const opts = { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" };
	let parts;
	try {
		parts = new Intl.DateTimeFormat("de-CH", { ...opts, timeZone: timeZone || undefined }).formatToParts(t);
	} catch {
		parts = new Intl.DateTimeFormat("de-CH", opts).formatToParts(t);
	}
	const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
	const thisYear = String(new Date().getFullYear());
	return `${p.day}.${p.month}.${p.year === thisYear ? "" : p.year} ${p.hour}:${p.minute}`;
}

function relative(t, lang) {
	const en = String(lang || "de").startsWith("en");
	const diff = (Date.now() - t) / 1000;
	const s = Math.abs(diff);
	if (s < 60) return en ? "just now" : "gerade eben";
	const span = s < 3600 ? `${Math.floor(s / 60)} min` : s < 86400 ? `${Math.floor(s / 3600)} h` : `${Math.floor(s / 86400)} d`;
	if (diff >= 0) return en ? `${span} ago` : `vor ${span}`;
	return `in ${span}`;
}

function toBool(v) {
	if (typeof v === "boolean") return v;
	const s = String(v).trim().toLowerCase();
	if (["true", "1", "yes", "ja", "on", "ok", "up", "online", "enabled", "active"].includes(s)) return true;
	if (["false", "0", "no", "nein", "off", "down", "offline", "disabled", "inactive"].includes(s)) return false;
	return null;
}

function plain(v) {
	if (Array.isArray(v)) return v.map((x) => (x !== null && typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
	if (v !== null && typeof v === "object") return JSON.stringify(v);
	return String(v);
}

function stateOf(v, o) {
	const [wa, wb, ba, bb] = [num(o.warnAbove), num(o.warnBelow), num(o.badAbove), num(o.badBelow)];
	if (wa === null && wb === null && ba === null && bb === null) return null;
	if (v === null) return null;
	if ((ba !== null && v > ba) || (bb !== null && v < bb)) return "bad";
	if ((wa !== null && v > wa) || (wb !== null && v < wb)) return "warn";
	return "ok";
}

// Value → { text, state }. Thresholds compare the raw number; for "percent" the value in percent,
// for "date"/"relative" the age in seconds (e.g. badAbove 86400 = older than a day).
function format(value, fmt = "auto", opts = {}) {
	opts = opts || {};
	if (value === undefined || value === null || value === "") return { text: DASH, state: null };
	let text;
	let n = num(value);
	switch (fmt || "auto") {
		case "number":
			text = n === null ? plain(value) : num(opts.decimals) === null ? nf(n, 0, 2) : fixed(n, opts.decimals, 0);
			break;
		case "percent":
			if (n !== null) n = num(opts.scale) === 1 ? n * 100 : n;
			text = n === null ? plain(value) : `${fixed(n, opts.decimals, 0)}%`;
			break;
		case "bytes":
			text = n === null ? plain(value) : scaled(n, ["B", "KB", "MB", "GB", "TB", "PB"], 1000, opts.decimals);
			break;
		case "bitrate":
			text = n === null ? plain(value) : scaled(n, ["bit/s", "kbit/s", "Mbit/s", "Gbit/s", "Tbit/s"], 1000, opts.decimals);
			break;
		case "duration":
			text = n === null ? plain(value) : duration(n);
			break;
		case "date":
		case "relative": {
			const t = toTime(value);
			n = t === null ? null : (Date.now() - t) / 1000;
			text = t === null ? plain(value) : fmt === "date" ? dateText(t, opts.timeZone || process.env.TZ) : relative(t, opts.lang);
			break;
		}
		case "boolean": {
			const b = toBool(value);
			const en = String(opts.lang || "de").startsWith("en");
			const yes = opts.true != null && opts.true !== "" ? String(opts.true) : en ? "Yes" : "Ja";
			const no = opts.false != null && opts.false !== "" ? String(opts.false) : en ? "No" : "Nein";
			text = b === null ? plain(value) : b ? yes : no;
			n = b === null ? null : Number(b);
			break;
		}
		case "auto":
			if (typeof value === "number") text = nf(value, 0, 2);
			else if (typeof value === "boolean") return format(value, "boolean", opts);
			else text = plain(value);
			break;
		default:
			text = plain(value);
	}
	if (text.length > 200) text = `${text.slice(0, 199)}…`;
	return { text: `${opts.prefix || ""}${text}${opts.suffix || ""}`, state: stateOf(n, opts) };
}

// ---------- fetching ----------

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

// Validates the config and builds the request. Throws readable errors without secret values.
function buildRequest(cfg, secrets = {}) {
	if (!cfg || typeof cfg.url !== "string" || !cfg.url.trim()) throw new Error("No address set");
	let u;
	try {
		u = new URL(cfg.url.trim());
	} catch {
		throw new Error("Invalid address");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https addresses are allowed");
	const method = String(cfg.method || "GET").toUpperCase();
	if (method !== "GET" && method !== "POST") throw new Error("Method must be GET or POST");
	const headers = { Accept: "application/json, text/plain;q=0.9, */*;q=0.5" };
	const body = method === "POST" && cfg.body != null && cfg.body !== "" ? String(cfg.body) : undefined;
	if (body !== undefined) {
		let isJson = true;
		try {
			JSON.parse(body);
		} catch {
			isJson = false;
		}
		headers["Content-Type"] = isJson ? "application/json" : "text/plain; charset=utf-8";
	}
	const used = [];
	for (const h of Array.isArray(cfg.headers) ? cfg.headers : []) {
		const name = String((h && h.name) || "").trim();
		if (!name) continue;
		if (!TOKEN.test(name)) throw new Error(`Invalid header name "${name.slice(0, 40)}"`);
		const value = secrets && secrets[name];
		if (value === undefined || value === null || value === "") continue;
		if (/[\r\n\0]/.test(String(value))) throw new Error(`Header ${name} has an invalid value`);
		headers[name] = String(value);
		used.push(String(value));
	}
	const t = num(cfg.timeout);
	const timeout = t === null ? 10000 : Math.max(1000, Math.min(60000, t < 1000 ? t * 1000 : t));
	return { url: u.toString(), opts: { method, headers, body, timeout, insecure: !!cfg.insecure, maxBytes: MAX_BYTES }, used };
}

// Removes any secret value that might have slipped into a message.
function scrub(msg, used) {
	let m = String(msg || "Request failed");
	for (const s of used) if (s.length >= 4) m = m.split(s).join("***");
	return m;
}

// One request → { status, ms, text, json, isJson, type }. Throws for network and HTTP errors.
async function load(cfg, secrets) {
	const { url, opts, used } = buildRequest(cfg, secrets);
	const r = await request(url, opts);
	if (!r.status) throw new Error(scrub(r.error, used));
	if (r.status === 401 || r.status === 403) throw new Error(`HTTP ${r.status} – access denied (check the headers or API key)`);
	if (r.status >= 300) throw new Error(`HTTP ${r.status}`);
	const text = r.body.toString("utf8").replace(/^﻿/, "");
	let json;
	let isJson = false;
	try {
		json = JSON.parse(text);
		isJson = true;
	} catch {}
	return { status: r.status, ms: r.ms, text, json, isJson, type: String(r.headers["content-type"] || "").split(";")[0] };
}

const okDefault = ["ok", "up", "true", "1", "yes", "running", "online", "healthy", "active", "success", "enabled", "connected"];

function itemsOf(root, list) {
	if (!list || (!list.path && !list.title)) return [];
	const arr = get(root, list.path || "");
	if (arr === undefined || arr === null || typeof arr !== "object") return [];
	const entries = Array.isArray(arr) ? arr.map((v, i) => [String(i), v]) : Object.entries(arr);
	const max = Math.max(1, Math.min(50, num(list.max) || 10));
	const okValues = list.okValues != null && String(list.okValues).trim() ? String(list.okValues).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : okDefault;
	const pick = (key, item, path) => (path === "$key" ? key : get(item, path || ""));
	return entries.slice(0, max).map(([key, item]) => {
		const raw = list.status ? pick(key, item, list.status) : undefined;
		const status = raw === undefined || raw === null ? null : okValues.includes(String(raw).trim().toLowerCase()) ? "ok" : "bad";
		return {
			title: format(pick(key, item, list.title), "auto").text,
			sub: list.sub ? format(pick(key, item, list.sub), "auto").text : "",
			status,
			statusText: raw === undefined || raw === null ? "" : plain(raw).slice(0, 80)
		};
	});
}

// Builds the tile from one response (exported for tests and reuse).
function build(cfg, res) {
	const fields = (Array.isArray(cfg.fields) ? cfg.fields : []).slice(0, 20);
	const wholeText = fields.some((f) => !f || !f.path);
	if (!res.isJson && !wholeText) throw new Error(`Not JSON${res.type ? ` (got ${res.type})` : ""}`);
	const root = res.isJson ? res.json : res.text.trim();
	const values = fields.map((f) => {
		f = f || {};
		const v = f.path ? (res.isJson ? get(root, f.path) : undefined) : root;
		const { text, state } = format(v, f.format || "auto", { ...f, lang: f.lang || cfg.lang, timeZone: f.timeZone || cfg.timeZone });
		return { label: String(f.label || f.path || ""), text, state };
	});
	return { values, items: res.isJson ? itemsOf(root, cfg.list) : [], at: Date.now() };
}

class Cache {
	constructor() {
		this.map = new Map();
	}
	async get(key, ttl, load) {
		const c = this.map.get(key);
		if (c && Date.now() < c.exp) return c.value;
		if (c && c.pending) return c.value !== undefined ? c.value : c.pending;
		const pending = load().then(
			(value) => (this.map.set(key, { exp: Date.now() + ttl, okAt: Date.now(), value }), value),
			(err) => {
				// keep showing the last good value for a while, then the error
				const keep = c && c.okAt && Date.now() - c.okAt < Math.max(10 * ttl, STALE_MS);
				const value = keep ? { ...c.value, stale: true } : { error: err.message };
				this.map.set(key, { exp: Date.now() + Math.min(ttl, 60000), okAt: keep ? c.okAt : 0, value });
				return value;
			}
		);
		this.map.set(key, { ...(c || {}), pending });
		if (this.map.size > 300) for (const [k, e] of this.map) if (!e.pending && e.exp < Date.now() - STALE_MS) this.map.delete(k);
		return c && c.value !== undefined ? c.value : pending;
	}
}

const cache = new Cache();

// Cached tile data → { values: [{ label, text, state }], items: [{ title, sub, status, statusText }], at }
// or { error } (with a stale result kept for a while after errors, marked stale: true).
// The cache key is cfg.key plus a hash of the config and used secrets, so edits apply at once.
async function fetchApi(cfg, secrets = {}) {
	const names = (Array.isArray(cfg && cfg.headers) ? cfg.headers : []).map((h) => String((h && h.name) || ""));
	const hash = crypto.createHash("sha256").update(JSON.stringify([cfg, names.map((n) => (secrets || {})[n] ?? null)])).digest("hex").slice(0, 24);
	const t = num(cfg && cfg.ttl);
	const ttl = Math.max(5, Math.min(86400, t === null || t <= 0 ? 30 : t)) * 1000;
	return cache.get(`${(cfg && cfg.key) || ""}:${hash}`, ttl, async () => build(cfg, await load(cfg, secrets)));
}

// Shrinks JSON for the preview until it fits ~50 KB when stringified.
function shrink(v, arr, str, depth = 0) {
	if (typeof v === "string") return v.length > str ? `${v.slice(0, str)}…` : v;
	if (!v || typeof v !== "object") return v;
	if (depth > 12) return Array.isArray(v) ? "[…]" : "{…}";
	if (Array.isArray(v)) {
		const out = v.slice(0, arr).map((x) => shrink(x, arr, str, depth + 1));
		if (v.length > arr) out.push(`… ${v.length - arr} more`);
		return out;
	}
	const out = {};
	for (const k of Object.keys(v).slice(0, arr * 4)) out[k] = shrink(v[k], arr, str, depth + 1);
	return out;
}

function truncate(json) {
	if (JSON.stringify(json).length <= PREVIEW_CHARS) return { json, truncated: false };
	let small;
	for (const [arr, str] of [[50, 500], [20, 200], [10, 120], [5, 80], [3, 60], [1, 40]]) {
		small = shrink(json, arr, str);
		if (JSON.stringify(small).length <= PREVIEW_CHARS) break;
	}
	return { json: small, truncated: true };
}

// One uncached call for the settings form → { status, ms, json, truncated, paths } or { error }
// (non-JSON answers: { status, ms, error: "Not JSON …", text } – usable with field path "").
async function preview(cfg, secrets = {}) {
	try {
		const r = await load(cfg, secrets);
		if (!r.isJson) return { status: r.status, ms: r.ms, error: `Not JSON${r.type ? ` (got ${r.type})` : ""}`, text: r.text.slice(0, 2000) };
		return { status: r.status, ms: r.ms, ...truncate(r.json), paths: paths(r.json) };
	} catch (err) {
		return { error: err.message };
	}
}

module.exports = { get, paths, format, fetchApi, preview, build, parsePath };
