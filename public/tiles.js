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
	open: svg("<path d='M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5'/>", 2)
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

// Up to two short facts for the corner of a service tile: what the service knows about itself,
// else CPU and memory of its container, else uptime and how long it has been up.
function facts(s, st, d) {
	const out = [];
	const data = d && d.data;
	if (data && data.warnings && data.warnings.length) out.push({ text: `⚠ ${data.warnings.length}`, cls: "warn", title: data.warnings.join("\n") });
	if (data && (s.kind === "sonarr" || s.kind === "radarr")) {
		if (data.queue) out.push({ text: `↓ ${data.queue}` , title: t("arr.queue", { n: data.queue }) });
		if (data.library !== null && data.library !== undefined) out.push({ text: t(s.kind === "sonarr" ? "arr.series" : "arr.movies", { n: nf(data.library) }) });
	}
	if (data && s.kind === "jellyfin" && data.counts) out.push({ text: t("arr.movies", { n: nf(data.counts.movies) }) }, { text: t("arr.series", { n: nf(data.counts.series) }) });
	if (data && s.kind === "qbittorrent" && data.up) out.push({ text: `↑ ${fmtSpeed(data.up)}` });
	const c = st && st.container;
	if (c && c.state === "running" && c.cpu !== undefined) {
		if (c.cpu !== null) out.push({ text: `CPU ${nf(c.cpu, c.cpu < 10 ? 1 : 0)} %`, title: c.status });
		if (c.memory) out.push({ text: fmtBytes(c.memory), title: c.status });
	}
	if (st && st.uptime !== null && st.uptime !== undefined && st.status !== "down") out.push({ text: `${nf(st.uptime, st.uptime === 100 ? 0 : 1)} %`, title: t("fact.uptime") });
	if (st && st.since && st.status === "up" && Date.now() - st.since > 10 * 60000) out.push({ text: fmtDuration(Date.now() - st.since), title: t("status.since", { t: fmtDuration(Date.now() - st.since) }) });
	return out.slice(0, 2);
}
const factsHtml = (list) => (list.length ? `<div class="facts">${list.map((f) => `<span class="${f.cls || ""}"${f.title ? ` title="${esc(f.title)}"` : ""}>${esc(f.text)}</span>`).join("")}</div>` : "");

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

// ---------- tiles ----------

const TILES = {
	service(tile, x) {
		const s = x.service(tile.service);
		if (!s) return null;
		const st = x.live.status[s.id] || { status: "pending" };
		const d = x.live.data[s.id];
		const tag = st.status === "down" ? `<span class="tag down">${t("tag.down")}</span>` : st.status === "slow" ? `<span class="tag slow">${t("tag.slow")}</span>` : "";
		const line = statLine(s, st, d);
		const side = tag || factsHtml(facts(s, st, d));
		const extra = tile.h > 1 ? moreLines(s, st, d) : "";
		const sp = tile.h > 1 && st.recent && st.status !== "down" ? `<div class="bottom">${spark(st.recent)}</div>` : "";
		if (tile.w > 1 && tile.h === 1) return { c: colorOf(s), cls: `mini ${st.status}`, html: `${logo(s)}<div class="txt"><div class="n">${esc(s.name)}</div><div class="s" title="${esc(line)}">${esc(line)}</div></div>${side}` };
		return { c: colorOf(s), cls: `mini ${st.status}`, html: `<div class="top">${logo(s)}${side}</div><div class="txt"><div class="n">${esc(s.name)}</div><div class="s" title="${esc(line)}">${esc(line)}</div>${extra}</div>${sp}` };
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
				? `<div class="nowp"><div class="art" style="background-image:url('${img(p.image)}')"></div><div style="flex:1;min-width:0"><div class="title">${esc(p.title)}</div><div class="sm muted" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${p.episode ? `S${p.episode.season} · E${p.episode.number} · ${esc(p.episode.name)}` : esc(p.year || "")}</div><div class="sm faint">${esc(p.user)} · ${esc(p.device)}${p.paused ? ` · ${t("jf.paused")}` : ""}</div>${p.progress !== null ? `<div class="prog"><i style="width:${(p.progress * 100).toFixed(1)}%"></i></div>` : ""}</div></div>`
				: `<div class="sm faint" style="margin:10px 0">${t("jf.nothing")}</div>`;
		}
		const count = tile.w === 1 ? 2 : tile.w === 2 ? 4 : 6;
		const rows = tile.h >= 3 ? 2 : 1;
		const recent = tile.h > 1 || !now ? data.recent.slice(0, count * rows) : [];
		const posters = recent.length ? `<div class="sm muted" style="margin-top:auto">${t("jf.recent")}</div><div class="posters" style="--pc:${count}">${recent.map((r) => `<div class="poster img" style="background-image:url('${img(r.id)}')" title="${esc(r.title)}">${esc(r.title)}</div>`).join("")}</div>` : "";
		return { c: colorOf(s), html: head + now + posters };
	},

	calendar(tile, x) {
		const srcs = x.ofKind("sonarr").concat(x.ofKind("radarr"));
		const items = [];
		const errors = [];
		for (const s of srcs) {
			const d = x.live.data[s.id];
			if (d && d.data) for (const i of d.data.items) items.push({ ...i, color: colorOf(s) });
			else if (d && d.error) errors.push(s);
		}
		const upcoming = items.filter((i) => i.at > Date.now() - 6 * 3600000).sort((a, b) => a.at - b.at).slice(0, tile.h * 2 + (tile.h > 2 ? 1 : 0));
		const head = `<div class="th"><span class="n">${tile.title ? esc(tile.title) : t("cal.title")}</span><span class="meta">${srcs.map((s) => esc(s.name)).join(" · ")}</span></div>`;
		if (!srcs.length) return { c: "#35c5f4", html: `${head}<div class="sm faint bottom">${t("cal.needs")}</div>` };
		if (!items.length && errors.length) return { c: "#35c5f4", html: head + setupHint(errors[0], x.live.data[errors[0].id]) };
		if (!upcoming.length) return { c: "#35c5f4", html: `${head}<div class="sm faint bottom">${t("cal.none")}</div>` };
		const sub = (i) => (i.src === "sonarr" ? `S${i.sub.season} · E${i.sub.number}${i.sub.name ? ` · ${esc(i.sub.name)}` : ""}` : `${t("cal.film")} · ${t(`cal.${i.sub.release}`)}`);
		const rows = upcoming.map((i) => {
			const w = fmtWhen(i.at);
			return `<div class="e"><span class="w${w.startsWith(t("cal.today")) ? " today" : ""}">${esc(w)}</span><div class="mid"><div class="tt">${esc(i.title)}</div><div class="ss">${sub(i)}</div></div>${i.has ? `<span class="has">✓</span>` : ""}<span class="dot" style="background:${i.color}"></span></div>`;
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
