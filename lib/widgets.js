"use strict";
// Data for the general tiles: weather (Open-Meteo, no key), calendars (iCal links) and news (RSS/Atom).
// Everything is cached for a while; one slow source never blocks the others.
const { request, json } = require("./util");

class Cache {
	constructor(ttl) {
		this.ttl = ttl;
		this.map = new Map();
	}
	async get(key, load) {
		const c = this.map.get(key);
		if (c && Date.now() - c.at < this.ttl) return c.value;
		if (c && c.pending) return c.value !== undefined ? c.value : c.pending;
		const pending = load().then(
			(value) => (this.map.set(key, { at: Date.now(), value }), value),
			(err) => {
				const value = c && c.value && !c.value.error ? c.value : { error: err.message };
				this.map.set(key, { at: Date.now() - this.ttl + 120000, value });
				return value;
			}
		);
		this.map.set(key, { ...(c || {}), pending });
		return c && c.value !== undefined ? c.value : pending;
	}
}

// ---------- weather ----------

const weatherCache = new Cache(15 * 60000);

async function weather(lat, lon) {
	const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
	return weatherCache.get(key, async () => {
		const q = new URLSearchParams({
			latitude: lat,
			longitude: lon,
			current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day,precipitation,surface_pressure,uv_index",
			hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,is_day,wind_speed_10m",
			daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,daylight_duration",
			timezone: "auto",
			forecast_days: "7"
		});
		const r = await json(`https://api.open-meteo.com/v1/forecast?${q}`, { timeout: 12000 });
		const now = Date.now();
		const hours = r.hourly.time
			.map((t, i) => ({ t: Date.parse(t), temp: r.hourly.temperature_2m[i], rain: r.hourly.precipitation_probability[i], mm: r.hourly.precipitation[i], wind: r.hourly.wind_speed_10m[i], code: r.hourly.weather_code[i], day: !!r.hourly.is_day[i] }))
			.filter((h) => h.t > now - 3600000)
			.slice(0, 48);
		return {
			now: { temp: r.current.temperature_2m, feels: r.current.apparent_temperature, humidity: r.current.relative_humidity_2m, wind: r.current.wind_speed_10m, gusts: r.current.wind_gusts_10m, dir: r.current.wind_direction_10m, code: r.current.weather_code, day: !!r.current.is_day, rain: r.current.precipitation, pressure: r.current.surface_pressure, uv: r.current.uv_index, at: Date.now() },
			hours,
			days: r.daily.time.map((d, i) => ({ date: d, code: r.daily.weather_code[i], max: r.daily.temperature_2m_max[i], min: r.daily.temperature_2m_min[i], rain: r.daily.precipitation_probability_max[i], mm: r.daily.precipitation_sum[i], sunrise: r.daily.sunrise[i], sunset: r.daily.sunset[i], wind: r.daily.wind_speed_10m_max[i], gusts: r.daily.wind_gusts_10m_max[i], uv: r.daily.uv_index_max[i], daylight: r.daily.daylight_duration[i] }))
		};
	});
}

// Places by name for the location setting.
async function geocode(name, lang = "de") {
	const r = await json(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name, count: "6", language: lang })}`, { timeout: 10000 });
	return (r.results || []).map((p) => ({ name: p.name, region: [p.admin1, p.country_code].filter(Boolean).join(", "), lat: p.latitude, lon: p.longitude }));
}

// ---------- calendars (iCal) ----------

const icalCache = new Cache(15 * 60000);

function unfold(text) {
	return text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").split(/\r?\n/);
}

function unescape(v) {
	return String(v || "").replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1").trim();
}

// "20261018T100000Z" (UTC), "20261018T100000" (local), "20261018" (all day) → { t, allDay }
function parseDate(value, params) {
	const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
	if (!m) return null;
	const [, y, mo, d, h, mi, s, z] = m;
	if (!h || /VALUE=DATE(?!-)/.test(params || "")) return { t: new Date(+y, +mo - 1, +d).getTime(), allDay: true };
	return { t: z ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime(), allDay: false };
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

// Occurrences of a (simple) RRULE between from and to: DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY.
function expand(start, rule, from, to, exdates) {
	const r = Object.fromEntries(rule.split(";").map((p) => p.split("=")));
	const interval = Number(r.INTERVAL) || 1;
	const until = r.UNTIL ? (parseDate(r.UNTIL) || {}).t : Infinity;
	const max = Number(r.COUNT) || Infinity;
	const byday = r.BYDAY ? r.BYDAY.split(",").map((d) => DAYS.indexOf(d.slice(-2))) : null;
	const out = [];
	const base = new Date(start);
	let n = 0;
	for (let i = 0; i < 1500 && n < max; i++) {
		let candidates;
		const d = new Date(base);
		if (r.FREQ === "DAILY") d.setDate(base.getDate() + i * interval);
		else if (r.FREQ === "WEEKLY") d.setDate(base.getDate() + i * 7 * interval);
		else if (r.FREQ === "MONTHLY") d.setMonth(base.getMonth() + i * interval);
		else if (r.FREQ === "YEARLY") d.setFullYear(base.getFullYear() + i * interval);
		else return out;
		if (r.FREQ === "WEEKLY" && byday) {
			// the days of this week (week starts Monday)
			const monday = new Date(d);
			monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
			candidates = byday.map((wd) => {
				const x = new Date(monday);
				x.setDate(monday.getDate() + ((wd + 6) % 7));
				x.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
				return x;
			}).sort((a, b) => a - b);
		} else candidates = [d];
		for (const c of candidates) {
			const t = c.getTime();
			if (t < start) continue;
			if (t > until || n >= max) return out;
			n++;
			if (t > to) return out;
			if (t >= from && !exdates.has(t)) out.push(t);
		}
		if (d.getTime() > to) break;
	}
	return out;
}

function parseIcal(text, from, to) {
	const events = [];
	let ev = null;
	for (const line of unfold(text)) {
		if (line === "BEGIN:VEVENT") ev = { exdates: new Set() };
		else if (line === "END:VEVENT" && ev) {
			if (ev.start && ev.summary !== undefined && !/CANCELLED/i.test(ev.status || "")) {
				const dur = ev.end ? ev.end.t - ev.start.t : ev.start.allDay ? 86400000 : 0;
				const times = ev.rrule ? expand(ev.start.t, ev.rrule, from - dur, to, ev.exdates) : [ev.start.t];
				for (const t of times) if (t + dur >= from && t <= to) events.push({ t, end: t + dur, allDay: ev.start.allDay, title: ev.summary || "", where: ev.location || "" });
			}
			ev = null;
		} else if (ev) {
			const i = line.indexOf(":");
			if (i < 0) continue;
			const [name, ...params] = line.slice(0, i).split(";");
			const value = line.slice(i + 1);
			const p = params.join(";");
			if (name === "DTSTART") ev.start = parseDate(value, p);
			else if (name === "DTEND") ev.end = parseDate(value, p);
			else if (name === "SUMMARY") ev.summary = unescape(value);
			else if (name === "LOCATION") ev.location = unescape(value);
			else if (name === "RRULE") ev.rrule = value;
			else if (name === "STATUS") ev.status = value;
			else if (name === "EXDATE") for (const v of value.split(",")) {
				const d = parseDate(v, p);
				if (d) ev.exdates.add(d.t);
			}
		}
	}
	return events;
}

// webcal:// is https; a CalDAV calendar of Nextcloud gets "?export" (the whole calendar as iCal)
const webcal = (u) => {
	const x = String(u).trim().replace(/^webcals?:\/\//i, "https://");
	return /\/remote\.php\/dav\/calendars\/[^?]+$/.test(x) ? `${x.replace(/\/?$/, "/")}?export` : x;
};

// Next events of all calendars of a tile: [{ t, end, allDay, title, where, cal }]
async function calendars(list, days = 21) {
	const from = new Date();
	from.setHours(0, 0, 0, 0);
	const to = from.getTime() + days * 86400000;
	const out = [];
	const errors = [];
	await Promise.all(
		list.map(async (c, i) => {
			// private calendars (Nextcloud, Radicale, Baïkal …): user and password, sent as basic auth
			const headers = c.user || c.password ? { Authorization: `Basic ${Buffer.from(`${c.user || ""}:${c.password || ""}`).toString("base64")}` } : {};
			// the login is part of the key (as a hash): another password is another answer
			const who = c.user || c.password ? require("node:crypto").createHash("sha256").update(`${c.user || ""}:${c.password || ""}`).digest("hex").slice(0, 16) : "";
			const r = await icalCache.get(`${webcal(c.url)}|${who}`, async () => {
				const res = await request(webcal(c.url), { timeout: 15000, maxBytes: 10_000_000, redirects: 3, headers });
				if (res.status === 401 || res.status === 403) throw new Error(c.user ? "Login refused (check user and app password)" : "This calendar needs a login");
				if (res.status !== 200) throw new Error(res.error || `HTTP ${res.status}`);
				const text = res.body.toString("utf8");
				if (!/BEGIN:VCALENDAR/.test(text)) throw new Error("Not an iCal calendar");
				return { text };
			});
			if (r.error) return errors.push(`${c.name || `#${i + 1}`}: ${r.error}`);
			for (const e of parseIcal(r.text, from.getTime(), to)) out.push({ ...e, cal: i });
		})
	);
	return { events: out.sort((a, b) => a.t - b.t).slice(0, 60), errors };
}

// ---------- news (RSS / Atom) ----------

const rssCache = new Cache(15 * 60000);

function tag(xml, name) {
	const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
	return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (x, n) => String.fromCharCode(n)).trim() : "";
}

function parseFeed(xml) {
	const title = tag(xml.replace(/<(item|entry)[\s>][\s\S]*$/i, ""), "title");
	const items = [];
	for (const m of xml.matchAll(/<(item|entry)[\s>]([\s\S]*?)<\/\1>/gi)) {
		const x = m[2];
		const atom = /<link[^>]*href="([^"]+)"/i.exec(x);
		const link = tag(x, "link") || (atom ? atom[1] : "");
		const date = Date.parse(tag(x, "pubDate") || tag(x, "updated") || tag(x, "published") || tag(x, "dc:date"));
		items.push({ title: tag(x, "title"), link, date: isNaN(date) ? null : date });
	}
	return { title, items };
}

async function feeds(list) {
	const out = [];
	const errors = [];
	await Promise.all(
		list.map(async (f, i) => {
			const r = await rssCache.get(f.url, async () => {
				const res = await request(f.url, { timeout: 15000, maxBytes: 5_000_000, redirects: 3, headers: { Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" } });
				if (res.status !== 200) throw new Error(res.error || `HTTP ${res.status}`);
				const parsed = parseFeed(res.body.toString("utf8"));
				if (!parsed.items.length) throw new Error("No entries (not a feed?)");
				return parsed;
			});
			if (r.error) return errors.push(`${f.name || f.url}: ${r.error}`);
			for (const it of r.items.slice(0, 30)) out.push({ ...it, source: f.name || r.title || new URL(f.url).hostname, feed: i });
		})
	);
	return { items: out.sort((a, b) => (b.date || 0) - (a.date || 0)).slice(0, 40), errors };
}

module.exports = { weather, geocode, calendars, feeds, parseIcal, parseFeed, expand };
