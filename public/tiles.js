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
	if (!s) return "#9dbcff";
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
	return `<svg class="curve" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none"><defs><linearGradient id="g${id}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".35"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><path d="${d}L${last[0].toFixed(1)},${hh}L${xy[0][0].toFixed(1)},${hh}Z" fill="url(#g${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
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
	if (data) {
		if (s.kind === "jellyfin") out = [m(data.now.length, t("m.streams")), m(data.counts && nf(data.counts.movies), t("m.movies")), m(data.counts && nf(data.counts.series), t("m.series")), m(data.sessions, t("m.sessions"))];
		if (s.kind === "sonarr") out = [m(data.library !== null ? nf(data.library) : null, t("m.series")), m(data.queue, t("m.queue")), m(data.wanted !== null ? nf(data.wanted) : null, t("m.wanted")), m(data.warnings.length, t("m.warnings"), data.warnings.length ? "warn" : "")];
		if (s.kind === "radarr") out = [m(data.library !== null ? nf(data.library) : null, t("m.movies")), m(data.queue, t("m.queue")), m(data.wanted !== null ? nf(data.wanted) : null, t("m.wanted")), m(data.warnings.length, t("m.warnings"), data.warnings.length ? "warn" : "")];
		if (s.kind === "qbittorrent") out = [m(nf((data.down || 0) / 1e6, 1), "↓ MB/s"), m(nf((data.up || 0) / 1e6, 1), "↑ MB/s"), m(data.downloading, t("m.loading")), m(data.seeding, t("m.seeding"))];
		if (s.kind === "prowlarr") out = [m(data.enabled, t("m.indexers")), m(data.failing, t("m.failing"), data.failing ? "warn" : ""), m(data.warnings.length, t("m.warnings"), data.warnings.length ? "warn" : "")];
		if (s.kind === "solar") out = [m(data.pv !== null ? nf(data.pv / 1000, 1) : null, "kW"), m(data.todayWh !== null ? nf(data.todayWh / 1000, 1) : null, t("m.todayKwh")), m(data.battery !== null ? `${data.battery} %` : null, t("m.battery")), m(data.use !== null ? nf(data.use / 1000, 1) : null, t("m.houseKw"))];
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
	const say = (x) => (x.l === "CPU" ? `CPU ${x.v}` : x.l === "Version" ? `v${x.v}` : x.l === t("m.state") ? x.v : `${x.v} ${x.l}`);
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
	if (data && data.items) for (const i of data.items.filter((x) => x.at > Date.now()).slice(0, 2)) lines.push(`<div class="s">${esc(fmtWhen(i.at, false))} · ${esc(i.title)}</div>`);
	if (st.container && st.container.status) lines.push(`<div class="s faint">${esc(st.container.status)}</div>`);
	return lines.slice(0, 3).join("");
}

// ---------- notes (Markdown) ----------

// older tiles kept a list of entries; it reads as a checklist
const notesText = (tile) => (typeof tile.text === "string" ? tile.text : (tile.notes || []).map((n) => `- [${n.done ? "x" : " "}] ${n.text}`).join("\n"));

// A small, safe Markdown: headings, lists, tasks (- [ ] / - [x]), **bold**, *italic*, `code`, links.
function markdown(src) {
	const inline = (s) =>
		esc(s)
			.replace(/`([^`]+)`/g, "<code>$1</code>")
			.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
			.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
			.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
			.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
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

// Subscribed repositories with their newest release; "new" until it was looked at
// (without a record: released in the last 14 days).
function releaseItems(tile, data) {
	const seen = tile.seen || {};
	return (tile.repos || [])
		.map((repo) => {
			const d = data[repo];
			const l = d && d.latest;
			const isNew = !!(l && (seen[repo] ? seen[repo] !== l.tag : l.date && Date.now() - l.date < 14 * 86400000));
			return { repo, d, isNew, date: (l && l.date) || 0 };
		})
		.sort((a, b) => b.isNew - a.isNew || b.date - a.date);
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
		return { c: "#9dbcff", html: `<div class="th"><span class="n">${esc(h.name)}</span><span class="meta">${esc(meta)}</span></div><div class="bars">${rows.join("")}</div>` };
	},

	uptime(tile, x) {
		const list = x.services().filter((s) => s.check !== false && s.url);
		const n = Math.max(1, tile.h * 4 - 1);
		const rows = list.slice(0, n).map((s) => {
			const cells = (x.live.hours[s.id] || []).map((b) => `<i class="${b.ok === null ? "" : b.ok >= 0.999 ? "ok" : b.ok > 0 ? "part" : "bad"}"></i>`).join("");
			return `<span class="nm">${esc(s.name)}</span><div class="cells">${cells}</div>`;
		});
		return { c: "#5fd39a", html: `<div class="th"><span class="n">${t("uptime.title")}</span><span class="meta">${t("uptime.hours")}</span></div>${rows.length ? `<div class="heat">${rows.join("")}</div>` : `<div class="sm faint bottom">${t("uptime.none")}</div>`}` };
	},

	jellyfin(tile, x) {
		const s = x.service(tile.service) || x.ofKind("jellyfin")[0];
		if (!s) return { html: `<div class="th"><span class="n">Jellyfin</span></div>` };
		const d = x.live.data[s.id];
		const head = `<div class="th">${logo(s)}<span class="n">${esc(s.name)}</span><span class="meta">${esc(statLine(s, x.live.status[s.id], d))}</span></div>`;
		if (!d || !d.data) return { c: colorOf(s), html: head + setupHint(s, d) };
		const data = d.data;
		const img = (id) => `/api/img/${s.id}/${id}`;
		let now = "";
		if (tile.h > 1 || !data.recent.length) {
			const p = data.now[0];
			now = p
				? `<div class="nowp"><div class="art" data-media="${s.id}|${esc(p.image)}" style="background-image:url('${img(p.image)}')"></div><div style="flex:1;min-width:0"><div class="title">${esc(p.title)}</div><div class="sm muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.episode ? `S${p.episode.season} · E${p.episode.number} · ${esc(p.episode.name)}` : esc(p.year || "")}</div><div class="sm faint">${esc(p.user)} · ${esc(p.device)}${p.paused ? ` · ${t("jf.paused")}` : ""}</div>${p.progress !== null ? `<div class="prog"><i style="width:${(p.progress * 100).toFixed(1)}%"></i></div>` : ""}</div></div>`
				: `<div class="sm faint" style="margin:10px 0">${t("jf.nothing")}</div>`;
		}
		const count = tile.w === 1 ? 2 : tile.w === 2 ? 4 : 6;
		const rows = tile.h >= 3 ? 2 : 1;
		// a separate "recently added" tile on the same page: don't show the posters twice
		const separate = x.tiles.some((o) => o.type === "recent" && (o.service || (x.ofKind("jellyfin")[0] || {}).id) === s.id);
		const recent = !separate && (tile.h > 1 || !now) ? data.recent.slice(0, count * rows) : [];
		const posters = recent.length ? `<div class="sm muted" style="margin-top:auto">${t("jf.recent")}</div><div class="posters" style="--pc:${count}">${recent.map((r) => `<div class="poster img" data-media="${s.id}|${esc(r.id)}" style="background-image:url('${img(r.id)}')" title="${esc(r.title)}">${esc(r.title)}</div>`).join("")}</div>` : "";
		return { c: colorOf(s), html: head + now + posters };
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
			const rows = recent.slice(0, tile.h * 2 + (tile.h > 2 ? 1 : 0)).map((i) => `<div class="e"${i.ref ? ` data-media="${esc(i.sid)}|${esc(i.ref)}"` : ""}><span class="w">${esc(fmtAgo(i.at))}</span><div class="mid"><div class="tt">${esc(i.title)}</div><div class="ss">${i.src === "sonarr" && i.sub ? `S${i.sub.season} · E${i.sub.number}${i.sub.name ? ` · ${esc(i.sub.name)}` : ""}` : `${t("cal.film")}${i.sub && i.sub.year ? ` · ${i.sub.year}` : ""}`}</div></div><span class="dot" style="background:${i.color}"></span></div>`);
			const head2 = `<div class="th"><span class="n">${t("cal.imported")}</span><span class="meta">${t("cal.noneShort")}</span></div>`;
			return { c: "#35c5f4", html: rows.length ? `${head2}<div class="cal">${rows.join("")}</div>` : `${head}<div class="sm faint bottom">${t("cal.none")}</div>` };
		}
		const sub = (i) => (i.src === "sonarr" ? `S${i.sub.season} · E${i.sub.number}${i.sub.name ? ` · ${esc(i.sub.name)}` : ""}` : `${t("cal.film")} · ${t(`cal.${i.sub.release}`)}`);
		const rows = upcoming.map((i) => {
			const w = fmtWhen(i.at);
			return `<div class="e"${i.ref ? ` data-media="${esc(i.sid)}|${esc(i.ref)}"` : ""}><span class="w${w.startsWith(t("cal.today")) ? " today" : ""}">${esc(w)}</span><div class="mid"><div class="tt">${esc(i.title)}</div><div class="ss">${sub(i)}</div></div>${i.has ? `<span class="has">✓</span>` : ""}<span class="dot" style="background:${i.color}"></span></div>`;
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
		const list = data.torrents.slice(0, tile.h === 1 ? 2 : tile.h * 3);
		const rows = list.map((r) => `<div class="r"><div class="top"><span>${esc(r.name)}</span><span class="muted num">${Math.round(r.progress * 100)} %${r.eta !== null && tile.w > 1 ? ` · ${t("dl.eta", { t: fmtEta(r.eta) })}` : ""}</span></div><div class="prog"><i style="width:${(r.progress * 100).toFixed(1)}%"></i></div></div>`);
		return { c: colorOf(s), html: head(`↓ ${fmtSpeed(data.down)}`) + (rows.length ? `<div class="dl">${rows.join("")}</div>` : `<div class="sm faint bottom">${t("dl.idle")}</div>`) };
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
		const rows = c.top.slice(0, tile.h * 3 - 1).map((r) => `<div class="b"><div class="top"><span>${esc(r.name)}</span><span class="num" title="${t("dk.cpuHelp")}">${r.cpu !== null && r.cpu !== undefined ? `CPU ${nf(r.cpu, r.cpu < 10 ? 1 : 0)} % · ` : ""}${fmtBytes(r.memory)} RAM</span></div><div class="track"><div class="fill" style="width:${Math.round(((r.memory || 0) / max) * 100)}%;background:#2496ed"></div></div></div>`);
		const stopped = c.stopped ? `<div class="sm faint" style="margin-top:8px">${t("dk.stoppedList")}: ${c.stoppedNames.map(esc).join(", ")}</div>` : "";
		return { c: "#2496ed", html: `${head}<div class="sm faint" style="margin-top:6px">${t("dk.sorted")}</div><div class="bars" style="margin-top:6px">${rows.join("")}</div>${stopped}` };
	},

	events(tile, x) {
		const list = (x.live.events || []).slice(0, tile.h * 2 + 1);
		const head = `<div class="th"><span class="n">${t("ev.title")}</span><span class="meta">${t("ev.sub")}</span></div>`;
		if (!list.length) return { c: "#9dbcff", html: `${head}<div class="sm faint bottom">${t("ev.none")}</div>` };
		const s = (id) => x.service(id);
		const rows = list.map((e) => {
			const svc = s(e.sid);
			const cls = e.to === "down" ? "bad" : e.to === "slow" ? "warn" : e.to === "up" ? "ok" : "info";
			return `<div class="e"><span class="w">${esc(fmtAgo(e.t))}</span><div class="mid"><div class="tt">${esc(svc ? svc.name : e.name)} <span class="ev-${cls}">${t(`ev.${e.to}`)}</span></div>${e.detail ? `<div class="ss">${esc(t(`evd.${e.detail}`, {}) === `evd.${e.detail}` ? e.detail : t(`evd.${e.detail}`))}</div>` : ""}</div></div>`;
		});
		return { c: "#9dbcff", html: `${head}<div class="cal">${rows.join("")}</div>` };
	},

	tailscale(tile, x) {
		const ts = x.live.tailscale;
		const icon = `<span class="logo" style="--c:var(--text)">${svg("<circle cx='6' cy='6' r='1.8'/><circle cx='12' cy='6' r='1.8'/><circle cx='18' cy='6' r='1.8'/><circle cx='6' cy='12' r='1.8'/><circle cx='12' cy='12' r='1.8'/><circle cx='18' cy='12' r='1.8'/><circle cx='12' cy='18' r='1.8'/>", 1.6)}</span>`;
		const head = `<div class="th">${icon}<span class="n">Tailscale</span><span class="meta">${ts && ts.dnsName ? esc(ts.dnsName.split(".")[0]) : ""}</span></div>`;
		if (!ts || !ts.available || ts.error) return { c: "#9aa4b2", html: `${head}<div class="sm faint bottom">${esc((ts && ts.error) || t("ts.notConnected"))}</div>` };
		const rows = (ts.mappings || []).slice(0, tile.h * 3).map((m) => {
			const svc = x.services().find((s) => ts.links && ts.links[s.id] === m.url);
			const port = m.proxy && (/:(\d+)/.exec(m.proxy) || [])[1];
			return `<a class="ts-item" href="${esc(m.url)}" target="_blank" rel="noopener">${svc ? logo(svc) : `<span class="logo" style="--c:var(--muted)">${svg(GLYPHS.globe)}</span>`}<span class="ts-name">${esc(svc ? svc.name : port ? t("ts.port", { p: port }) : m.proxy || "–")}</span><span class="ts-url">:${m.port}</span></a>`;
		});
		return { c: "#9aa4b2", cls: "ts-tile", html: `${head}<div class="ts-items">${rows.join("") || `<div class="sm faint">${t("ts.none")}</div>`}</div><button class="md-clear" data-ts-manage>${t("ts.manage")}</button>` };
	},

	releases(tile, x) {
		const data = x.live.releases || {};
		const items = releaseItems(tile, data);
		const fresh = items.filter((i) => i.isNew).length;
		const gh = `<span class="logo" style="--c:var(--text)">${svg("<path d='M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 00-1.3-3.2 4.2 4.2 0 00-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 00-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 00-.1 3.2A4.6 4.6 0 004 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21'/>", 1.7)}</span>`;
		const head = `<div class="th">${gh}<span class="n">${tile.title ? esc(tile.title) : t("rel.title")}</span><span class="meta">${items.length ? (fresh ? `<span class="rel-new-count">${t("rel.new", { n: fresh })}</span>` : t("rel.upToDate")) : ""}</span></div>`;
		if (!items.length) return { c: "#9dbcff", cls: "rel-tile", html: `${head}<div class="sm faint" style="margin-top:8px">${t("rel.none")}</div><div class="md-btns"><button class="md-clear" data-rel-manage>${t("rel.manage")}</button></div>` };
		const rows = items.slice(0, tile.h * 3 + (tile.h > 1 ? 0 : -1)).map((i) => {
			const svc = (i.d && i.d.service && x.service(i.d.service)) || x.services().find((s) => s.name.toLowerCase().replace(/\s+/g, "") === i.repo.split("/")[1].toLowerCase().replace(/[-_]/g, ""));
			const l = i.d && i.d.latest;
			return `<div class="rel-row${i.isNew ? " new" : ""}"${l ? ` data-release="${esc(i.repo)}|${esc(l.tag)}"` : ""}>${svc ? logo(svc) : `<span class="logo" style="--c:var(--muted)">${svg(GLYPHS.globe)}</span>`}<div class="mid"><div class="tt">${esc(svc ? svc.name : i.repo.split("/")[1])}</div><div class="ss">${i.d && i.d.error ? esc(i.d.error) : esc(i.repo)}</div></div><div class="rel-ver"><div class="v">${l ? esc(l.tag) : "–"}</div><div class="ss">${l && l.date ? esc(fmtAgo(l.date)) : ""}</div></div></div>`;
		});
		return { c: "#9dbcff", cls: "rel-tile", html: `${head}<div class="rel-list">${rows.join("")}</div><div class="md-btns">${fresh ? `<button class="md-clear" data-rel-seen>${t("rel.allSeen")}</button>` : ""}<button class="md-clear" data-rel-manage>${t("rel.manage")}</button></div>` };
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
			return `<a href="${esc(l.url)}" target="_blank" rel="noopener"><span class="logo" style="--c:#9dbcff;width:22px;height:22px;border-radius:7px">${svg(GLYPHS.link)}</span>${esc(l.name || hostName)}</a>`;
		});
		return { c: "#9dbcff", html: `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("links.title")}</span></div>${rows.length ? `<div class="links">${rows.join("")}</div>` : `<div class="sm faint bottom">${t("links.empty")}</div>`}` };
	}
};
