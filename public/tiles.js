"use strict";
// Tile renderers: each returns { c (colour), cls, html } from the live data.
// Plain HTML strings, so a tile is only redrawn when its HTML really changed.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ICON_CDN = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons";
const COLORS = {
	jellyfin: "#a95ce0", plex: "#e5a00d", emby: "#52b54b", sonarr: "#35c5f4", radarr: "#ffc230", lidarr: "#00a65b", prowlarr: "#e66001", bazarr: "#9b59b6", overseerr: "#7b5af5", jellyseerr: "#7b5af5",
	qbittorrent: "#2f67ba", transmission: "#d70008", sabnzbd: "#f5c400", flaresolverr: "#f38020", portainer: "#13bef9", grafana: "#f46800", prometheus: "#e6522c", "uptime-kuma": "#5cdd8b",
	dozzle: "#f9c74f", "home-assistant": "#18bcf2", pihole: "#f60d1a", "adguard-home": "#68bc71", nextcloud: "#0082c9", immich: "#4250af", vaultwarden: "#175ddc", traefik: "#24a1c1",
	"nginx-proxy-manager": "#f15833", syncthing: "#0891d1", paperless: "#17541f", "paperless-ngx": "#17541f", gitea: "#609926", tailscale: "#9ca3af", proxmox: "#e57000", truenas: "#0095d5"
};
const KIND_GLYPH = { solar: "sun", mmmanager: "sliders" };
const GLYPHS = {
	sun: "<circle cx='12' cy='12' r='4.2'/><path d='M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6'/>",
	plug: "<path d='M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 01-11 0V8zM12 16.5V21'/>",
	mirror: "<rect x='6' y='2.5' width='12' height='19' rx='3'/><path d='M9.5 7.5l3-2M9.5 11l5-3.5'/>",
	sliders: "<path d='M4 7h10M18 7h2M4 17h4M12 17h8'/><circle cx='16' cy='7' r='2'/><circle cx='10' cy='17' r='2'/>",
	server: "<rect x='3.5' y='4' width='17' height='7' rx='2'/><rect x='3.5' y='13' width='17' height='7' rx='2'/><path d='M7.5 7.5h.01M7.5 16.5h.01'/>",
	globe: "<circle cx='12' cy='12' r='8.5'/><path d='M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17'/>",
	link: "<path d='M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1'/>"
};
const svg = (paths, sw = 1.8) => `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='${sw}' stroke-linecap='round' stroke-linejoin='round'>${paths}</svg>`;
const UI = {
	plus: svg("<path d='M12 5v14M5 12h14'/>", 2.2),
	x: svg("<path d='M6 6l12 12M18 6L6 18'/>", 2.4),
	gear: svg("<circle cx='12' cy='12' r='3'/><path d='M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z'/>"),
	open: svg("<path d='M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5'/>", 2),
	search: svg("<circle cx='11' cy='11' r='7'/><path d='M20 20l-3.5-3.5'/>", 2)
};

// icon: dashboard-icons name, "glyph:sun", or an image address
function iconOf(s) {
	if (s.icon) return s.icon;
	if (s.kind && KIND_GLYPH[s.kind]) return `glyph:${KIND_GLYPH[s.kind]}`;
	if (/mirror/i.test(s.name)) return "glyph:mirror";
	return slug(s.name);
}
const slug = (name) => String(name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function colorOf(s) {
	if (!s) return "var(--accent)";
	const i = iconOf(s);
	if (COLORS[i]) return COLORS[i];
	if (s.kind === "solar" || i === "glyph:sun") return "#f5b83d";
	// a calm colour from the name
	let hsh = 0;
	for (const ch of s.name) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
	return `hsl(${hsh % 360} 45% 66%)`;
}

function logo(s, cls = "logo") {
	const icon = iconOf(s);
	const c = colorOf(s);
	if (icon.startsWith("glyph:")) return `<span class="${cls}" style="--c:${c}">${svg(GLYPHS[icon.slice(6)] || GLYPHS.globe)}</span>`;
	const src = /^https?:\/\//.test(icon) ? icon : `${ICON_CDN}/svg/${encodeURIComponent(icon)}.svg`;
	const png = /^https?:\/\//.test(icon) ? "" : `${ICON_CDN}/png/${encodeURIComponent(icon)}.png`;
	// svg → png → first letter
	const fallback = `if(this.dataset.p&&!this.dataset.t){this.dataset.t=1;this.src=this.dataset.p}else{this.parentNode.textContent=${esc(JSON.stringify((s.name || "?")[0].toUpperCase()))}}`;
	return `<span class="${cls}" style="--c:${c}"><img src="${esc(src)}" data-p="${esc(png)}" alt="" loading="lazy" onerror="${fallback}"></span>`;
}

// ---------- formatting ----------

const nf = (v, d = 0) => Number(v).toLocaleString(LOCALE, { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtMs = (ms) => (ms === null || ms === undefined ? "–" : ms >= 1000 ? `${nf(ms / 1000, 1)} s` : `${ms} ms`);
function fmtBytes(b) {
	if (b === null || b === undefined) return "–";
	const u = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	while (b >= 1000 && i < u.length - 1) (b /= 1000), i++;
	return `${nf(b, b < 10 && i > 1 ? 1 : 0)} ${u[i]}`;
}
const fmtSpeed = (b) => `${nf((b || 0) / 1e6, (b || 0) < 1e7 ? 1 : 0)} MB/s`;
const fmtW = (w) => (w === null || w === undefined ? "–" : w >= 1000 ? `${nf(w / 1000, 1)} kW` : `${Math.round(w)} W`);
const fmtWh = (wh) => (wh === null || wh === undefined ? "–" : `${nf(wh / 1000, 1)} kWh`);
function fmtDuration(ms) {
	const m = Math.round(ms / 60000);
	if (m < 1) return t("time.now");
	if (m < 60) return t("time.min", { n: m });
	const hrs = Math.round(m / 60);
	if (hrs < 48) return t("time.h", { n: hrs });
	const d = Math.round(hrs / 24);
	return d === 1 ? t("time.d1") : t("time.d", { n: d });
}
function fmtEta(s) {
	if (s === null || s === undefined) return "∞";
	if (s < 60) return `${s} s`;
	if (s < 3600) return `${Math.round(s / 60)} min`;
	return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
// "vor 3 h", "gestern", "Mo 13.10."
function fmtAgo(ts) {
	const diff = Date.now() - ts;
	if (diff < 24 * 3600000) return t("time.ago", { t: fmtDuration(diff) });
	if (diff < 48 * 3600000) return t("time.yesterday");
	return new Date(ts).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "numeric" });
}

// "Heute 21:00", "Morgen 20:00", "Mi 23.10."
function fmtWhen(ts, withTime = true) {
	const d = new Date(ts);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	const diff = Math.floor((d - today) / 86400000);
	const time = d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
	const timed = withTime && !(d.getHours() === 0 && d.getMinutes() === 0);
	if (diff === 0) return `${t("cal.today")}${timed ? ` ${time}` : ""}`;
	if (diff === 1) return `${t("cal.tomorrow")}${timed ? ` ${time}` : ""}`;
	return d.toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "numeric" });
}

function spark(values) {
	const v = values.filter((x) => x !== null && x !== undefined);
	if (v.length < 2) return "";
	const w = 120, hh = 30, max = Math.max(...v) * 1.15 || 1;
	const step = w / (values.length - 1);
	let d = "";
	values.forEach((x, i) => {
		if (x === null || x === undefined) return;
		const y = hh - (x / max) * (hh - 2);
		d += `${d && values[i - 1] !== null && values[i - 1] !== undefined ? "L" : "M"}${(i * step).toFixed(1)},${y.toFixed(1)}`;
	});
	return `<svg class="spark" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// points: [[minuteOfDay, value]], drawn over the whole day
function dayCurve(points, color, id) {
	if (!points || points.length < 2) return "";
	const w = 288, hh = 60, max = Math.max(...points.map((p) => p[1]), 1) * 1.1;
	const xy = points.map(([m, v]) => [(m / 1440) * w, hh - (v / max) * (hh - 2)]);
	const d = xy.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
	const last = xy[xy.length - 1];
	return `<svg class="curve" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><defs><linearGradient id="g${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" style="stop-color:${color}" stop-opacity=".35"/><stop offset="1" style="stop-color:${color}" stop-opacity="0"/></linearGradient></defs><path d="${d}L${last[0].toFixed(1)},${hh}L${xy[0][0].toFixed(1)},${hh}Z" fill="url(#g${id})"/><path d="${d}" fill="none" style="stroke:${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
}

// ---------- what a service is doing, in a few words ----------

function statLine(s, st, d) {
	if (!st || st.status === "pending") return t("status.checking");
	if (st.status === "down") return st.error || t("status.down");
	const data = d && d.data;
	if (data) {
		if (s.kind === "jellyfin") {
			if (data.now.length) return data.now.length === 1 ? t("jf.watching", { n: data.now[0].user }) : t("jf.watchingN", { n: data.now.length });
			if (data.counts) return t("jf.library", { m: nf(data.counts.movies), s: nf(data.counts.series) });
		}
		if (s.kind === "sonarr" || s.kind === "radarr") {
			const today = data.items.filter((i) => fmtWhen(i.at, false) === t("cal.today")).length;
			if (today) return t("cal.todayN", { n: today });
			const next = data.items.find((i) => i.at > Date.now());
			if (next) return t("cal.next", { d: fmtWhen(next.at, false) });
		}
		if (s.kind === "prowlarr") return t("arr.indexers", { n: data.enabled });
		if (s.kind === "qbittorrent") return data.torrents.length ? `↓ ${fmtSpeed(data.down)}` : t("dl.idle");
		if (s.kind === "solar" && data.pv !== null) return fmtW(data.pv);
		if (data.summary && Array.isArray(data.metrics)) return data.summary;
		if (s.kind === "mmmanager" && data.process) return `${data.process === "online" ? t("mm.online") : data.process}${data.version ? ` · ${data.version}` : ""}`;
	}
	if (st.status === "unknown") return t("status.unknown");
	return fmtMs(st.ms);
}

// Key figures of a service, shown as a row of numbers with labels.
function metrics(s, st, d, max = 3) {
	const data = d && d.data;
	const m = (v, l, cls) => ({ v: v === null || v === undefined ? "–" : String(v), l, cls });
	let out = null;
	// plugins bring their own figures
	if (data && Array.isArray(data.metrics)) out = data.metrics.map((x) => m(x.value !== null && typeof x.value === "object" ? L(x.value) : x.value, L(x.label), x.warn ? "warn" : ""));
	else if (data) {
		if (s.kind === "jellyfin") out = [m(data.now.length, t("m.streams")), m(data.counts && nf(data.counts.movies), t("m.movies")), m(data.counts && nf(data.counts.series), t("m.series")), m(data.sessions, t("m.sessions"))];
		if (s.kind === "sonarr") out = [m(data.library !== null ? nf(data.library) : null, t("m.series")), m(data.queue, t("m.queue")), m(data.wanted !== null ? nf(data.wanted) : null, t("m.wanted")), m(data.warnings.length, t("m.warnings"), data.warnings.length ? "warn" : "")];
		if (s.kind === "radarr") out = [m(data.library !== null ? nf(data.library) : null, t("m.movies")), m(data.queue, t("m.queue")), m(data.wanted !== null ? nf(data.wanted) : null, t("m.wanted")), m(data.warnings.length, t("m.warnings"), data.warnings.length ? "warn" : "")];
		if (s.kind === "qbittorrent") out = [m(nf((data.down || 0) / 1e6, 1), "↓ MB/s"), m(nf((data.up || 0) / 1e6, 1), "↑ MB/s"), m(data.downloading, t("m.loading")), m(data.seeding, t("m.seeding"))];
		if (s.kind === "prowlarr") out = [m(data.enabled, t("m.indexers")), m(data.failing, t("m.failing"), data.failing ? "warn" : ""), m(data.warnings.length, t("m.warnings"), data.warnings.length ? "warn" : "")];
		if (s.kind === "solar") out = [m(data.pv !== null ? nf(data.pv / 1000, 1) : null, "kW"), m(data.todayWh !== null ? nf(data.todayWh / 1000, 1) : null, t("m.todayKwh")), m(data.battery !== null ? `${data.battery} %` : null, t("m.battery")), m(data.use !== null ? nf(data.use / 1000, 1) : null, t("m.houseKw"))];
		if (s.kind === "mystrom") out = [m(data.devices.filter((d) => d.on).length, t("m.on")), m(Math.round(data.watts), "W"), m(data.todayWh !== null ? nf(data.todayWh / 1000, 2) : null, t("m.todayKwh"))];
		if (s.kind === "magicmirror") out = [m(data.modules, t("m.modules")), m(data.version, "Version"), m(data.started ? fmtDuration(Date.now() - data.started) : null, t("m.running"))];
		if (s.kind === "mmmanager") out = [m(data.process === "online" ? t("mm.online") : data.process, t("m.state"), data.process && data.process !== "online" ? "warn" : ""), m(data.version, "Version"), m(data.restarts, t("m.restarts"))];
	}
	if (!out) {
		const c = st && st.container;
		const up = st && st.uptime !== null && st.uptime !== undefined ? `${nf(st.uptime, st.uptime === 100 ? 0 : 1)} %` : null;
		const since = st && st.since && st.status === "up" ? fmtDuration(Date.now() - st.since) : null;
		out = c && c.state === "running" && c.cpu !== undefined
			? [m(c.cpu !== null ? `${nf(c.cpu, c.cpu < 10 ? 1 : 0)} %` : null, "CPU"), m(c.memory ? fmtBytes(c.memory) : null, t("m.memory")), m(st.ms !== null && st.ms !== undefined ? fmtMs(st.ms) : null, t("m.response")), m(up, t("m.online24"), st.uptime < 99 ? "warn" : "")]
			: [m(st && st.ms !== null && st.ms !== undefined ? fmtMs(st.ms) : null, t("m.response")), m(up, t("m.online24"), st && st.uptime < 99 ? "warn" : ""), m(since, t("m.running"))];
	}
	return out.slice(0, max);
}
// The key figures as one short line for the service list: "6 Filme · 0 Fehlend"
function listStat(s, st, d) {
	const data = d && d.data;
	const m = metrics(s, st, d, 4);
	if (!data && !(st && st.container && st.container.cpu !== undefined)) {
		if (st && st.container && st.container.status) return st.container.status;
		return st && st.since && st.status === "up" && Date.now() - st.since > 10 * 60000 ? t("status.since", { t: fmtDuration(Date.now() - st.since) }) : "";
	}
	const say = (x) => (x.l === "CPU" ? `CPU ${x.v}` : x.l === "Version" ? `v${x.v}` : x.l === t("m.state") ? x.v : x.l === t("m.running") ? t("status.since", { t: x.v }) : `${x.v} ${x.l}`);
	return m.filter((x) => x.v !== "–" && !/^(Response|Antwort|up 24 h|online 24 h)$/.test(x.l)).slice(0, 3).map(say).join(" · ");
}

const metricsHtml = (list) => `<div class="metrics" style="--mc:${list.length}">${list.map((x) => `<div class="${x.cls || ""}"><div class="v" title="${esc(x.v)}">${esc(x.v)}</div><div class="l">${esc(x.l)}</div></div>`).join("")}</div>`;

// One line under the name: what the service is doing right now, or its address.
function subLine(s, st, d) {
	if (!st || st.status === "pending") return { text: t("status.checking") };
	if (st.status === "down") return { text: st.error || t("status.down"), cls: "bad" };
	if (d && d.error) return { text: d.error, cls: "warn" };
	const data = d && d.data;
	if (data) {
		if (s.kind === "jellyfin" && data.now.length) return { text: t("jf.plays", { u: data.now[0].user, t: data.now[0].title }) };
		if ((s.kind === "sonarr" || s.kind === "radarr") && data.items) {
			const next = data.items.find((i) => i.at > Date.now());
			if (next) return { text: `${fmtWhen(next.at, false)} · ${next.title}` };
		}
		if (s.kind === "qbittorrent" && data.torrents.length) return { text: data.torrents[0].name };
		if (s.kind === "solar" && data.use !== null) return { text: t("solar.use", { v: fmtW(data.use) }) };
		if (data.summary) return { text: data.summary };
	}
	const addr = s.url ? s.url.replace(/^https?:\/\//, "") : t("status.unknown");
	return { text: st.ms !== null && st.ms !== undefined ? `${fmtMs(st.ms)} · ${addr}` : addr, cls: "faint" };
}

function setupHint(s, d) {
	if (!d || !d.error) return "";
	return `<div class="setup"><span>${esc(d.error)}</span><button class="btn" data-setup="${esc(s.id)}">${t("setup.needed")}</button></div>`;
}

// Bigger service tiles: a few more lines (next items, warnings, container state).
function moreLines(s, st, d) {
	const lines = [];
	const data = d && d.data;
	if (data && data.warnings) for (const w of data.warnings.slice(0, 2)) lines.push(`<div class="s warn" title="${esc(w)}">⚠ ${esc(w)}</div>`);
	if (data && Array.isArray(data.metrics) && data.items) for (const i of data.items.slice(0, 3)) lines.push(`<div class="s pl-item"><i class="st-dot ${esc(i.status || "")}"></i><span>${esc(i.title)}</span>${i.sub ? `<span class="faint">${esc(i.sub)}</span>` : ""}</div>`);
	else if (data && data.items) for (const i of data.items.filter((x) => x.at > Date.now()).slice(0, 2)) lines.push(`<div class="s">${esc(fmtWhen(i.at, false))} · ${esc(i.title)}</div>`);
	if (st.container && st.container.status) lines.push(`<div class="s faint">${esc(st.container.status)}</div>`);
	return lines.slice(0, 3).join("");
}

// ---------- notes (Markdown) ----------

// older tiles kept a list of entries; it reads as a checklist
const notesText = (tile) => (typeof tile.text === "string" ? tile.text : (tile.notes || []).map((n) => `- [${n.done ? "x" : " "}] ${n.text}`).join("\n"));

// A small, safe Markdown: headings, lists, tasks (- [ ] / - [x]), **bold**, *italic*, `code`, links.
// *italic*, **bold**, ***both*** – also nested ("**bold *and italic***"). A star opens when text
// follows it and closes when text comes before it; anything that doesn't add up stays as typed.
function emphasis(s) {
	const parts = s.split(/(\*{1,3})/);
	const open = [];
	let out = "";
	for (let i = 0; i < parts.length; i++) {
		const p = parts[i];
		if (!/^\*+$/.test(p)) {
			out += p;
			continue;
		}
		const before = out.slice(-1);
		const after = (parts[i + 1] || "").charAt(0);
		const canClose = before && !/\s/.test(before);
		const canOpen = after && !/\s/.test(after);
		const tags = p.length === 3 ? ["b", "i"] : p.length === 2 ? ["b"] : ["i"];
		if (canClose && tags.every((tg) => open.includes(tg))) {
			// close the innermost first
			for (const tg of [...open].reverse().filter((x) => tags.includes(x))) {
				out += `</${tg}>`;
				open.splice(open.lastIndexOf(tg), 1);
			}
		} else if (canOpen && !tags.some((tg) => open.includes(tg))) {
			for (const tg of tags) (out += `<${tg}>`), open.push(tg);
		} else out += p;
	}
	// something left open: show the text as it was typed
	return open.length ? s : out;
}

function markdown(src) {
	const inline = (s) =>
		emphasis(esc(s).replace(/`([^`]+)`/g, "<code>$1</code>"))
			.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
			.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
	const out = [];
	let list = null;
	const close = () => list && (out.push(`</${list}>`), (list = null));
	src.split("\n").forEach((line, i) => {
		let m;
		if ((m = /^\s*(?:[-*]\s+)?\[([ xX])\]\s*(.*)$/.exec(line))) {
			if (list !== "ul") (close(), out.push('<ul class="tasks">'), (list = "ul"));
			const done = m[1] !== " ";
			out.push(`<li class="task${done ? " done" : ""}"><input type="checkbox" data-line="${i}"${done ? " checked" : ""}><span>${inline(m[2])}</span></li>`);
		} else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
			if (list !== "ul") (close(), out.push("<ul>"), (list = "ul"));
			out.push(`<li>${inline(m[1])}</li>`);
		} else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
			if (list !== "ol") (close(), out.push("<ol>"), (list = "ol"));
			out.push(`<li>${inline(m[1])}</li>`);
		} else if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
			close();
			out.push(`<h${m[1].length + 3}>${inline(m[2])}</h${m[1].length + 3}>`);
		} else if (!line.trim()) close();
		else {
			close();
			out.push(`<p>${inline(line)}</p>`);
		}
	});
	close();
	return out.join("");
}

// Subscribed repositories with their newest release: updates first (the container runs an older
// version), then "new" ones (no known version, not looked at yet – without a record: released in
// the last 14 days), then the rest by date.
function releaseItems(tile, data) {
	const seen = tile.seen || {};
	return (tile.repos || [])
		.map((repo) => {
			const d = data[repo];
			const l = d && d.latest;
			// with the running version known the comparison says it all (update or current)
			const update = !!(d && d.current === false);
			const known = d && (d.current === true || d.current === false);
			const isNew = !known && !!(l && (seen[repo] ? seen[repo] !== l.tag : l.date && Date.now() - l.date < 14 * 86400000));
			return { repo, d, isNew, update, date: (l && l.date) || 0 };
		})
		.sort((a, b) => b.update - a.update || b.isNew - a.isNew || b.date - a.date);
}

// Where a calendar entry comes from: the small logo of Sonarr / Radarr instead of a coloured dot.
function srcLogo(x, i) {
	const s = i.sid && x.service(i.sid);
	return s ? logo(s, "logo src-logo").replace("<span ", `<span title="${esc(s.name)}" `) : "";
}

// ---------- weather ----------

// WMO weather codes → icon and words
const WX_ICONS = {
	sun: ["<circle cx='12' cy='12' r='4.2'/><path d='M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6'/>", "#f5b83d"],
	moon: ["<path d='M19.5 14.5A7.5 7.5 0 019.5 4.5a7.5 7.5 0 1010 10z'/>", "#c9d3ff"],
	partly: ["<path d='M8 2.8v1.4M2.8 8h1.4M4.3 4.3l1 1M11.7 4.3l-1 1'/><circle cx='8' cy='8' r='2.6'/><path d='M9 19.5h8a3.6 3.6 0 00.4-7.2 5 5 0 00-9.3-.9A4 4 0 009 19.5z'/>", "#f5b83d"],
	partlyNight: ["<path d='M11.5 8.5A4.5 4.5 0 015.6 3a4.5 4.5 0 105.9 5.5z'/><path d='M9 19.5h8a3.6 3.6 0 00.4-7.2 5 5 0 00-9.3-.9A4 4 0 009 19.5z'/>", "#c9d3ff"],
	cloud: ["<path d='M7 18.5h10a4.2 4.2 0 00.5-8.4 6 6 0 00-11.2-1.2A4.8 4.8 0 007 18.5z'/>", "var(--muted)"],
	fog: ["<path d='M4 8h16M6 12h12M4 16h16M8 20h8'/>", "var(--muted)"],
	rain: ["<path d='M7 15h10a4.2 4.2 0 00.5-8.4 6 6 0 00-11.2-1.2A4.8 4.8 0 007 15z'/><path d='M8.5 18l-1 2.5M12.5 18l-1 2.5M16.5 18l-1 2.5'/>", "#6fb3ff"],
	snow: ["<path d='M7 15h10a4.2 4.2 0 00.5-8.4 6 6 0 00-11.2-1.2A4.8 4.8 0 007 15z'/><path d='M8 18.5h.01M12 18.5h.01M16 18.5h.01M10 21h.01M14 21h.01'/>", "#dfe8ff"],
	storm: ["<path d='M7 15h10a4.2 4.2 0 00.5-8.4 6 6 0 00-11.2-1.2A4.8 4.8 0 007 15z'/><path d='M12.5 15.5l-2 3h3l-2 3'/>", "#c792ea"]
};
function wxKind(code, day = true) {
	if (code === 0 || code === 1) return day ? "sun" : "moon";
	if (code === 2) return day ? "partly" : "partlyNight";
	if (code === 3) return "cloud";
	if (code === 45 || code === 48) return "fog";
	if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
	if (code >= 95) return "storm";
	if (code >= 51) return "rain";
	return "cloud";
}
const wxIcon = (code, day, cls = "wx-i") => {
	const [paths, color] = WX_ICONS[wxKind(code, day)];
	return `<span class="${cls}" style="color:${color}">${svg(paths, 1.7)}</span>`;
};
const wxText = (code) => {
	const groups = [[[0], "clear"], [[1], "mostlyClear"], [[2], "partly"], [[3], "cloudy"], [[45, 48], "fog"], [[51, 53, 55, 56, 57], "drizzle"], [[61, 63, 66], "rain"], [[65, 67], "heavyRain"], [[71, 73, 75, 77], "snow"], [[80, 81, 82], "showers"], [[85, 86], "snowShowers"], [[95, 96, 99], "storm"]];
	const g = groups.find(([codes]) => codes.includes(code));
	return t(`wx.${g ? g[1] : "cloudy"}`);
};
const deg = (v) => (v === null || v === undefined ? "–" : `${Math.round(v)}°`);

// ---------- network chart ----------

// [[t, rx, tx]] as two areas (download up, upload down), bytes per second
function netChart(points, id) {
	const pts = (points || []).filter((p) => p[1] !== null && p[2] !== null);
	if (pts.length < 2) return "";
	const w = 300, hh = 80, mid = hh * 0.62;
	const maxRx = Math.max(...pts.map((p) => p[1]), 1) * 1.1;
	const maxTx = Math.max(...pts.map((p) => p[2]), 1) * 1.1;
	const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1;
	const x = (tt) => (((tt - t0) / (t1 - t0 || 1)) * w).toFixed(1);
	const up = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0])},${(mid - (p[1] / maxRx) * (mid - 2)).toFixed(1)}`).join("");
	const down = pts.map((p, i) => `${i ? "L" : "M"}${x(p[0])},${(mid + (p[2] / maxTx) * (hh - mid - 2)).toFixed(1)}`).join("");
	const close = (d) => `${d}L${x(t1)},${mid}L${x(t0)},${mid}Z`;
	return `<svg class="net-chart" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><path d="${close(up)}" style="fill:var(--accent)" fill-opacity=".22"/><path d="${up}" fill="none" style="stroke:var(--accent)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><path d="${close(down)}" fill="#5fd39a" fill-opacity=".18"/><path d="${down}" fill="none" stroke="#5fd39a" stroke-width="1.4" vector-effect="non-scaling-stroke" stroke-linejoin="round"/><path d="M0,${mid}H${w}" stroke="rgba(255,255,255,.08)" vector-effect="non-scaling-stroke"/></svg>`;
}

const optsHint = (text) => `<div class="opts-hint"><span>${esc(text)}</span><button class="btn" data-tile-opts>${t("tile.setUp")}</button></div>`;

// "Arcane.S02.2160p.WEB-DL.DDP5.1.Atmos" → { title: "Arcane", sub: "Staffel 2 · 4K" }
function releaseName(raw) {
	const name = String(raw || "").replace(/\.(mkv|mp4|avi|iso|zip|rar|7z|tar|gz)$/i, "");
	const words = name.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
	const res = /\b(2160p|4k|uhd|1080p|720p|576p|480p)\b/i.exec(words);
	const quality = res ? (/2160p|4k|uhd/i.test(res[1]) ? "4K" : res[1].toLowerCase()) : "";
	const ep = /\bS(\d{1,2})(?:\s?E(\d{1,3}))?\b/i.exec(words);
	const year = /\b(19[3-9]\d|20[0-4]\d)\b/.exec(words);
	// the title ends where episode, year or quality starts
	const cut = Math.min(...[ep, year, res].filter(Boolean).map((m) => m.index));
	if (!Number.isFinite(cut) || cut === 0) return { title: name, sub: "" };
	const title = words.slice(0, cut).replace(/[\s(\[-]+$/, "");
	const parts = [ep ? (ep[2] ? `S${Number(ep[1])} · E${Number(ep[2])}` : t("dl.season", { n: Number(ep[1]) })) : "", year && !ep ? year[1] : "", quality].filter(Boolean);
	return { title, sub: parts.join(" · ") };
}

// ---------- tiles ----------

const TILES = {
	service(tile, x) {
		const s = x.service(tile.service);
		if (!s) return null;
		const st = x.live.status[s.id] || { status: "pending" };
		const d = x.live.data[s.id];
		const tag = st.status === "down" ? `<span class="tag down">${t("tag.down")}</span>` : st.status === "slow" ? `<span class="tag slow">${t("tag.slow")}</span>` : "";
		const sub = subLine(s, st, d);
		const head = `<div class="head">${logo(s)}<div class="txt"><div class="n">${esc(s.name)}</div><div class="s ${sub.cls || ""}" title="${esc(sub.text)}">${esc(sub.text)}</div></div>${tag}</div>`;
		const nums = metricsHtml(metrics(s, st, d, tile.w === 1 ? 2 : 4));
		if (tile.h === 1) return { c: colorOf(s), cls: `mini ${st.status}`, html: head + nums };
		const extra = moreLines(s, st, d);
		const sp = st.recent && st.status !== "down" ? `<div class="bottom">${spark(st.recent)}</div>` : "";
		return { c: colorOf(s), cls: `mini ${st.status}`, html: `${head}${nums}<div class="more">${extra}</div>${sp}` };
	},

	recent(tile, x) {
		const s = x.service(tile.service) || x.ofKind("jellyfin")[0];
		if (!s) return { html: `<div class="th"><span class="n">${t("jf.recent")}</span></div>` };
		const d = x.live.data[s.id];
		const head = `<div class="th">${logo(s)}<span class="n">${t("jf.recent")}</span><span class="meta">${esc(s.name)}</span></div>`;
		if (!d || !d.data) return { c: colorOf(s), html: head + setupHint(s, d) };
		const cols = tile.w === 1 ? 2 : tile.w === 2 ? 4 : 6;
		const rows = Math.max(1, tile.h - (tile.w === 1 ? 0 : 1)) || 1;
		const list = d.data.recent.slice(0, cols * rows);
		return { c: colorOf(s), html: `${head}<div class="posters" style="--pc:${cols}">${list.map((r) => `<div class="poster img" data-media="${s.id}|${esc(r.id)}" style="background-image:url('/api/img/${s.id}/${r.id}')" title="${esc(r.title)}">${esc(r.title)}</div>`).join("")}</div>` };
	},

	notes(tile) {
		const text = notesText(tile);
		const done = /^\s*(?:[-*]\s+)?\[[xX]\]/m.test(text);
		const archived = (tile.archive || []).length;
		const buttons = done || archived ? `<div class="md-btns">${done ? `<button class="md-clear" data-md-clear>${t("notes.archiveDone")}</button>` : ""}${archived ? `<button class="md-clear" data-md-archive>${t("notes.archive", { n: archived })}</button>` : ""}</div>` : "";
		return { c: "#f5b83d", cls: "notes-tile", html: `<div class="md" data-md title="${t("notes.hint")}">${text.trim() ? markdown(text) : `<p class="faint">${t("notes.hint")}</p>`}</div>${buttons}` };
	},

	status(tile, x) {
		const all = x.services();
		const bad = all.filter((s) => ["down", "slow"].includes((x.live.status[s.id] || {}).status));
		const checking = all.some((s) => !x.live.status[s.id] || x.live.status[s.id].status === "pending");
		const head = !all.length ? t("status.noServices") : bad.length ? (bad.length === 1 ? t("status.problem") : t("status.problems", { n: bad.length })) : checking ? t("status.checking") : t("status.allOk");
		const names = bad.map((s) => `${esc(s.name)} ${(x.live.status[s.id] || {}).status === "down" ? t("status.down") : t("status.slow")}`).join(" · ");
		return { c: bad.some((s) => x.live.status[s.id].status === "down") ? "#ff6066" : bad.length ? "#f5b83d" : "#5fd39a", html: `<div class="th"><span class="n">${t("status.title")}</span><span class="meta">${all.length ? `${all.length - bad.length}/${all.length}` : ""}</span></div><div class="status-big">${head}</div><div class="sm muted bottom" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${names}</div>` };
	},

	host(tile, x) {
		const h = x.live.host;
		if (!h) return { html: `<div class="th"><span class="n">${esc(x.hostName)}</span></div>` };
		const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
		const bar = (k, v, text) => `<div class="b"><div class="top"><span>${k}</span><span class="num">${text}</span></div><div class="track"><div class="fill${v > 85 ? " hot" : ""}" style="width:${v}%"></div></div></div>`;
		const mem = pct(h.memUsed, h.memTotal);
		const disk = pct(h.diskUsed, h.diskTotal);
		const rows = [bar(t("host.cpu"), h.cpu, `${h.cpu} %`), bar(t("host.memory"), mem, `${mem} %`)];
		if (tile.h > 1 && h.diskTotal) rows.push(bar(t("host.disk"), disk, t("host.of", { a: fmtBytes(h.diskUsed), b: fmtBytes(h.diskTotal) })));
		if (tile.h > 1 && h.net) rows.push(`<div class="b"><div class="top"><span>${t("host.net")}</span><span class="num">↓ ${fmtBytes(h.net.rx)}/s · ↑ ${fmtBytes(h.net.tx)}/s</span></div></div>`);
		const meta = [h.temp !== null ? `${h.temp}°` : "", t("host.up", { t: fmtDuration(h.uptime) })].filter(Boolean).join(" · ");
		return { c: "var(--accent)", html: `<div class="th"><span class="n">${esc(h.name)}</span><span class="meta">${esc(meta)}</span></div><div class="bars">${rows.join("")}</div>` };
	},

	uptime(tile, x) {
		// problems first, then by name; one compact row each with the 24 h share on the right
		const score = (s) => {
			const u = (x.live.status[s.id] || {}).uptime;
			return u === null || u === undefined ? 101 : u;
		};
		const list = x.services().filter((s) => s.check !== false && s.url).sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
		const n = Math.max(1, tile.h * 6 - 4);
		const rows = list.slice(0, n).map((s) => {
			const u = (x.live.status[s.id] || {}).uptime;
			const cells = (x.live.hours[s.id] || []).map((b) => `<i class="${b.ok === null ? "" : b.ok >= 0.999 ? "ok" : b.ok > 0 ? "part" : "bad"}"></i>`).join("");
			return `<span class="nm">${esc(s.name)}</span><div class="cells">${cells}</div><span class="pc${u !== null && u !== undefined && u < 99 ? " warn" : ""}">${u === null || u === undefined ? "–" : `${nf(u, u === 100 ? 0 : 1)} %`}</span>`;
		});
		const more = list.length > n ? `<div class="sm faint">${t("uptime.more", { n: list.length - n })}</div>` : "";
		const legend = `<div class="heat-legend"><i class="ok"></i>${t("uptime.ok")}<i class="part"></i>${t("uptime.part")}<i class="bad"></i>${t("uptime.bad")}<i></i>${t("uptime.noData")}</div>`;
		return { c: "#5fd39a", html: `<div class="th"><span class="n">${t("uptime.title")}</span><span class="meta">${t("uptime.hours")}</span></div>${rows.length ? `<div class="heat">${rows.join("")}</div>${more}<div class="bottom">${legend}</div>` : `<div class="sm faint bottom">${t("uptime.none")}</div>`}` };
	},

	jellyfin(tile, x) {
		const s = x.service(tile.service) || x.ofKind("jellyfin")[0];
		if (!s) return { html: `<div class="th"><span class="n">Jellyfin</span></div>` };
		const d = x.live.data[s.id];
		const head = `<div class="th">${logo(s)}<span class="n">${esc(s.name)}</span><span class="meta">${esc(statLine(s, x.live.status[s.id], d))}</span></div>`;
		if (!d || !d.data) return { c: colorOf(s), html: head + setupHint(s, d) };
		const data = d.data;
		const img = (id) => `/api/img/${s.id}/${id}`;
		// who watches what: one compact row each (several people at once fit too)
		const nowRow = (p) => `<div class="nowp"><div class="art" data-media="${s.id}|${esc(p.image)}" style="background-image:url('${img(p.image)}')"></div><div class="nowp-txt"><div class="title">${esc(p.title)}</div><div class="sm muted nowp-sub">${esc([p.episode ? `S${p.episode.season} · E${p.episode.number} · ${p.episode.name}` : p.year || "", `${p.user} · ${p.device}`, p.paused ? t("jf.paused") : ""].filter(Boolean).join(" · "))}</div>${p.progress !== null ? `<div class="prog"><i style="width:${(p.progress * 100).toFixed(1)}%"></i></div>` : ""}</div></div>`;
		let now = "";
		const maxNow = tile.h === 1 ? 1 : tile.h === 2 ? 2 : 3;
		if (tile.h > 1 || !data.recent.length || data.now.length) {
			now = data.now.length
				? `<div class="nowps">${data.now.slice(0, maxNow).map(nowRow).join("")}${data.now.length > maxNow ? `<div class="sm faint">${t("jf.more", { n: data.now.length - maxNow })}</div>` : ""}</div>`
				: `<div class="sm faint" style="margin:8px 0 4px">${t("jf.nothing")}</div>`;
		}
		// a separate "recently added" tile on the same page: don't show the posters twice
		const separate = x.tiles.some((o) => o.type === "recent" && (o.service || (x.ofKind("jellyfin")[0] || {}).id) === s.id);
		const recent = !separate && tile.h > 1 ? data.recent.slice(0, 14) : [];
		const posterList = `<div class="jf-posters">${recent.map((r) => `<div class="poster img" data-media="${s.id}|${esc(r.id)}" style="background-image:url('${img(r.id)}')" title="${esc(r.title)}">${esc(r.title)}</div>`).join("")}</div>`;
		// who watches on top, the posters below take the height that's left
		const posters = recent.length ? `${data.now.length < 2 ? `<div class="sm muted jf-rec">${t("jf.recent")}</div>` : ""}${posterList}` : "";
		return { c: colorOf(s), cls: "jf-tile", html: head + now + posters };
	},

	calendar(tile, x) {
		const srcs = x.ofKind("sonarr").concat(x.ofKind("radarr"));
		const items = [];
		const errors = [];
		for (const s of srcs) {
			const d = x.live.data[s.id];
			if (d && d.data) for (const i of d.data.items) items.push({ ...i, sid: s.id, color: colorOf(s) });
			else if (d && d.error) errors.push(s);
		}
		const upcoming = items.filter((i) => i.at > Date.now() - 6 * 3600000).sort((a, b) => a.at - b.at).slice(0, tile.h * 2 + (tile.h > 2 ? 1 : 0));
		const head = `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("cal.title")}</span><span class="meta">${srcs.map((s) => esc(s.name)).join(" · ")}</span></div>`;
		if (!srcs.length) return { c: "#35c5f4", html: `${head}<div class="sm faint bottom">${t("cal.needs")}</div>` };
		if (!items.length && errors.length) return { c: "#35c5f4", html: head + setupHint(errors[0], x.live.data[errors[0].id]) };
		if (!upcoming.length) {
			// nothing coming: show what arrived last instead of an empty tile
			const recent = [];
			for (const s of srcs) {
				const d = x.live.data[s.id];
				if (d && d.data && d.data.imported) for (const i of d.data.imported) recent.push({ ...i, src: s.kind, sid: s.id, color: colorOf(s) });
			}
			recent.sort((a, b) => b.at - a.at);
			const rows = recent.slice(0, tile.h * 2 + (tile.h > 2 ? 1 : 0)).map((i) => `<div class="e"${i.ref ? ` data-media="${esc(i.sid)}|${esc(i.ref)}"` : ""}><span class="w">${esc(fmtAgo(i.at))}</span><div class="mid"><div class="tt">${esc(i.title)}</div><div class="ss">${i.src === "sonarr" && i.sub ? `S${i.sub.season} · E${i.sub.number}${i.sub.name ? ` · ${esc(i.sub.name)}` : ""}` : `${t("cal.film")}${i.sub && i.sub.year ? ` · ${i.sub.year}` : ""}`}</div></div>${srcLogo(x, i)}</div>`);
			const head2 = `<div class="th"><span class="n">${t("cal.imported")}</span><span class="meta">${t("cal.noneShort")}</span></div>`;
			return { c: "#35c5f4", html: rows.length ? `${head2}<div class="cal">${rows.join("")}</div>` : `${head}<div class="sm faint bottom">${t("cal.none")}</div>` };
		}
		const sub = (i) => (i.src === "sonarr" ? `S${i.sub.season} · E${i.sub.number}${i.sub.name ? ` · ${esc(i.sub.name)}` : ""}` : `${t("cal.film")} · ${t(`cal.${i.sub.release}`)}`);
		const rows = upcoming.map((i) => {
			const w = fmtWhen(i.at);
			return `<div class="e"${i.ref ? ` data-media="${esc(i.sid)}|${esc(i.ref)}"` : ""}><span class="w${w.startsWith(t("cal.today")) ? " today" : ""}">${esc(w)}</span><div class="mid"><div class="tt">${esc(i.title)}</div><div class="ss">${sub(i)}</div></div>${i.has ? `<span class="has">✓</span>` : ""}${srcLogo(x, i)}</div>`;
		});
		return { c: "#35c5f4", html: `${head}<div class="cal">${rows.join("")}</div>` };
	},

	downloads(tile, x) {
		const s = x.service(tile.service) || x.ofKind("qbittorrent")[0];
		if (!s) return { html: `<div class="th"><span class="n">${t("dl.title")}</span></div>` };
		const d = x.live.data[s.id];
		const head = (meta) => `<div class="th">${logo(s)}<span class="n">${t("dl.title")}</span><span class="meta num">${meta}</span></div>`;
		if (!d || !d.data) return { c: colorOf(s), html: head("") + setupHint(s, d) };
		const data = d.data;
		// as many rows as fit (about 42 px each)
		const fit = Math.max(1, Math.floor((tile.h * 118 + (tile.h - 1) * 12 - 62 + 9) / 42));
		const list = data.torrents.slice(0, fit);
		const rows = list.map((r) => {
			const n = releaseName(r.name);
			return `<div class="r" title="${esc(r.name)}"><div class="top"><span class="dl-name"><b>${esc(n.title)}</b>${n.sub && tile.w > 1 ? `<span class="faint">${esc(n.sub)}</span>` : ""}</span><span class="muted num">${Math.round(r.progress * 100)} %${r.eta !== null && tile.w > 1 ? ` · ${t("dl.eta", { t: fmtEta(r.eta) })}` : ""}</span></div><div class="prog"><i style="width:${(r.progress * 100).toFixed(1)}%"></i></div></div>`;
		});
		const more = data.torrents.length > list.length ? ` · ${t("dl.active", { n: data.torrents.length })}` : "";
		if (!rows.length && tile.h > 1) return { c: colorOf(s), html: `${head(`↓ ${fmtSpeed(data.down)}`)}<div class="dl-idle"><div class="big num">${nf(data.seeding || 0)}</div><div class="sm muted">${t("dl.seedingN")}</div><div class="sm faint" style="margin-top:6px">↑ ${fmtSpeed(data.up)} · ${t("dl.idle")}</div></div>` };
		return { c: colorOf(s), html: head(`↓ ${fmtSpeed(data.down)}${more}`) + (rows.length ? `<div class="dl">${rows.join("")}</div>` : `<div class="sm faint bottom">${t("dl.idle")}</div>`) };
	},

	solar(tile, x) {
		const s = x.service(tile.service) || x.ofKind("solar")[0];
		if (!s) return { html: `<div class="th"><span class="n">${t("solar.title")}</span></div>` };
		const d = x.live.data[s.id];
		const head = `<div class="th">${logo(s)}<span class="n">${esc(s.name)}</span><span class="meta">${t("solar.now")}</span></div>`;
		if (!d || !d.data) return { c: "#f5b83d", html: head + setupHint(s, d) };
		const v = d.data;
		const kw = v.pv === null ? "–" : nf(v.pv / 1000, 1);
		const facts = [v.todayWh !== null ? t("solar.today", { v: fmtWh(v.todayWh) }) : "", v.use !== null ? t("solar.use", { v: fmtW(v.use) }) : "", v.battery !== null && tile.w > 1 ? t("solar.battery", { v: v.battery }) : ""].filter(Boolean).join(" · ");
		return { c: "#f5b83d", html: `${head}<div class="big num" style="margin-top:10px">${kw}<small> kW</small></div><div class="sm muted">${esc(facts)}</div><div class="curve-box">${dayCurve(v.points, "#f5b83d", tile.id)}</div>` };
	},

	docker(tile, x) {
		const c = x.live.containers;
		const head = `<div class="th"><span class="logo" style="--c:#2496ed">${svg("<path d='M3 13h18a6 6 0 01-6 6H9a6 6 0 01-6-6z'/><path d='M5 13V9h3v4M8 13V9h3v4M11 13V9h3v4M8 9V5h3v4M14 13V9h3v4'/>")}</span><span class="n">Docker</span>${c ? `<span class="meta">${t("dk.running", { n: c.running })}${c.stopped ? ` · ${t("dk.stopped", { n: c.stopped })}` : ""}</span>` : ""}</div>`;
		if (!c) return { c: "#2496ed", html: `${head}<div class="sm faint bottom">${t("dk.none")}</div>` };
		const max = Math.max(1, ...c.top.map((x2) => x2.memory || 0));
		const rows = c.top.slice(0, tile.h * 3 - (c.stopped ? 2 : 1)).map((r) => `<div class="b"><div class="top"><span>${esc(r.name)}</span><span class="num" title="${t("dk.cpuHelp")}">${r.cpu !== null && r.cpu !== undefined ? `CPU ${nf(r.cpu, r.cpu < 10 ? 1 : 0)} % · ` : ""}${fmtBytes(r.memory)} RAM</span></div><div class="track"><div class="fill" style="width:${Math.round(((r.memory || 0) / max) * 100)}%;background:#2496ed"></div></div></div>`);
		const stopped = c.stopped ? `<div class="sm faint" style="margin-top:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${t("dk.stoppedList")}: ${c.stoppedNames.map(esc).join(", ")}</div>` : "";
		return { c: "#2496ed", html: `${head}<div class="sm faint" style="margin-top:6px">${t("dk.sorted")}</div><div class="bars" style="margin-top:6px">${rows.join("")}</div>${stopped}` };
	},

	events(tile, x) {
		const list = (x.live.events || []).slice(0, tile.h * 2 + 1);
		const head = `<div class="th"><span class="n">${t("ev.title")}</span><span class="meta">${t("ev.sub")}</span></div>`;
		if (!list.length) return { c: "var(--accent)", html: `${head}<div class="sm faint bottom">${t("ev.none")}</div>` };
		const s = (id) => x.service(id);
		const rows = list.map((e) => {
			const svc = s(e.sid);
			const cls = e.to === "down" ? "bad" : e.to === "slow" ? "warn" : e.to === "up" ? "ok" : "info";
			return `<div class="e"><span class="w">${esc(fmtAgo(e.t))}</span><div class="mid"><div class="tt">${esc(svc ? svc.name : e.name)} <span class="ev-${cls}">${t(`ev.${e.to}`)}</span></div>${e.detail ? `<div class="ss">${esc(t(`evd.${e.detail}`, {}) === `evd.${e.detail}` ? e.detail : t(`evd.${e.detail}`))}</div>` : ""}</div></div>`;
		});
		return { c: "var(--accent)", html: `${head}<div class="cal">${rows.join("")}</div>` };
	},

	tailscale(tile, x) {
		const ts = x.live.tailscale;
		const icon = `<span class="logo" style="--c:var(--text)">${svg("<circle cx='6' cy='6' r='1.8'/><circle cx='12' cy='6' r='1.8'/><circle cx='18' cy='6' r='1.8'/><circle cx='6' cy='12' r='1.8'/><circle cx='12' cy='12' r='1.8'/><circle cx='18' cy='12' r='1.8'/><circle cx='12' cy='18' r='1.8'/>", 1.6)}</span>`;
		const head = `<div class="th">${icon}<span class="n">Tailscale</span><span class="meta">${ts && ts.dnsName ? esc(ts.dnsName.split(".")[0]) : ""}</span></div>`;
		if (!ts || !ts.available || ts.error) return { c: "#9aa4b2", html: `${head}<div class="sm faint bottom">${esc((ts && ts.error) || t("ts.notConnected"))}</div>` };
		const rows = (ts.mappings || []).slice(0, tile.h * 3).map((m) => {
			const svc = x.services().find((s) => ts.links && ts.links[s.id] === m.url);
			const port = m.proxy && (/:(\d+)/.exec(m.proxy) || [])[1];
			const isSelf = !svc && ts.self && ts.self.url === m.url;
			return `<a class="ts-item" href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${svc ? logo(svc) : isSelf ? `<span class="logo" style="--c:var(--accent)"><img src="icon.svg" alt=""></span>` : `<span class="logo" style="--c:var(--muted)">${svg(GLYPHS.globe)}</span>`}<span class="ts-name">${esc(svc ? svc.name : isSelf ? "HomeBento" : port ? t("ts.port", { p: port }) : m.proxy || "–")}</span><span class="ts-url">:${m.port}</span></a>`;
		});
		return { c: "#9aa4b2", cls: "ts-tile", html: `${head}<div class="ts-items">${rows.join("") || `<div class="sm faint">${t("ts.none")}</div>`}</div><button class="md-clear" data-ts-manage>${t("ts.manage")}</button>` };
	},

	releases(tile, x) {
		const data = x.live.releases || {};
		const items = releaseItems(tile, data);
		const fresh = items.filter((i) => i.isNew).length;
		const updates = items.filter((i) => i.update).length;
		const gh = `<span class="logo" style="--c:var(--text)">${svg("<path d='M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21'/>", 1.7)}</span>`;
		const head = `<div class="th">${gh}<span class="n">${tile.title ? esc(tile.title) : t("rel.title")}</span><span class="meta">${items.length ? (updates ? `<span class="rel-new-count">${t(updates === 1 ? "rel.update1" : "rel.updates", { n: updates })}</span>` : fresh ? `<span class="rel-new-count">${t("rel.new", { n: fresh })}</span>` : t("rel.upToDate")) : ""}</span></div>`;
		if (!items.length) return { c: "var(--accent)", cls: "rel-tile", html: `${head}<div class="sm faint" style="margin-top:8px">${t("rel.none")}</div><div class="md-btns"><button class="md-clear" data-rel-manage>${t("rel.manage")}</button></div>` };
		// rows of 47 px below the head, above the buttons
		const fit = Math.max(1, Math.floor((tile.h * 118 + (tile.h - 1) * 12 - 88) / 47));
		const rows = items.slice(0, fit).map((i) => {
			const svc = (i.d && i.d.service && x.service(i.d.service)) || x.services().find((s) => s.name.toLowerCase().replace(/\s+/g, "") === i.repo.split("/")[1].toLowerCase().replace(/[-_]/g, ""));
			const l = i.d && i.d.latest;
			return `<div class="rel-row${i.isNew ? " new" : ""}${i.update ? " upd" : ""}"${l ? ` data-release="${esc(i.repo)}|${esc(l.tag)}"` : ""}>${svc ? logo(svc) : `<span class="logo" style="--c:var(--muted)">${svg(GLYPHS.globe)}</span>`}<div class="mid"><div class="tt">${esc(svc ? svc.name : i.repo.split("/")[1])}</div><div class="ss">${i.d && i.d.error ? esc(i.d.error) : esc(i.repo)}</div></div>${i.update && svc && svc.container ? `<button class="rel-upd-btn" data-rel-update>${t("upd.short")}</button>` : ""}<div class="rel-ver"><div class="v">${l ? esc(l.tag.replace(/^release-/i, "")) : "–"}</div><div class="ss">${i.d && i.d.current === true ? `<span class="rel-ok">✓ ${t("rel.current")}</span>` : i.update ? `<span class="rel-upd">${t("rel.runs", { v: esc(i.d.running) })}</span>` : l && l.date ? `<span title="${esc(t("rel.unknownRun"))}">${esc(t("rel.released", { t: fmtAgo(l.date) }))}</span>` : ""}</div></div></div>`;
		});
		return { c: "var(--accent)", cls: "rel-tile", html: `${head}<div class="rel-list">${rows.join("")}</div><div class="md-btns">${fresh ? `<button class="md-clear" data-rel-seen>${t("rel.allSeen")}</button>` : ""}<button class="md-clear" data-rel-manage>${t("rel.manage")}</button></div>` };
	},

	// myStrom plugs: the power now, then one small card per device with its switch
	mystrom(tile, x) {
		const s = x.service(tile.service) || x.ofKind("mystrom")[0];
		if (!s) return { html: `<div class="th"><span class="n">myStrom</span></div>` };
		const d = x.live.data[s.id];
		const on = d && d.data ? d.data.devices.filter((dev) => dev.online && dev.on).length : 0;
		const head = `<div class="th">${logo(s)}<span class="n">${esc(s.name)}</span><span class="meta">${d && d.data ? t("ms.onOf", { a: on, b: d.data.devices.length }) : ""}</span></div>`;
		if (!d || !d.data) return { c: colorOf(s), html: head + setupHint(s, d) };
		const v = d.data;
		const sw = (dev) => (dev.switchable && dev.online ? `<label class="switch small" data-ms-mac="${esc(dev.mac)}"><input type="checkbox" ${dev.on ? "checked" : ""}><span></span></label>` : "");
		const watt = (w) => (w === null || w === undefined ? "–" : nf(w, w < 10 ? 1 : 0));
		const cost = v.todayWh !== null && v.price ? `${nf((v.todayWh / 1000) * v.price, 2)} CHF` : "";
		const hero = `<div class="ms-hero"><div class="big num">${nf(v.watts, 0)}<small> W</small></div><div class="ms-today">${v.todayWh !== null ? `<div class="num">${fmtWh(v.todayWh)}</div><div class="faint">${t("ms.todayShort")}${cost ? ` · ${cost}` : ""}</div>` : ""}</div></div>`;
		// small tile: a plain list
		if (tile.w === 1 || tile.h === 1) {
			const rows = v.devices.slice(0, tile.h * 3).map((dev) => `<div class="ms-row${dev.online ? "" : " off"}"><span class="ms-name">${esc(dev.name)}</span><span class="ms-w num">${dev.online ? `${watt(dev.w)} W` : t("ms.offline")}</span>${sw(dev)}</div>`);
			return { c: colorOf(s), cls: "ms-tile", html: `${head}<div class="ms-list">${rows.join("")}</div>` };
		}
		// who draws how much: one bar, a colour per device (the same dot on its card)
		const HUES = ["#f5b83d", "#9dbcff", "#5fd39a", "#ff8a65", "#c792ea", "#4dd0e1", "#ffd54f", "#f48fb1"];
		const hue = (i) => HUES[i % HUES.length];
		const total = v.devices.reduce((a, dev) => a + (dev.online && dev.w > 0 ? dev.w : 0), 0);
		const share = total > 0 ? `<div class="ms-share">${v.devices.map((dev, i) => (dev.online && dev.w > 0 ? `<i style="width:${((dev.w / total) * 100).toFixed(1)}%;background:${hue(i)}" title="${esc(dev.name)} · ${watt(dev.w)} W"></i>` : "")).join("")}</div>` : "";
		const cols = Math.min(tile.w === 2 ? 2 : 3, Math.max(1, v.devices.length));
		// full cards while they fit, else one line per device
		const fullRows = tile.h === 2 ? 1 : 2;
		const compact = v.devices.length > cols * fullRows;
		const max = cols * (compact ? (tile.h === 2 ? 2 : 5) : fullRows);
		const cards = v.devices.slice(0, max).map((dev) => {
			const state = !dev.online ? "off" : dev.on ? "on" : "idle";
			const sub = [dev.room, dev.online && dev.on && dev.onSince ? t("status.since", { t: fmtDuration(Date.now() - dev.onSince) }) : ""].filter(Boolean).join(" · ");
			if (compact) return `<div class="ms-card compact ${state}" style="--c:${hue(v.devices.indexOf(dev))}"><span class="ms-dot" style="background:${hue(v.devices.indexOf(dev))}"></span><span class="ms-name" title="${esc(dev.name)}">${esc(dev.name)}</span><span class="ms-w num">${dev.online ? `${watt(dev.w)}<small> W</small>` : `<small>${t("ms.offline")}</small>`}</span>${sw(dev)}</div>`;
			return `<div class="ms-card ${state}" style="--c:${hue(v.devices.indexOf(dev))}"><div class="ms-top"><span class="ms-dot" style="background:${hue(v.devices.indexOf(dev))}"></span><span class="ms-name" title="${esc(dev.name)}">${esc(dev.name)}</span>${sw(dev)}</div><div class="ms-sub">${esc(sub || " ")}</div><div class="ms-bottom"><span class="ms-w num">${dev.online ? `${watt(dev.w)}<small> W</small>` : `<small>${t("ms.offline")}</small>`}</span>${dev.todayWh !== null ? `<span class="ms-kwh num">${fmtWh(dev.todayWh)}</span>` : ""}</div></div>`;
		});
		return { c: colorOf(s), cls: "ms-tile", html: `${head}${hero}${share}<div class="ms-cards${compact ? " compact" : ""}" style="--mc:${cols}">${cards.join("")}</div>${v.devices.length > max ? `<div class="sm faint" style="margin-top:6px">${t("jf.more", { n: v.devices.length - max })}</div>` : ""}` };
	},

	// the solar day as a balance: produced, used, own share, grid, battery
	energy(tile, x) {
		const s = x.service(tile.service) || x.ofKind("solar")[0];
		const head = `<div class="th"><span class="n">${t("en.title")}</span><span class="meta">${t("en.today")}</span></div>`;
		const d = s && x.live.data[s.id];
		const td = d && d.data && d.data.today;
		if (!td) return { c: "#f5b83d", html: head + (s ? setupHint(s, d) : `<div class="sm faint bottom">${t("en.needs")}</div>`) };
		const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
		const autarky = pct(td.covered, td.use);
		const own = pct(td.self, td.yield);
		const max = Math.max(td.yield || 0, td.use || 0, 1);
		const bar = (label, wh, color) => `<div class="b"><div class="top"><span>${label}</span><span class="num">${fmtWh(wh)}</span></div><div class="track"><div class="fill" style="width:${Math.round(((wh || 0) / max) * 100)}%;background:${color}"></div></div></div>`;
		const soc = d.data.battery;
		return { c: "#f5b83d", html: `${head}<div class="en-kpis"><div><div class="v num">${autarky ?? "–"} %</div><div class="l">${t("en.autarky")}</div></div><div><div class="v num">${own ?? "–"} %</div><div class="l">${t("en.own")}</div></div>${soc !== null && soc !== undefined ? `<div><div class="v num">${soc} %</div><div class="l">${t("en.battery")}</div></div>` : ""}</div><div class="bars">${bar(t("en.yield"), td.yield, "#f5b83d")}${bar(t("en.use"), td.use, "var(--accent)")}${tile.h > 2 ? bar(t("en.feed"), td.feed, "#5fd39a") + bar(t("en.import"), td.import, "#ff8a65") : ""}</div>` };
	},

	// MagicMirror: which modules are on, version, uptime, restart through the manager
	mirror(tile, x) {
		const s = x.service(tile.service) || x.ofKind("magicmirror")[0];
		if (!s) return { html: `<div class="th"><span class="n">MagicMirror</span></div><div class="sm faint bottom">${t("mm.needs")}</div>` };
		const d = x.live.data[s.id];
		const mgr = x.ofKind("mmmanager")[0];
		const md = mgr && x.live.data[mgr.id] && x.live.data[mgr.id].data;
		const st = x.live.status[s.id] || {};
		const head = `<div class="th">${logo(s)}<span class="n">${esc(s.name)}</span><span class="meta">${d && d.data && d.data.version ? `v${esc(d.data.version)}` : ""}</span></div>`;
		if (!d || !d.data) return { c: colorOf(s), html: head + setupHint(s, d) };
		const v = d.data;
		const facts = [st.status === "down" ? `<span class="ev-bad">${t("status.down")}</span>` : `<span class="ev-ok">${t("mm.online")}</span>`, v.started ? t("status.since", { t: fmtDuration(Date.now() - v.started) }) : "", md && md.restarts !== null ? t("mm.restarts", { n: md.restarts }) : ""].filter(Boolean).join(" · ");
		const chips = v.active.filter((m) => m.position).slice(0, tile.h * 5).map((m) => `<span class="mm-chip" title="${esc((m.position || "").replace(/_/g, " "))}">${esc(m.name.replace(/^MMM-/, ""))}</span>`).join("");
		return { c: colorOf(s), html: `${head}<div class="sm muted" style="margin:6px 0 8px">${facts}</div><div class="mm-chips">${chips}</div><div class="md-btns">${mgr ? `<button class="md-clear" data-mm-restart="${esc(mgr.id)}">${t("mm.restart")}</button>` : ""}<span class="sm faint">${t("mm.count", { a: v.modules, b: v.total })}</span></div>` };
	},

	// weather at the place of the settings or the tile's own
	weather(tile, x) {
		const w = x.live.weather && x.live.weather[tile.id];
		const head = (place, meta) => `<div class="th"><span class="n">${esc(place || t("wx.title"))}</span><span class="meta">${esc(meta || "")}</span></div>`;
		if (!w) return { c: "#6fb3ff", html: head() };
		if (w.error === "no-place") return { c: "#6fb3ff", html: head() + optsHint(t("wx.noPlace")) };
		if (w.error || !w.now) return { c: "#6fb3ff", html: `${head(w.place && w.place.name)}<div class="sm faint bottom">${esc(w.error || "")}</div>` };
		const n = w.now;
		const today = w.days[0] || {};
		const name = w.place.name;
		if (tile.w === 1 && tile.h === 1) return { c: "#6fb3ff", cls: "wx-tile", html: `${head(name)}<div class="wx-now small">${wxIcon(n.code, n.day, "wx-i big")}<div class="big num">${deg(n.temp)}</div></div><div class="sm muted">${deg(today.max)} / ${deg(today.min)}</div>` };
		const facts = [t("wx.feels", { v: deg(n.feels) }), `${n.humidity} %`, `${Math.round(n.wind)} km/h`].join(" · ");
		const now = `<div class="wx-now">${wxIcon(n.code, n.day, "wx-i big")}<div class="big num">${deg(n.temp)}</div><div class="wx-facts"><div>${esc(wxText(n.code))}</div><div class="faint">${tile.w > 1 ? esc(facts) : `${deg(today.max)} / ${deg(today.min)}`}</div></div>${tile.w > 1 ? `<div class="wx-hl num"><div>${deg(today.max)}</div><div class="faint">${deg(today.min)}</div></div>` : ""}</div>`;
		const hourCount = tile.w === 1 ? 4 : tile.w === 2 ? 7 : 11;
		const hours = tile.w > 1 || tile.h > 1 ? `<div class="wx-hours" style="--hc:${hourCount}">${w.hours.slice(0, hourCount).map((hr, i) => `<div><div class="faint">${i === 0 ? t("wx.now") : new Date(hr.t).getHours()}</div>${wxIcon(hr.code, hr.day)}<div class="num">${deg(hr.temp)}</div>${hr.rain >= 20 ? `<div class="wx-rain">${hr.rain} %</div>` : `<div class="wx-rain"></div>`}</div>`).join("")}</div>` : "";
		// days: a bar from the week's lowest to highest temperature
		let days = "";
		const dayRows = tile.h === 1 ? 0 : tile.h === 2 ? (tile.w === 1 ? 3 : 2) : 6;
		if (dayRows) {
			const list = w.days.slice(0, dayRows + 1).slice(1);
			const lo = Math.min(...w.days.map((d) => d.min));
			const hi = Math.max(...w.days.map((d) => d.max));
			const pos = (v) => (((v - lo) / (hi - lo || 1)) * 100).toFixed(1);
			days = `<div class="wx-days">${list.map((d) => `<div><span class="wx-day">${esc(new Date(d.date + "T12:00").toLocaleDateString(LOCALE, { weekday: "short" }))}</span>${wxIcon(d.code, true)}<span class="wx-rain">${d.rain >= 20 ? `${d.rain} %` : ""}</span><span class="num faint">${deg(d.min)}</span><span class="wx-bar"><i style="left:${pos(d.min)}%;right:${100 - pos(d.max)}%"></i></span><span class="num">${deg(d.max)}</span></div>`).join("")}</div>`;
		}
		const sun = today.sunrise && tile.h > 1 && tile.w > 1 ? `${t("wx.sun", { a: today.sunrise.slice(11, 16), b: today.sunset.slice(11, 16) })}` : "";
		return { c: "#6fb3ff", cls: "wx-tile", html: `${head(name, sun)}${now}${tile.h > 1 || tile.w > 1 ? hours : ""}${days}` };
	},

	// the time, big; more places below
	clock(tile) {
		const zones = (tile.zones || []).slice(0, tile.h === 1 ? (tile.w > 1 ? 2 : 0) : 4);
		const more = zones.length ? `<div class="clk-zones">${zones.map((z) => `<div><span class="num" data-clock-zone="${esc(z.zone)}"></span><span class="faint">${esc(z.name || z.zone.split("/").pop().replace(/_/g, " "))}</span></div>`).join("")}</div>` : "";
		// analog: a face with hands (turned every second), the date beside it
		const ticks = Array.from({ length: 12 }, (_, i) => `<line x1="50" y1="${i % 3 ? 8 : 6}" x2="50" y2="${i % 3 ? 12 : 15}" transform="rotate(${i * 30} 50 50)" class="${i % 3 ? "tk" : "tk big"}"/>`).join("");
		const analog = `<svg class="clk-face" viewBox="0 0 100 100" data-analog><circle cx="50" cy="50" r="47" class="rim"/>${ticks}<line class="ah" x1="50" y1="50" x2="50" y2="27"/><line class="am" x1="50" y1="50" x2="50" y2="15"/>${tile.seconds ? `<line class="as" x1="50" y1="58" x2="50" y2="12"/>` : ""}<circle cx="50" cy="50" r="2.6" class="hub"/></svg>`;
		if (tile.analog) return { c: "var(--accent)", cls: `clk-tile analog${zones.length ? " has-zones" : ""}`, html: `${analog}<div class="clk" data-clock${tile.seconds ? " data-sec" : ""}><div class="clk-t num"></div><div class="clk-d muted"></div>${more}</div>` };
		return { c: "var(--accent)", cls: `clk-tile${zones.length ? " has-zones" : ""}`, html: `<div class="clk" data-clock${tile.seconds ? " data-sec" : ""}><div class="clk-t num"></div><div class="clk-d muted"></div></div>${more}` };
	},

	// all file systems of the host
	disks(tile, x) {
		const list = x.live.disks || [];
		const head = `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("disks.title")}</span><span class="meta">${list.length ? t("disks.free", { v: fmtBytes(list.reduce((a, d) => a + d.total - d.used, 0)) }) : ""}</span></div>`;
		if (!list.length) return { c: "var(--accent)", html: `${head}<div class="sm faint bottom">${t("disks.none")}</div>` };
		const rows = list.slice(0, tile.h * 3).map((d) => {
			const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
			return `<div class="b"><div class="top"><span title="${esc(d.device)}">${esc(d.mount)}</span><span class="num">${tile.w > 1 ? `${fmtBytes(d.used)} / ${fmtBytes(d.total)} · ` : ""}${pct} %</span></div><div class="track"><div class="fill${pct > 85 ? " hot" : ""}" style="width:${pct}%"></div></div></div>`;
		});
		return { c: "var(--accent)", html: `${head}<div class="bars">${rows.join("")}</div>` };
	},

	// network traffic of the host over the last hours
	network(tile, x) {
		const pts = x.live.net || [];
		const last = pts[pts.length - 1];
		const valid = pts.filter((p) => p[1] !== null);
		const peak = valid.length ? Math.max(...valid.map((p) => p[1])) : null;
		const head = `<div class="th"><span class="n">${t("net.title")}</span><span class="meta">${valid.length > 1 ? t("net.span", { t: fmtDuration(valid[valid.length - 1][0] - valid[0][0]) }) : ""}</span></div>`;
		if (!last || last[1] === null) return { c: "var(--accent)", html: `${head}<div class="sm faint bottom">${t("net.wait")}</div>` };
		const now = `<div class="net-now"><div><span class="net-k" style="color:var(--accent)">↓</span><span class="num">${fmtBytes(last[1])}/s</span></div><div><span class="net-k" style="color:#5fd39a">↑</span><span class="num">${fmtBytes(last[2])}/s</span></div>${tile.w > 1 && peak !== null ? `<div class="faint">${t("net.peak", { v: `${fmtBytes(peak)}/s` })}</div>` : ""}</div>`;
		return { c: "var(--accent)", html: `${head}${now}${tile.h > 1 || tile.w > 1 ? `<div class="net-box">${netChart(pts, tile.id)}</div>` : ""}` };
	},

	// calendars by link (iCal): the next appointments, by day
	ical(tile, x) {
		const cals = tile.calendars || [];
		const head = `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("ical.title")}</span><span class="meta">${cals.length > 1 ? cals.map((c) => `<i class="cal-dot" style="background:${esc(c.color)}" title="${esc(c.name)}"></i>`).join("") : esc((cals[0] && cals[0].name) || "")}</span></div>`;
		if (!cals.length) return { c: "var(--accent)", html: head + optsHint(t("ical.empty")) };
		const d = x.live.ical && x.live.ical[tile.id];
		if (!d) return { c: "var(--accent)", html: head };
		const err = d.errors.length ? `<div class="sm warn-text" title="${esc(d.errors.join("\n"))}">⚠ ${esc(d.errors[0])}</div>` : "";
		if (!d.events.length) return { c: "var(--accent)", html: `${head}${err}<div class="sm faint bottom">${t("ical.none")}</div>` };
		// fill the height that's there (measured): a day title 25 px, an entry 29 px, 46 px with its place
		let room = tile.h * 118 + (tile.h - 1) * 12 - 28 - 26 - (err ? 18 : 0);
		const out = [];
		let lastDay = null;
		for (const e of d.events.filter((e) => e.end > Date.now() || e.allDay)) {
			const day = new Date(e.t).toDateString();
			const need = (day !== lastDay ? (lastDay ? 25 : 19) : 0) + (e.where && tile.w > 1 ? 46 : 29);
			if (need > room) break;
			room -= need;
			const label = fmtWhen(e.t, false);
			if (day !== lastDay) {
				out.push(`<div class="ic-day${label === t("cal.today") ? " today" : ""}">${esc(label === t("cal.today") || label === t("cal.tomorrow") ? label : new Date(e.t).toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "numeric" }))}</div>`);
				lastDay = day;
			}
			const c = cals[e.cal] || {};
			const time = e.allDay ? t("ical.allDay") : new Date(e.t).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
			out.push(`<div class="ic-ev" style="--cc:${esc(c.color || "var(--accent)")}"><span class="ic-time num">${esc(time)}</span><div class="mid"><div class="tt">${esc(e.title)}</div>${e.where && tile.w > 1 ? `<div class="ss">${esc(e.where)}</div>` : ""}</div></div>`);
		}
		return { c: "var(--accent)", cls: "ic-tile", html: `${head}${err}<div class="ic-list">${out.join("")}</div>` };
	},

	// news from RSS / Atom feeds, newest first
	rss(tile, x) {
		const feeds = tile.feeds || [];
		const head = `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("rss.title")}</span><span class="meta">${esc(feeds.length === 1 ? feeds[0].name || "" : feeds.length ? t("rss.sources", { n: feeds.length }) : "")}</span></div>`;
		if (!feeds.length) return { c: "#ff9f5a", html: head + optsHint(t("rss.empty")) };
		const d = x.live.rss && x.live.rss[tile.id];
		if (!d) return { c: "#ff9f5a", html: head };
		const err = d.errors.length && !d.items.length ? `<div class="sm warn-text">⚠ ${esc(d.errors[0])}</div>` : "";
		const rows = d.items.slice(0, tile.h * 3 - (tile.h > 1 ? 0 : 1)).map((i) => `<a class="rss-it" href="${esc(i.link)}" target="_blank" rel="noopener noreferrer"><div class="tt">${esc(i.title)}</div><div class="ss">${esc([feeds.length > 1 ? i.source : "", i.date ? fmtAgo(i.date) : ""].filter(Boolean).join(" · "))}</div></a>`);
		return { c: "#ff9f5a", cls: "rss-tile", html: `${head}${err}<div class="rss-list">${rows.join("")}</div>` };
	},

	// any web page in a frame
	iframe(tile) {
		if (!tile.url) return { c: "var(--accent)", html: `<div class="th"><span class="n">${t("frame.title")}</span></div>${optsHint(t("frame.empty"))}` };
		return { c: "var(--accent)", cls: "frame-tile", html: `${tile.title ? `<div class="th"><span class="n">${esc(tile.title)}</span><a class="meta" href="${esc(tile.url)}" target="_blank" rel="noopener noreferrer">↗</a></div>` : ""}<iframe src="${esc(tile.url)}" loading="lazy" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"></iframe>` };
	},

	// Sonarr, Radarr, Prowlarr on their own: key figures, then what's downloading (or what's missing),
	// for Prowlarr the indexers – the calendar tile keeps what comes next
	arr(tile, x) {
		const s = x.service(tile.service) || x.ofKind("sonarr")[0] || x.ofKind("radarr")[0];
		if (!s) return { html: `<div class="th"><span class="n">Sonarr · Radarr</span></div><div class="sm faint bottom">${t("arr.needs")}</div>` };
		const d = x.live.data[s.id];
		const st = x.live.status[s.id] || {};
		const head = (meta) => `<div class="th">${logo(s)}<span class="n">${esc(s.name)}</span><span class="meta">${meta || ""}</span></div>`;
		if (!d || !d.data) return { c: colorOf(s), html: head() + setupHint(s, d) };
		const v = d.data;
		const nums = metricsHtml(metrics(s, st, d, tile.w === 1 ? 2 : 4));
		const room = Math.max(0, Math.floor((tile.h * 118 + (tile.h - 1) * 12 - 54 - 58) / 38));
		const ep = (e) => (e && e.season !== undefined ? `S${e.season} · E${e.number}${e.name && tile.w > 1 ? ` · ${e.name}` : ""}` : e && e.year ? String(e.year) : "");
		let list = "";
		let label = "";
		if (s.kind === "prowlarr") {
			label = t("arr.listIndexers");
			list = (v.list || []).slice(0, room).map((i) => `<div class="arr-row"><i class="st-dot ${i.failingUntil ? "bad" : i.enabled ? "ok" : ""}"></i><div class="mid"><div class="tt">${esc(i.name)}</div></div><span class="arr-r">${i.failingUntil ? `<span class="warn-text">${t("arr.failingUntil", { t: new Date(i.failingUntil).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }) })}</span>` : i.enabled ? esc(i.protocol || "") : t("arr.off")}</span></div>`).join("");
		} else if ((v.queueItems || []).length) {
			label = t("arr.listQueue");
			list = v.queueItems.slice(0, room).map((q) => `<div class="arr-row q"><div class="mid"><div class="tt">${esc(q.title)}</div><div class="ss">${esc([ep(q.sub), q.problem ? "" : q.left ? t("dl.eta", { t: q.left.replace(/^00:/, "").replace(/^(\d+):(\d+):\d+$/, "$1 h $2 min") }) : q.state || ""].filter(Boolean).join(" · "))}${q.problem ? ` <span class="warn-text">${esc(q.problem)}</span>` : ""}</div>${q.progress !== null ? `<div class="prog"><i style="width:${(q.progress * 100).toFixed(1)}%"></i></div>` : ""}</div></div>`).join("");
		} else if ((v.missing || []).length) {
			label = t("arr.missing", { n: nf(v.wanted ?? v.missing.length) });
			list = v.missing.slice(0, room).map((m) => `<div class="arr-row"><i class="st-dot warn"></i><div class="mid"><div class="tt">${esc(m.title)}</div><div class="ss">${esc([ep(m.sub), m.at ? fmtWhen(m.at, false) : ""].filter(Boolean).join(" · "))}</div></div></div>`).join("");
		} else label = t("arr.allThere");
		return { c: colorOf(s), cls: "arr-tile", html: `${head(v.warnings && v.warnings.length ? `<span class="warn-text">${t("arr.warnings", { n: v.warnings.length })}</span>` : "")}${nums}${room ? `<div class="sm muted arr-label">${esc(label)}</div><div class="arr-list">${list}</div>` : ""}` };
	},

	// Media storage: what's still free, and what movies and shows take (from Radarr and Sonarr)
	storage(tile, x) {
		const head = `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("sto.title")}</span></div>`;
		const radarr = x.ofKind("radarr")[0];
		const sonarr = x.ofKind("sonarr")[0];
		if (!radarr && !sonarr) return { c: "var(--accent)", html: `${head}<div class="sm faint bottom">${t("sto.needs")}</div>` };
		const v = (s) => (s && x.live.data[s.id] && x.live.data[s.id].data) || null;
		const r = v(radarr);
		const so = v(sonarr);
		const frees = [r, so].filter((d) => d && d.free !== null && d.free !== undefined).map((d) => d.free);
		const list = [{ v: frees.length ? fmtBytes(Math.max(...frees)) : "–", l: t("sto.free") }];
		if (radarr) list.push({ v: r && r.size !== null && r.size !== undefined ? fmtBytes(r.size) : "–", l: t("m.movies") });
		if (sonarr) list.push({ v: so && so.size !== null && so.size !== undefined ? fmtBytes(so.size) : "–", l: t("m.series") });
		return { c: "var(--accent)", html: `${head}${metricsHtml(list)}` };
	},

	// own API: chosen values as figures, an optional list below
	api(tile, x) {
		const d = x.live.api && x.live.api[tile.id];
		const host = (() => {
			try {
				return new URL(tile.api.url).hostname;
			} catch {
				return "";
			}
		})();
		const head = `<div class="th"><span class="logo" style="--c:var(--accent)">${svg("<path d='M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14'/>", 2)}</span><span class="n">${esc(tile.title || t("api.title"))}</span><span class="meta">${esc(host)}</span></div>`;
		if (!tile.api || !tile.api.url) return { c: "var(--accent)", html: head + optsHint(t("api.empty")) };
		if (!d) return { c: "var(--accent)", html: head };
		if (d.error) return { c: "var(--accent)", html: `${head}<div class="sm warn-text bottom" title="${esc(d.error)}">⚠ ${esc(d.error)}</div>` };
		const vals = (d.values || []).slice(0, tile.w * 2);
		const nums = vals.length ? `<div class="metrics api-vals" style="--mc:${Math.min(vals.length, tile.w === 1 ? 2 : tile.w * 2)}">${vals.map((v) => `<div class="${v.state === "bad" ? "bad" : v.state === "warn" ? "warn" : ""}"><div class="v" title="${esc(v.text)}">${esc(v.text)}</div><div class="l">${esc(v.label)}</div></div>`).join("")}</div>` : "";
		const room = Math.max(0, Math.floor((tile.h * 118 + (tile.h - 1) * 12 - 54 - (vals.length ? 52 : 0)) / 24));
		const items = (d.items || []).slice(0, room).map((i) => `<div class="s pl-item"><i class="st-dot ${i.status === "bad" ? "bad" : i.status === "ok" ? "ok" : ""}"></i><span>${esc(i.title)}</span>${i.sub ? `<span class="faint">${esc(i.sub)}</span>` : ""}</div>`).join("");
		return { c: "var(--accent)", cls: "api-tile", html: `${head}${nums}${items ? `<div class="api-items">${items}</div>` : ""}${d.stale ? `<div class="sm faint bottom">${t("api.stale")}</div>` : ""}` };
	},

	// shares, indices, currencies, coins: price, change, the day as a line
	markets(tile, x) {
		const d = x.live.markets && x.live.markets[tile.id];
		const head = `<div class="th"><span class="logo" style="--c:#5fd39a">${svg("<path d='M4 17l5-5 4 3 7-8'/><path d='M15 7h5v5'/>", 2)}</span><span class="n">${esc(tile.title || t("mk.title"))}</span><span class="meta">${d && d.quotes.some((q) => q.marketState === "REGULAR") ? t("mk.open") : ""}</span></div>`;
		if (!(tile.symbols || []).length && !(tile.fx || []).length && !(tile.crypto || []).length) return { c: "#5fd39a", html: head + optsHint(t("mk.empty")) };
		if (!d) return { c: "#5fd39a", html: head };
		const pct = (v) => (v === null || v === undefined ? "" : `<span class="mk-ch ${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? "+" : ""}${nf(v, 2)} %</span>`);
		const price = (v) => (v === null || v === undefined ? "–" : nf(v, v >= 1000 ? 0 : v >= 10 ? 2 : 4));
		const rows = [
			...d.quotes.map((q) => (q.error ? `<div class="mk-row"><span class="mk-name">${esc(q.symbol)}</span><span class="faint sm">${esc(q.error)}</span></div>` : `<div class="mk-row"><div class="mk-name"><b>${esc(q.name || q.symbol)}</b><span class="faint">${esc(q.symbol)}</span></div>${tile.w > 1 ? `<div class="mk-spark${q.change < 0 ? " down" : ""}">${spark(q.spark || [])}</div>` : ""}<div class="mk-val"><b class="num">${price(q.price)}</b>${pct(q.changePct)}</div></div>`)),
			...d.fx.map((f) => (f.error ? "" : `<div class="mk-row"><div class="mk-name"><b>${esc(f.pair)}</b><span class="faint">${t("mk.rate")}</span></div>${tile.w > 1 ? "<div></div>" : ""}<div class="mk-val"><b class="num">${nf(f.rate, 4)}</b>${pct(f.changePct)}</div></div>`)),
			...d.crypto.map((c) => (c.error ? "" : `<div class="mk-row"><div class="mk-name"><b>${esc(c.id.replace(/^\w/, (m) => m.toUpperCase()))}</b><span class="faint">${esc(tile.base || "CHF")}</span></div>${tile.w > 1 ? "<div></div>" : ""}<div class="mk-val"><b class="num">${price(c.price)}</b>${pct(c.changePct)}</div></div>`))
		].filter(Boolean);
		// two lines per value while they fit, else one line each (so nothing falls off)
		const room = tile.h * 118 + (tile.h - 1) * 12 - 60;
		const dense = rows.length > Math.floor(room / 44);
		const fit = Math.max(1, Math.floor(room / (dense ? 31 : 44)));
		return { c: "#5fd39a", cls: "mk-tile", html: `${head}<div class="mk-list${dense ? " dense" : ""}">${rows.slice(0, fit).join("")}</div>` };
	},

	// the next public holidays of a canton
	holidays(tile, x) {
		const list = (x.live.holidays && x.live.holidays[tile.id]) || [];
		const cantons = (window.S && S.state && S.state.cantons) || {};
		const head = `<div class="th"><span class="logo" style="--c:#ff6066">${svg("<path d='M5 21V4M5 4h11l-2 4 2 4H5'/>", 2)}</span><span class="n">${esc(tile.title || t("hol.title"))}</span><span class="meta">${esc(cantons[tile.canton] ? L(cantons[tile.canton]) : tile.canton || "")}</span></div>`;
		const fit = Math.max(1, Math.floor((tile.h * 118 + (tile.h - 1) * 12 - 60) / 47));
		const rows = list.slice(0, fit).map((d) => `<div class="hol-row"><div class="hol-date"><b class="num">${new Date(`${d.date}T12:00`).getDate()}.</b><span>${esc(new Date(`${d.date}T12:00`).toLocaleDateString(LOCALE, { month: "short" }))}</span></div><div class="mid"><div class="tt">${esc(L(d.name))}</div><div class="ss">${esc(new Date(`${d.date}T12:00`).toLocaleDateString(LOCALE, { weekday: "long" }))}${d.scope === "partial" ? ` · ${t("hol.partial")}` : ""}</div></div><span class="hol-in${d.days <= 7 ? " soon" : ""}">${d.days === 0 ? t("cal.today") : d.days === 1 ? t("cal.tomorrow") : t("hol.in", { n: d.days })}</span></div>`);
		return { c: "#ff6066", cls: "hol-tile", html: `${head}<div class="hol-list">${rows.join("")}</div>` };
	},

	// days until something (birthday, holiday, release …), the nearest first
	countdown(tile) {
		const head = `<div class="th"><span class="n">${esc(tile.title || t("cd.title"))}</span></div>`;
		const items = tile.items || [];
		if (!items.length) return { c: "#c792ea", html: head + optsHint(t("cd.empty")) };
		const today = new Date();
		today.setHours(0, 0, 0, 0);
		const next = items
			.map((c) => {
				let d = new Date(`${c.date.slice(0, 10)}T00:00`);
				if (c.yearly) {
					d.setFullYear(today.getFullYear());
					if (d < today) d.setFullYear(today.getFullYear() + 1);
				}
				return { ...c, days: Math.round((d - today) / 86400000), d };
			})
			.filter((c) => c.days >= 0 || c.days > -2)
			.sort((a, b) => a.days - b.days);
		if (!next.length) return { c: "#c792ea", html: `${head}<div class="sm faint bottom">${t("cd.past")}</div>` };
		const big = next[0];
		const say = (n) => (n === 0 ? t("cd.today") : n === 1 ? t("cd.tomorrow") : t("cd.days", { n }));
		const rest = next.slice(1, tile.h === 1 ? (tile.w > 1 ? 3 : 1) : tile.h * 3).map((c) => `<div class="cd-row"><span>${esc(c.name)}</span><span class="num">${esc(say(c.days))}</span></div>`).join("");
		return { c: "#c792ea", cls: `cd-tile${tile.h === 1 && tile.w > 1 ? " row" : ""}`, html: `${head}<div class="cd-main"><div class="cd-big num">${big.days === 0 ? "🎉" : big.days}</div><div><div class="cd-name">${esc(big.name)}</div><div class="faint sm">${big.days === 0 ? t("cd.today") : `${big.days === 1 ? t("cd.day1") : t("cd.daysWord")} · ${esc(big.d.toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "numeric" }))}`}</div></div></div>${rest ? `<div class="cd-rest">${rest}</div>` : ""}` };
	},

	// a camera: still image (refreshed) or MJPEG stream, through HomeBento
	camera(tile) {
		if (!tile.url) return { c: "var(--accent)", html: `<div class="th"><span class="n">${t("cam.title")}</span></div>${optsHint(t("cam.empty"))}` };
		const img = tile.mode === "mjpeg" ? `<img class="cam-img" src="/api/camera/${tile.id}" alt="">` : `<img class="cam-img" data-cam="${tile.id}" data-cam-refresh="${tile.refresh || 5}" src="/api/camera/${tile.id}" alt="">`;
		return { c: "var(--accent)", cls: "cam-tile", html: `${img}<div class="cam-label"><span class="cam-dot"></span>${esc(tile.title || t("cam.title"))}</div>` };
	},

	links(tile) {
		const links = tile.links || [];
		const rows = links.map((l) => {
			let hostName = l.url;
			try {
				hostName = new URL(l.url).hostname;
			} catch {
				// invalid
			}
			return `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><span class="logo" style="--c:var(--accent);width:22px;height:22px;border-radius:7px">${svg(GLYPHS.link)}</span>${esc(l.name || hostName)}</a>`;
		});
		return { c: "var(--accent)", html: `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("links.title")}</span></div>${rows.length ? `<div class="links" style="--lc:${tile.w}">${rows.join("")}</div>` : `<div class="sm faint bottom">${t("links.empty")}</div>`}` };
	}
};
