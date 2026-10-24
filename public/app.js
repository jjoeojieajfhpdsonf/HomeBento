"use strict";
// HomeBento web app: boards of tiles, live data every few seconds, edit mode,
// service details with actions, and forms for services and tiles. No framework.

const S = { state: null, live: null, boardId: null, editing: false, tiles: null, drag: null };

// append()/replaceChildren() with optional parts: a null child is left out, not written as "null"
for (const fn of ["append", "replaceChildren"]) {
	const orig = Element.prototype[fn];
	Element.prototype[fn] = function (...nodes) {
		return orig.apply(this, nodes.filter((n) => n !== null && n !== undefined && n !== false));
	};
}
const $ = (sel, root = document) => root.querySelector(sel);
// the key for shortcuts: ⌘ on a Mac, Ctrl elsewhere (Windows, Linux)
const IS_MAC = /mac|iphone|ipad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? "⌘" : "Ctrl";

function h(tag, attrs = {}, ...children) {
	const el = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs || {})) {
		if (v === null || v === undefined || v === false) continue;
		if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
		else if (k === "html") el.innerHTML = v;
		else if (k === "value") el.value = v;
		else if (k === "checked") el.checked = !!v;
		else el.setAttribute(k, v === true ? "" : v);
	}
	for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
	return el;
}
const html = (s) => h("span", { html: s }).firstChild || document.createTextNode("");

async function api(method, path, body) {
	const res = await fetch(path, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
	const data = await res.json().catch(() => ({}));
	if (res.status === 401 && data.login) {
		showLogin();
		throw new Error(data.error);
	}
	if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
	return data;
}

function toast(text, bad) {
	const el = $("#toast");
	el.textContent = text;
	el.className = `toast on${bad ? " bad" : ""}`;
	clearTimeout(toast.t);
	toast.t = setTimeout(() => (el.className = "toast"), bad ? 4500 : 2400);
}

// Runs fn and shows its error as a toast. Returns the result or undefined.
async function guard(fn) {
	try {
		return await fn();
	} catch (err) {
		toast(err.message, true);
		return undefined;
	}
}

// ---------- data ----------

const board = () => S.state.config.boards.find((b) => b.id === S.boardId) || S.state.config.boards[0];
const tiles = () => (S.editing ? S.tiles : board().tiles);
const services = () => S.state.config.services;
const serviceById = (id) => services().find((s) => s.id === id) || null;
const ctx = () => ({
	live: S.live || { status: {}, data: {}, hours: {}, host: null },
	service: serviceById,
	services,
	ofKind: (k) => services().filter((s) => s.kind === k),
	tiles: tiles(),
	hostName: S.state.host
});

async function loadState() {
	S.state = await api("GET", "/api/state");
	const saved = localStorage.getItem("homebento.board");
	// ?page=Media (name or number) opens that page – for links, bookmarks, a kiosk
	const wanted = new URLSearchParams(location.search).get("page");
	const byLink = wanted && (S.state.config.boards.find((b) => (b.name || "").toLowerCase() === wanted.toLowerCase()) || S.state.config.boards[Number(wanted) - 1]);
	if (!S.boardId && byLink) S.boardId = byLink.id;
	if (!S.boardId) S.boardId = S.state.config.boards.some((b) => b.id === saved) ? saved : S.state.config.boards[0].id;
	if (!S.state.config.boards.some((b) => b.id === S.boardId)) S.boardId = S.state.config.boards[0].id;
}

let offline = null;
async function loadLive() {
	try {
		S.live = await api("GET", `/api/live?board=${encodeURIComponent(S.boardId)}`);
		if (offline) offline = (offline.remove(), null);
	} catch (err) {
		if (!offline && !$(".login")) document.body.append((offline = h("div", { class: "offline" }, t("app.offline"))));
		return;
	}
	if (!S.drag) renderGrid();
	if (S.hostFill) S.hostFill();
}

// ---------- layout ----------

// One layout: problems on top, content tiles, the services as a list below. A service tile
// only says which page a service belongs to (its row in that page's list).
const combined = () => true;

function render() {
	const app = $("#app");
	app.replaceChildren(
		h("div", { class: "wrap" },
			topBar(),
			setupBanner(),
			h("div", { id: "attention" }),
			h("div", { class: `bento${S.editing ? " editing" : ""}`, id: "bento" }),
			h("div", { id: "svc-list" }))
	);
	document.title = S.state.config.title || t("app.title");
	applyWidth(S.state.config.width);
	renderGrid();
}

function topBar() {
	const boards = S.state.config.boards;
	const tabs = boards.length > 1 || S.editing
		? h(
				"div",
				{ class: "tabs" },
				boards.map((b) =>
					h("button", { class: b.id === S.boardId ? "on" : "", onclick: () => (S.editing && b.id === S.boardId ? boardSheet(b) : switchBoard(b.id)) }, b.name || t("board.default"))
				),
				S.editing ? h("button", { class: "plus", title: t("board.add"), onclick: addBoard }, "+") : null
			)
		: null;
	return h(
		"div",
		{ class: "bar" },
		S.state.config.title ? h("h1", {}, S.state.config.title) : null,
		tabs,
		h("div", { class: "sp" }),
		h("button", { class: "search-btn", onclick: () => palette(), "aria-label": t("pal.placeholder") }, html(UI.search), h("span", { class: "ph" }, t("pal.placeholder")), h("kbd", {}, IS_MAC ? "⌘K" : "Ctrl K")),
		h("button", { class: "icon-btn", title: t("app.settings"), "aria-label": t("app.settings"), onclick: settingsSheet, html: UI.gear }),
		h("button", { class: `btn${S.editing ? " on" : ""}`, onclick: toggleEdit }, S.editing ? t("app.done") : t("app.edit"))
	);
}

// First start with Docker: offer to set everything up in one go.
function setupBanner() {
	if (services().length || !S.state.docker) return null;
	return h("div", { class: "setup-banner" },
		h("div", { class: "grow" }, h("b", {}, t("setup.found")), h("span", {}, t("setup.text"))),
		h("button", { class: "btn primary", onclick: (e) => autoSetup(e.currentTarget) }, t("setup.go")));
}

async function autoSetup(btn) {
	btn.classList.add("busy");
	const r = await guard(() => api("POST", "/api/setup", { board: S.boardId }));
	btn.classList.remove("busy");
	if (!r) return;
	toast(r.added ? t("setup.done", { n: r.added }) : t("setup.none"));
	await loadState();
	if (S.editing) S.tiles = structuredClone(board().tiles);
	render();
	setTimeout(loadLive, 1500);
	return r;
}

function switchBoard(id) {
	if (S.editing) S.tiles = null;
	S.boardId = id;
	localStorage.setItem("homebento.board", id);
	if (S.editing) S.tiles = structuredClone(board().tiles);
	// keep the last live data: the page is drawn right away with it, no empty flash
	render();
	loadLive();
}

// Draws the tiles; a tile's DOM is only touched when its HTML changed (no flicker, images stay).
function renderGrid() {
	const grid = $("#bento");
	if (!grid) return;
	const x = ctx();
	// combined layout: services go to the list, the problem strip replaces the status tile
	const list = combined() ? tiles().filter((tl) => tl.type !== "service" && tl.type !== "status") : tiles();
	renderAttention();
	renderServiceList();
	const seen = new Set();
	const els = [];
	for (const tile of list) {
		const fn = TILES[tile.type];
		const r = fn ? fn(tile, x) : null;
		if (!r) continue;
		let el = grid.querySelector(`:scope > .t[data-id="${tile.id}"]`);
		if (!el) el = h("div", { class: "t", "data-id": tile.id });
		const cls = `t w${tile.w} h${tile.h}${r.cls ? ` ${r.cls}` : ""}${S.drag && S.drag.id === tile.id && S.drag.moved ? " dragging" : ""}`;
		if (el.className !== cls) el.className = cls;
		if (r.c) el.style.setProperty("--c", r.c);
		const content = r.html + (S.editing ? controls(tile) : tileService(tile) ? `<button class="info" data-info aria-label="${t("sheet.details")}" title="${t("sheet.details")}">i</button>` : "");
		// don't redraw a tile while someone types in it (a ticked checkbox doesn't count)
		const ae = document.activeElement;
		const typing = ae && el.contains(ae) && (ae.tagName === "TEXTAREA" || (ae.tagName === "INPUT" && ae.type !== "checkbox"));
		if (el.dataset.html !== content && !typing) {
			el.innerHTML = content;
			el.dataset.html = content;
		}
		seen.add(tile.id);
		els.push(el);
	}
	if (S.editing) els.push(grid.querySelector(":scope > .adder") || h("button", { class: "t w1 h1 adder", onclick: addTileSheet, html: `${UI.plus}${t("tile.add")}` }));
	else if (!tiles().length) els.push(grid.querySelector(":scope > .empty") || emptyCard());
	// put everything in order, drop what's gone
	els.forEach((el, i) => {
		if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
	});
	while (grid.children.length > els.length) grid.lastChild.remove();
	tickClocks();
	fitPosters();
}

// Poster rows: only as many as fit whole, spread over the full width (no poster cut off at the edge).
function fitPosters() {
	for (const row of document.querySelectorAll(".jf-posters")) {
		const items = [...row.children];
		if (!items.length) continue;
		const gap = 8;
		const width = row.clientWidth;
		const height = Math.min(row.clientHeight, 240);
		// many watching leave little room: smaller posters, and none at all when they'd be tiny
		// (hidden, not removed, so the room stays the same on the next fit)
		const label = row.previousElementSibling && row.previousElementSibling.classList.contains("jf-rec") ? row.previousElementSibling : null;
		const tooSmall = height < 72;
		row.style.visibility = tooSmall ? "hidden" : "";
		if (label) label.style.visibility = tooSmall ? "hidden" : "";
		if (tooSmall) continue;
		// a poster stays upright (at most a little wider than 2:3); take the number of whole posters
		// that covers the most room, spare room goes between them
		const size = (k) => {
			const w = Math.floor(Math.min((width - gap * (k - 1)) / k, height * (2 / 3) * 1.15));
			return { k, w, ph: Math.floor(Math.min(height, w * 1.5)) };
		};
		let best = size(1);
		for (let k = 2; k <= items.length; k++) {
			const c = size(k);
			if (c.w < 40) break;
			if (c.k * c.w * c.ph > best.k * best.w * best.ph) best = c;
		}
		const { k: n, w, ph } = best;
		row.style.gridTemplateColumns = `repeat(${n}, ${w}px)`;
		row.style.justifyContent = n > 1 ? "space-between" : "start";
		items.forEach((it, i) => {
			it.style.display = i < n ? "" : "none";
			it.style.height = `${ph}px`;
		});
	}
}

// ---------- combined layout: problem strip and service list ----------

// The first page shows all services; every other page those with a tile on it (in tile order).
function pageServices() {
	if (board().id === S.state.config.boards[0].id) return services();
	const ids = [...new Set(tiles().filter((tl) => tl.service).map((tl) => tl.service))];
	return ids.length ? ids.map(serviceById).filter(Boolean) : services();
}

// Groups for the list on the first page: the page a service lives on.
function serviceGroups(list) {
	const boards = S.state.config.boards;
	if (board().id !== boards[0].id) return [{ name: null, items: list }];
	const groups = new Map();
	for (const s of list) {
		const home = boards.slice(1).find((b) => b.tiles.some((tl) => tl.service === s.id)) || boards[0];
		// services that only live on the first page: "More", not the name of the overview
		const name = home === boards[0] ? t("list.other") : home.name || t("board.default");
		if (!groups.has(name)) groups.set(name, { name, order: boards.indexOf(home), items: [] });
		groups.get(name).items.push(s);
	}
	return [...groups.values()].sort((a, b) => a.order - b.order);
}

function renderAttention() {
	const el = $("#attention");
	if (!el) return;
	if (!combined()) return el.replaceChildren();
	const live = S.live || { status: {}, data: {} };
	const items = [];
	for (const s of pageServices()) {
		const st = live.status[s.id] || {};
		const d = live.data[s.id];
		if (st.status === "down") items.push({ s, c: "var(--bad)", title: t("att.down", { n: s.name }), sub: st.error || "", act: s.container ? ["start", t("sheet.start")] : null });
		else if (st.status === "slow") items.push({ s, c: "var(--warn)", title: t("att.slow", { n: s.name }), sub: fmtMs(st.ms) });
		else if (d && d.error) items.push({ s, c: "var(--warn)", title: s.name, sub: d.error, setup: true });
		else if (d && d.data && d.data.warnings && d.data.warnings.length) items.push({ s, c: "var(--warn)", title: d.data.warnings.length === 1 ? s.name : t("att.warnings", { n: s.name, c: d.data.warnings.length }), sub: d.data.warnings[0], soft: true });
	}
	// the server: storage, temperature, memory, containers restarting, certificates
	for (const a of live.alerts || []) {
		const svc = a.sid ? serviceById(a.sid) : null;
		items.push({ s: svc || { id: `alert-${a.key}`, name: a.name, icon: "glyph:server" }, c: "var(--warn)", title: alertText(a), sub: a.kind === "cert" ? t("al.certSub") : t("al.since", { t: fmtAgo(a.since) }), soft: true, alert: true });
	}
	// what's down first; more than four: the rest behind "+ n more"
	items.sort((a, b) => !!a.soft - !!b.soft);
	// one row: as many as fit side by side (the grid's columns are at least 300 px)
	const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--gap")) || 12;
	const MAX = Math.max(1, Math.floor(((el.clientWidth || 1200) + gap) / (300 + gap)));
	const hidden = S.attAll ? 0 : Math.max(0, items.length - MAX);
	const key = JSON.stringify([S.attAll, MAX, items.map((i) => [i.s.id, i.title, i.sub])]);
	if (el.dataset.key === key) return;
	el.dataset.key = key;
	// all good: nothing to say
	if (!items.length) return el.replaceChildren();
	el.replaceChildren(
		h("div", { class: "attention" },
			items.slice(0, items.length - hidden).map((i) =>
				h("div", { class: "issue", style: `--c:${i.c}` },
					html(logo(i.s)),
					h("div", { class: "grow" }, h("div", { class: "it" }, i.title), h("div", { class: "d", title: i.sub }, i.sub)),
					i.act ? h("button", { class: "btn primary", onclick: (e) => act(e.currentTarget, i.s, i.act[0]) }, i.act[1]) : null,
					h("button", { class: "btn", onclick: () => (i.alert && !serviceById(i.s.id) ? (i.s.name.startsWith("/") ? hostSheet() : alertsSheet()) : i.setup ? serviceForm(i.s) : serviceSheet(i.s.id)) }, i.setup ? t("setup.needed") : t("sheet.details")))),
		),
		// a small switch below the strip: the rest by name, or back to four
		items.length > MAX
			? h("button", { class: "att-toggle", onclick: () => ((S.attAll = !S.attAll), renderAttention()) },
					hidden ? [h("b", {}, t("att.more", { n: hidden })), h("span", {}, items.slice(MAX).map((i) => i.s.name).join(", ")), h("i", { class: "chev" })] : [h("b", {}, t("att.less")), h("i", { class: "chev up" })])
			: null
	);
}

// the strip shows one row: redraw it when the window gets wider or narrower
let attResize = null;
window.addEventListener("resize", () => {
	clearTimeout(attResize);
	attResize = setTimeout(() => S.state && (renderAttention(), fitPosters()), 150);
});

function renderServiceList() {
	const el = $("#svc-list");
	if (!el) return;
	if (!combined()) return el.replaceChildren();
	const list = pageServices();
	if (!list.length) return el.replaceChildren();
	const live = S.live || { status: {}, data: {}, hours: {} };
	const all = serviceGroups(list);
	const first = board().id === S.state.config.boards[0].id;
	// filter by area (first page only): "Alle" or one group
	if (S.listFilter && !all.some((g) => g.name === S.listFilter)) S.listFilter = null;
	const groups = S.listFilter ? all.filter((g) => g.name === S.listFilter) : all;
	const shown = groups.flatMap((g) => g.items);
	const rowHtml = (s) => {
		const st = live.status[s.id] || { status: "pending" };
		const d = live.data[s.id];
		const sub = s.url ? s.url.replace(/^https?:\/\//, "") : "";
		const tag = st.status === "down" ? `<span class="tag down">${t("tag.down")}</span>` : st.status === "slow" ? `<span class="tag slow">${t("tag.slow")}</span>` : d && d.error ? `<span class="tag slow">${t("setup.needed")}</span>` : "";
		const info = st.status === "down" ? st.error || t("status.down") : d && d.error ? d.error : listStat(s, st, d);
		const hours = (live.hours && live.hours[s.id]) || [];
		const up = st.uptime !== null && st.uptime !== undefined ? `${nf(st.uptime, st.uptime === 100 ? 0 : 1)} %` : "–";
		const hasDips = hours.some((b) => b.ok !== null && b.ok < 0.999);
		const acts = S.editing
			? `<div class="svc-acts on">${first ? "" : `<button class="ib" data-svc-act="unpin" title="${t("list.unpin")}">${svg("<path d='M6 6l12 12M18 6L6 18'/>", 2.2)}</button>`}</div>`
			: `<div class="svc-acts">${s.container ? `<button class="ib" data-svc-act="${st.status === "down" ? "start" : "restart"}" title="${t(st.status === "down" ? "sheet.start" : "sheet.restart")}">${svg("<path d='M20 11a8 8 0 10-2.3 5.7M20 5v6h-6'/>", 2)}</button><button class="ib" data-svc-act="logs" title="${t("sheet.logs")}">${svg("<path d='M5 6h14M5 12h14M5 18h9'/>", 2)}</button>` : ""}<button class="ib" data-svc-act="details" title="${t("sheet.details")}">${svg("<circle cx='12' cy='12' r='8.5'/><path d='M12 11v5M12 8h.01'/>", 2)}</button></div>`;
		return `${logo(s)}<div class="svc-name"><div class="n">${esc(s.name)} ${tag}</div><div class="s">${esc(sub)}</div></div><div class="svc-info${st.status === "down" ? " bad" : d && d.error ? " warn" : ""}" title="${esc(info)}">${esc(info)}</div><div class="svc-spark${hasDips ? " dips" : ""}">${spark(hours.map((b) => b.ms))}</div><div class="svc-ms num">${fmtMs(st.ms)}</div><div class="svc-up num">${up}</div>${acts}`;
	};
	// many services, all areas at once: compact columns, one per area (the chips open the full list)
	const compact = first && !S.listFilter && !S.editing && groups.length > 1 && shown.length > 12;
	const miniHtml = (s) => {
		const st = live.status[s.id] || { status: "pending" };
		const d = live.data[s.id];
		const info = st.status === "down" ? st.error || t("status.down") : d && d.error ? d.error : (listStat(s, st, d) || "").split(" · ")[0] || fmtMs(st.ms);
		return `${logo(s)}<span class="mini-n">${esc(s.name)}</span><span class="mini-i${st.status === "down" ? " bad" : d && d.error ? " warn" : ""}" title="${esc(info)}">${esc(info)}</span><i class="mini-dot ${st.status}${d && d.error ? " warn" : ""}"></i>`;
	};
	const key = `${compact ? "c" : ""}${S.editing ? "e" : ""}${S.listFilter || ""}|${groups.map((g) => `${g.name}:${g.items.map((s) => s.id).join(",")}`).join("|")}`;
	if (el.dataset.key !== key) {
		el.dataset.key = key;
		const chips = first && all.length > 1
			? h("div", { class: "svc-chips" },
					h("button", { class: `chip${!S.listFilter ? " on" : ""}`, onclick: () => ((S.listFilter = null), renderServiceList()) }, t("logs.all")),
					all.map((g) => h("button", { class: `chip${S.listFilter === g.name ? " on" : ""}`, onclick: () => ((S.listFilter = g.name), renderServiceList()) }, g.name)))
			: null;
		el.replaceChildren(
			h("div", { class: "svc-head" }, h("b", {}, first && !S.listFilter ? t("list.all") : S.listFilter || t("list.title")), h("span", { class: "faint sm" }, String(shown.length)), chips),
			compact
				? (() => {
						// columns of about the same height: a big area gets two or three of them
						const per = Math.max(6, Math.ceil(shown.length / 4));
						const spans = groups.map((g) => Math.min(3, Math.max(1, Math.round(g.items.length / per))));
						return h("div", { class: "svc-cols", style: `grid-template-columns:repeat(${spans.reduce((a, b) => a + b, 0)},minmax(0,1fr))` },
							groups.map((g, i) => h("div", { class: "svc-col", style: `grid-column:span ${spans[i]}` },
								h("button", { class: "svc-col-head", onclick: () => ((S.listFilter = g.name), renderServiceList()) }, h("b", {}, g.name), h("span", { class: "svc-col-sum", "data-group": g.name }), h("span", { class: "faint" }, "›")),
								h("div", { class: "svc-col-items", style: `column-count:${spans[i]}` }, g.items.map((s) => h("div", { class: "svc-row svc-mini", "data-sid": s.id }))))));
					})()
				: h("div", { class: "svc-rows" }, groups.flatMap((g) => [g.name && groups.length > 1 ? h("div", { class: "svc-group" }, g.name) : null, ...g.items.map((s) => h("div", { class: "svc-row", "data-sid": s.id }))]))
		);
	}
	for (const s of shown) {
		const row = el.querySelector(`.svc-row[data-sid="${s.id}"]`);
		if (!row) continue;
		const st = live.status[s.id] || { status: "pending" };
		const cls = `svc-row${compact ? " svc-mini" : ""} ${st.status}`;
		if (row.className !== cls) row.className = cls;
		row.style.setProperty("--c", colorOf(s));
		const content = compact ? miniHtml(s) : rowHtml(s);
		if (row.dataset.html !== content) {
			row.innerHTML = content;
			row.dataset.html = content;
		}
	}
	if (compact) groupSums(el, groups, live);
}

// compact columns: how each area is doing, in a word
function groupSums(el, groups, live) {
	for (const g of groups) {
		const sum = el.querySelector(`.svc-col-sum[data-group="${CSS.escape(g.name)}"]`);
		if (!sum) continue;
		const bad = g.items.filter((s) => ["down", "slow"].includes((live.status[s.id] || {}).status) || (live.data[s.id] && live.data[s.id].error)).length;
		const text = bad ? t("list.groupBad", { n: bad }) : t("list.groupOk", { n: g.items.length });
		if (sum.textContent !== text) (sum.textContent = text), (sum.className = `svc-col-sum${bad ? " bad" : ""}`);
	}
}

// clicks in the list: the row opens the service, the buttons do their thing
document.addEventListener("click", (e) => {
	const row = e.target.closest(".svc-row");
	if (!row) return;
	const s = serviceById(row.dataset.sid);
	if (!s) return;
	const b = e.target.closest("[data-svc-act]");
	if (S.editing) {
		// editing: the list only takes services off this page
		if (b && b.dataset.svcAct === "unpin") {
			S.tiles = S.tiles.filter((x) => x.service !== s.id || x.type !== "service");
			saveTiles();
			renderGrid();
		}
		return;
	}
	if (b) {
		const a = b.dataset.svcAct;
		if (a === "logs") return logsSheet(s);
		if (a === "details") return serviceSheet(s.id);
		return act(b, s, a);
	}
	const st = S.live && S.live.status[s.id];
	if (!s.url || (st && st.status === "down")) return serviceSheet(s.id);
	window.open(urlFor(s), "_blank", "noopener,noreferrer");
});
document.addEventListener("contextmenu", (e) => {
	const row = e.target.closest(".svc-row");
	if (!row) return;
	e.preventDefault();
	serviceSheet(row.dataset.sid);
});

function controls(tile) {
	const opts = OPTION_TILES.includes(tile.type) ? `<button data-act="opts" title="${t("tile.options")}">⋯</button>` : "";
	return `<button class="ctl rm" data-act="rm" aria-label="${t("tile.remove")}">×</button><div class="ctl sz">${opts}<button data-act="size" title="${t("tile.size")}">⤢ ${tile.w}×${tile.h}</button></div>`;
}

function emptyCard() {
	return h(
		"div",
		{ class: "empty" },
		h("b", {}, t("empty.title")),
		h("p", {}, t("empty.text")),
		h("button", { class: "btn primary", onclick: () => (toggleEdit(), addTileSheet()) }, html(UI.plus), t("empty.add"))
	);
}

// ---------- tile clicks and edit mode ----------

// Notes: click the text to write (Markdown), click outside to save; tick tasks right in the view.
document.addEventListener("pointerdown", (e) => {
	if (S.mdFinish && !e.target.closest(".md-edit")) S.mdFinish(true);
}, true);
function noteTile(el) {
	const t0 = el && el.closest(".bento > .t[data-id]");
	return t0 ? board().tiles.find((x) => x.id === t0.dataset.id) : null;
}
async function saveNotes(tile, focusAdd) {
	const b = board();
	renderGrid();
	if (focusAdd) {
		const input = document.querySelector(`.bento > .t[data-id="${tile.id}"] .note-add`);
		if (input) input.focus();
	}
	await guard(() => api("POST", `/api/boards/${b.id}/tiles`, { tiles: b.tiles }));
}
document.addEventListener("change", (e) => {
	const box = e.target.closest("input[data-line]");
	if (!box || S.editing) return;
	const tile = noteTile(box);
	if (!tile) return;
	const lines = notesText(tile).split("\n");
	const i = Number(box.dataset.line);
	lines[i] = lines[i].replace(/\[([ xX])\]/, box.checked ? "[x]" : "[ ]");
	tile.text = lines.join("\n");
	delete tile.notes;
	saveNotes(tile);
});
document.addEventListener("click", (e) => {
	const clear = e.target.closest("[data-md-clear]");
	if (clear && !S.editing) {
		e.stopPropagation();
		const tile = noteTile(clear);
		if (!tile) return;
		// done tasks move to the archive (with the date), the rest stays
		const lines = notesText(tile).split("\n");
		const doneRe = /^\s*(?:[-*]\s+)?\[[xX]\]\s*/;
		const now = Date.now();
		tile.archive = [...(tile.archive || []), ...lines.filter((l) => doneRe.test(l)).map((l) => ({ text: l.replace(doneRe, ""), at: now }))];
		tile.text = lines.filter((l) => !doneRe.test(l)).join("\n");
		delete tile.notes;
		return saveNotes(tile);
	}
	const arch = e.target.closest("[data-md-archive]");
	if (arch && !S.editing) {
		e.stopPropagation();
		const tile = noteTile(arch);
		if (tile) archiveSheet(tile);
		return;
	}
	const md = e.target.closest("[data-md]");
	if (!md || S.editing || e.target.closest("a, input")) return;
	e.stopPropagation();
	const tile = noteTile(md);
	if (!tile) return;
	const ta = h("textarea", { class: "md-edit", spellcheck: "true", value: notesText(tile) });
	md.replaceWith(ta);
	ta.focus();
	ta.setSelectionRange(ta.value.length, ta.value.length);
	let done = false;
	const finish = (save) => {
		if (done) return;
		done = true;
		S.mdFinish = null;
		if (save && ta.value !== notesText(tile)) {
			tile.text = ta.value;
			delete tile.notes;
		}
		const el = ta.closest(".t");
		if (el) el.dataset.html = "";
		// leave the editor first, else the tile counts as "being typed in" and isn't redrawn
		ta.remove();
		saveNotes(tile);
	};
	ta.addEventListener("blur", () => finish(true));
	S.mdFinish = finish;
	ta.addEventListener("keydown", (ev) => {
		if (ev.key === "Escape") (ev.stopPropagation(), finish(false));
		if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) ta.blur();
	});
}, true);

document.addEventListener("click", (e) => {
	if (e.target.closest(".md, .md-edit, .md-btns") && !S.editing) return;
	const media = e.target.closest("[data-media]");
	if (media && !S.editing) {
		e.stopPropagation();
		const [sid, ref] = media.dataset.media.split("|");
		return mediaSheet(sid, ref);
	}
	const tileOpts = e.target.closest("[data-tile-opts]");
	if (tileOpts) {
		e.stopPropagation();
		const tl = tiles().find((x) => x.id === tileOpts.closest(".t[data-id]").dataset.id);
		return tl && tileOptions(tl);
	}
	const setup = e.target.closest("[data-setup]");
	if (setup) {
		e.stopPropagation();
		return serviceForm(serviceById(setup.dataset.setup));
	}
	const el = e.target.closest(".bento > .t[data-id]");
	if (!el) return;
	if (e.target.closest("a[href]") && !S.editing) return; // links in a tile
	const tile = tiles().find((x) => x.id === el.dataset.id);
	if (!tile) return;
	if (S.editing) {
		if (S.drag && S.drag.justDragged) return;
		const act = e.target.closest("[data-act]");
		if (!act) return;
		if (act.dataset.act === "rm") {
			S.tiles = S.tiles.filter((x) => x !== tile);
			saveTiles();
		} else if (act.dataset.act === "size") {
			const sizes = [[1, 1], [2, 1], [1, 2], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3]];
			const k = sizes.findIndex(([w, hh]) => w === tile.w && hh === tile.h);
			[tile.w, tile.h] = sizes[(k + 1) % sizes.length];
			saveTiles();
		} else if (act.dataset.act === "opts") tileOptions(tile);
		renderGrid();
		return;
	}
	if (e.target.closest("[data-info]")) return detailsOf(tile);
	openTile(tile);
});

// right click: details instead of opening the service
document.addEventListener("contextmenu", (e) => {
	const el = e.target.closest(".bento > .t[data-id]");
	if (!el || S.editing) return;
	const tile = tiles().find((x) => x.id === el.dataset.id);
	if (!tile || !tileService(tile)) return;
	e.preventDefault();
	detailsOf(tile);
});

// The service a tile belongs to (its own, or the first one that feeds a content tile).
function tileService(tile) {
	if (tile.service) return serviceById(tile.service);
	const x = ctx();
	return { jellyfin: x.ofKind("jellyfin")[0], recent: x.ofKind("jellyfin")[0], downloads: x.ofKind("qbittorrent")[0], solar: x.ofKind("solar")[0] }[tile.type] || null;
}

function detailsOf(tile) {
	const s = tileService(tile);
	if (s) serviceSheet(s.id);
	else openTile(tile);
}

// Away from home (HomeBento opened through Tailscale) services open at their Tailscale address.
const viaTailscale = () => /\.ts\.net$/.test(location.hostname) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(location.hostname);
const tsLink = (s) => (S.state.tailscale && S.state.tailscale.links && S.state.tailscale.links[s.id]) || null;
// Away: HomeBento opened by anything but a home network address (Tailscale IP or name, a domain …).
const awayFromHome = () => {
	const hn = location.hostname;
	return !(/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?(fe80|fd|::1))/i.test(hn) || /\.(local|lan|home|internal|home\.arpa)$/i.test(hn) || !hn.includes("."));
};
// The address to open a service with, from where HomeBento was opened:
// 1. away and an own address for away is set → that one
// 2. through Tailscale and the service is shared with Tailscale Serve → its https address
// 3. the service runs on this machine → the same port under the name HomeBento was opened with
//    (http://192.168.0.31:8096 becomes http://100.101.1.2:8096 when opened through Tailscale)
// 4. else the address as stored
function urlFor(s) {
	if (!s.url) return s.url;
	if (s.urlAway && awayFromHome()) return s.urlAway;
	if (viaTailscale() && tsLink(s)) return tsLink(s);
	try {
		const u = new URL(s.url);
		const here = location.hostname;
		const self = new Set(S.state.selfHosts || []);
		if (u.hostname !== here && self.has(u.hostname.replace(/^\[|\]$/g, "")) && !self.has("") && here) {
			u.hostname = here;
			return u.toString().replace(/\/$/, s.url.endsWith("/") ? "/" : "");
		}
	} catch {
		// keep it as it is
	}
	return s.url;
}

// One tap opens the service itself; a service that is down shows what's wrong instead.
function openTile(tile) {
	const s = tileService(tile);
	if (s && s.url) {
		const st = S.live && S.live.status[s.id];
		if (st && st.status === "down") return serviceSheet(s.id);
		window.open(urlFor(s), "_blank", "noopener,noreferrer");
		return;
	}
	return openTileDetails(tile);
}

function openTileDetails(tile) {
	const x = ctx();
	if (tile.service) return serviceSheet(tile.service);
	if (tile.type === "status" || tile.type === "uptime") return statusSheet();
	if (tile.type === "host") return hostSheet();
	if (["notes", "links", "clock", "ical", "rss", "iframe", "markets", "holidays", "countdown", "api"].includes(tile.type)) return;
	if (tile.type === "camera") return cameraView(tile);
	if (tile.type === "disks" || tile.type === "network") return hostSheet();
	if (tile.type === "weather") return tileOptions(tile);
	if (tile.type === "tailscale") return tailscaleSheet();
	const s = { jellyfin: x.ofKind("jellyfin")[0], recent: x.ofKind("jellyfin")[0], downloads: x.ofKind("qbittorrent")[0], solar: x.ofKind("solar")[0], calendar: x.ofKind("sonarr")[0] || x.ofKind("radarr")[0] }[tile.type];
	if (s) serviceSheet(s.id);
}

function toggleEdit() {
	S.editing = !S.editing;
	S.tiles = S.editing ? structuredClone(board().tiles) : null;
	render();
}

let saveTimer = null;
function saveTiles() {
	const b = board();
	b.tiles = structuredClone(S.tiles);
	clearTimeout(saveTimer);
	saveTimer = setTimeout(async () => {
		const r = await guard(() => api("POST", `/api/boards/${b.id}/tiles`, { tiles: b.tiles }));
		if (r) {
			b.tiles = r.board.tiles;
			if (S.editing) {
				// keep the ids the server gave new tiles
				S.tiles = structuredClone(b.tiles);
				renderGrid();
			}
			loadLive();
		}
	}, 350);
}

// Drag to reorder (mouse and touch): the tile under the finger takes the dragged tile's place.
document.addEventListener("pointerdown", (e) => {
	if (!S.editing || e.button > 0) return;
	const el = e.target.closest(".bento > .t[data-id]");
	if (!el || e.target.closest(".ctl")) return;
	S.drag = { id: el.dataset.id, x: e.clientX, y: e.clientY, moved: false };
});
document.addEventListener("pointermove", (e) => {
	const d = S.drag;
	if (!d) return;
	if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
	if (!d.moved) {
		d.moved = true;
		renderGrid();
	}
	e.preventDefault();
	const over = document.elementFromPoint(e.clientX, e.clientY);
	const target = over && over.closest(".bento > .t[data-id]");
	if (!target || target.dataset.id === d.id) return;
	const from = S.tiles.findIndex((x) => x.id === d.id);
	const to = S.tiles.findIndex((x) => x.id === target.dataset.id);
	if (from < 0 || to < 0) return;
	const [m] = S.tiles.splice(from, 1);
	S.tiles.splice(to, 0, m);
	renderGrid();
});
document.addEventListener("pointerup", () => {
	const d = S.drag;
	if (!d) return;
	if (d.moved) {
		d.justDragged = true;
		saveTiles();
		setTimeout(() => {
			S.drag = null;
			renderGrid();
		}, 0);
	} else S.drag = null;
});
document.addEventListener("pointercancel", () => {
	S.drag = null;
	renderGrid();
});

// ---------- sheets ----------

function openSheet({ wide } = {}) {
	const below = topSheet();
	if (below) below.classList.add("behind");
	const el = h("div", { class: `sheet${wide ? " wide" : ""}${below ? " stacked" : ""}`, role: "dialog", "aria-modal": "true" });
	const head = h("div", { class: "hd" });
	const body = h("div", { class: "bd" });
	el.append(head, body);
	document.body.append(el);
	document.documentElement.classList.add("sheet-open");
	$("#scrim").classList.add("on");
	requestAnimationFrame(() => {
		el.classList.add("on");
		// the save buttons say how to press them from the keyboard
		for (const b of el.querySelectorAll(".acts .btn.primary")) if (!b.title) b.title = `${MOD}${IS_MAC ? "" : "+"}↵`;
	});
	const sheet = {
		el,
		body,
		head(...nodes) {
			head.replaceChildren(...nodes, h("button", { class: "x", "aria-label": t("common.close"), onclick: () => sheet.close(), html: UI.x }));
		},
		close() {
			el.dataset.closing = "1";
			el.classList.remove("on");
			setTimeout(() => el.remove(), 220);
			const next = topSheet();
			if (next) next.classList.remove("behind");
			else $("#scrim").classList.remove("on"), document.documentElement.classList.remove("sheet-open");
			if (sheet.onclose) sheet.onclose();
		}
	};
	el.sheet = sheet;
	return sheet;
}
const topSheet = () => [...document.querySelectorAll(".sheet.on:not([data-closing])")].pop();
$("#scrim").addEventListener("click", () => topSheet() && topSheet().sheet.close());
document.addEventListener("keydown", (e) => {
	if (e.key === "Escape" && topSheet()) topSheet().sheet.close();
	// ⌘/Ctrl + Enter saves the window on top: its primary button, or (settings save as you go)
	// the field being edited, then the window closes
	if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && topSheet() && !e.target.closest(".md-edit")) {
		e.preventDefault();
		const sh = topSheet();
		const btns = [...sh.querySelectorAll(".acts .btn.primary")].filter((b) => b.offsetParent !== null && !b.disabled);
		const save = btns.find((b) => /save|speichern|übernehmen|take over|update|aktualisieren|start|starten/i.test(b.textContent)) || btns[btns.length - 1];
		if (save) save.click();
		else {
			const ae = document.activeElement;
			if (ae && sh.contains(ae)) {
				ae.dispatchEvent(new Event("change", { bubbles: true }));
				ae.blur();
			}
			sh.sheet.close();
		}
	}
});

// A question with yes / cancel. text: a sentence (a second line becomes the explanation),
// or { title, body (a node), help }.
function confirmSheet(text, yes = t("confirm.yes"), danger = false) {
	return new Promise((resolve) => {
		const s = openSheet();
		s.el.classList.add("center", "confirm");
		let answered = false;
		const q = typeof text === "string" ? { title: text.split("\n")[0], help: text.split("\n").slice(1).join(" ").trim() } : text;
		s.head(h("div", { class: "tt" }, h("b", {}, q.title)));
		s.el.style.width = "460px";
		s.onclose = () => !answered && resolve(false);
		s.body.append(
			q.body || null,
			q.help ? h("p", { class: "confirm-help" }, q.help) : null,
			h("div", { class: "acts", style: "margin-top:4px;justify-content:flex-end" },
				h("button", { class: "btn", onclick: () => s.close() }, t("form.cancel")),
				h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => ((answered = true), s.close(), resolve(true)) }, yes))
		);
	});
}

function headOf(s) {
	return [
		html(logo(s)),
		h("div", { class: "tt" }, h("b", {}, s.name), s.url ? h("a", { href: urlFor(s), target: "_blank", rel: "noopener noreferrer" }, urlFor(s).replace(/^https?:\/\//, "")) : null)
	];
}

const statusText = (st) => (st ? t(`status.${st.status}`) : t("status.pending"));

async function serviceSheet(sid) {
	const s = serviceById(sid);
	if (!s) return;
	// load first, then open: no empty window in between
	let d = await guard(() => api("GET", `/api/services/${sid}`));
	if (!d) return;
	const sheet = openSheet();
	sheet.head(...headOf(s));
	const fill = async (first) => {
		if (first !== true) d = await guard(() => api("GET", `/api/services/${sid}`));
		if (!d) return;
		const st = d.status;
		const parts = [];
		if (st.status === "down") parts.push(h("div", { class: "note bad" }, `${t("status.down")}${st.error ? `: ${st.error}` : ""}`));
		if (st.status === "slow") parts.push(h("div", { class: "note warn" }, `${t("status.slow")} (${fmtMs(st.ms)})`));
		const integ = S.live && S.live.data[sid];
		if (integ && integ.error) parts.push(h("div", { class: "note warn" }, integ.error));
		parts.push(
			h("div", { class: "kpis" },
				kpi(t("sheet.response"), fmtMs(st.ms)),
				kpi(t("sheet.uptime30"), d.uptime.month === null ? "–" : `${nf(d.uptime.month, d.uptime.month === 100 ? 0 : 2)} %`),
				kpi(t("sheet.state"), `${statusText(st)}${st.since ? ` · ${fmtDuration(Date.now() - st.since)}` : ""}`))
		);
		// HTTPS certificate and quiet time
		const extra = [];
		if (st.cert) extra.push(h("div", {}, h("span", {}, t("cert.label")), h("span", { class: st.cert.daysLeft <= 14 ? "warn-text" : "" }, st.cert.daysLeft < 0 ? t("cert.expired") : t("cert.valid", { n: st.cert.daysLeft, d: new Date(st.cert.validTo).toLocaleDateString(LOCALE) }) + (st.cert.selfSigned ? ` · ${t("cert.self")}` : ""))));
		if (st.note) extra.push(h("div", {}, h("span", {}, t("check.note")), h("span", {}, st.note)));
		const muted = s.mutedUntil && s.mutedUntil > Date.now() ? s.mutedUntil : null;
		const mute = async (minutes) => {
			const r = await guard(() => api("POST", `/api/services/${s.id}/mute`, { minutes }));
			if (!r) return;
			s.mutedUntil = r.mutedUntil;
			toast(r.mutedUntil ? t("mute.on", { t: until(r.mutedUntil) }) : t("mute.off"));
			fill();
		};
		extra.push(h("div", {}, h("span", {}, t("mute.label")), h("span", { class: "mute-btns" }, muted ? [h("span", {}, t("mute.until", { t: until(muted) })), h("button", { class: "chip", onclick: () => mute(0) }, t("mute.end"))] : [["1 h", 60], ["8 h", 480], ["24 h", 1440]].map(([l, m]) => h("button", { class: "chip", onclick: () => mute(m) }, l)))));
		const extraBox = h("div", { class: "box kv svc-extra" }, extra);
		// a newer version than the container runs: update right here
		if (d.release && d.release.current === false && s.container) {
			const rel = d.release;
			parts.push(h("div", { class: "upd-box" },
				h("div", { class: "grow" }, h("div", { class: "title" }, t("upd.available")), h("div", { class: "sub" }, `${rel.running} → ${rel.latest.tag.replace(/^release-/i, "")}`)),
				h("a", { class: "btn", href: rel.latest.url, target: "_blank", rel: "noopener noreferrer" }, t("upd.notes")),
				h("button", { class: "btn primary", onclick: () => updateService(s, rel) }, t("upd.go"))));
		}
		// what the service itself reports (Sonarr/Radarr/Prowlarr health checks)
		// an update the box above already offers isn't repeated as a warning
		const UPDATE_RE = /update (is )?available|new version|neue version/i;
		const offered = d.release && d.release.current === false && s.container;
		const warnings = ((integ && integ.data && integ.data.warnings) || []).filter((w) => !(offered && UPDATE_RE.test(w)));
		if (warnings.length) {
			const statusPage = s.url && ["sonarr", "radarr", "prowlarr"].includes(s.kind) ? `${urlFor(s).replace(/\/+$/, "")}/system/status` : null;
			parts.push(
				h("div", { class: "sec" }, h("span", {}, t("sheet.warnings"), h("span", { class: "sec-n" }, String(warnings.length))),
					// after an outage: test the indexers and check again, right from here
					statusPage ? h("button", { class: "sec-link sec-btn", onclick: async (e) => {
						const b = e.currentTarget;
						b.classList.add("busy");
						b.textContent = t("sheet.rechecking");
						try {
							const r = await api("POST", `/api/services/${s.id}/action`, { what: "recheck" });
							toast(r.indexers ? t("sheet.rechecked", { ok: r.valid, n: r.indexers }) : t("sheet.recheckedNone"));
							await loadLive();
							serviceSheet(s.id);
						} catch (err) {
							toast(err.message);
							b.classList.remove("busy");
							b.textContent = t("sheet.recheck");
						}
					} }, t("sheet.recheck")) : null,
					statusPage ? h("a", { href: statusPage, target: "_blank", rel: "noopener", class: "sec-link" }, t("sheet.openIn", { n: s.name })) : null),
				// the service itself says there's an update: update the container right from here
				h("div", { class: "box warn-list" }, warnings.map((w) => h("div", {}, h("span", { class: "warn-dot" }), h("span", { class: "grow" }, w), s.container && UPDATE_RE.test(w) ? h("button", { class: "btn warn-act", onclick: () => updateService(s, null) }, t("upd.go")) : null)))
			);
		}
		// plugins: their list (monitors, guests, pools, clients …)
		if (integ && integ.data && Array.isArray(integ.data.metrics)) {
			const pd = integ.data;
			parts.push(h("div", { class: "kpis", style: `margin-top:8px;grid-template-columns:repeat(${Math.min(4, pd.metrics.length) || 1},1fr)` }, pd.metrics.map((x) => kpi(L(x.label), x.value !== null && typeof x.value === "object" ? L(x.value) : String(x.value ?? "–")))));
			if (pd.items && pd.items.length) parts.push(h("div", { class: "sec" }, pd.summary || L(S.state.kinds[s.kind].label)), h("div", { class: "box pl-list" }, pd.items.slice(0, 40).map((i) => h("div", {}, h("i", { class: `st-dot ${i.status || ""}` }), h("div", { class: "grow" }, h("div", {}, i.title), i.sub ? h("div", { class: "sub" }, i.sub) : null)))));
		}
		parts.push(h("div", { class: "sec" }, t("sheet.last24")), h("div", { class: "box" }, bars(d.hours, true), h("div", { class: "axis" }, h("span", {}, "−24 h"), h("span", {}, t("time.now")))));
		parts.push(h("div", { class: "sec" }, t("sheet.last30")), h("div", { class: "box" }, bars(d.days.map((ok) => ({ ok, ms: null })), false), h("div", { class: "axis" }, h("span", {}, "−30 d"), h("span", {}, t("cal.today")))));
		// certificate and quiet time, after the history
		parts.push(h("div", { class: "sec" }, t("sheet.more")), extraBox);
		if (s.container) parts.push(containerPart(s, d.container, fill));
		const ts = tailscalePart(s, fill);
		if (ts) parts.push(h("div", { class: "sec" }, "Tailscale"), ts);
		// MagicMirror: which modules are on
		if (s.kind === "magicmirror" && integ && integ.data && integ.data.active) {
			const mm = integ.data;
			parts.push(h("div", { class: "sec" }, t("mm.modules", { a: mm.modules, b: mm.total })), h("div", { class: "box mm-mods" }, mm.active.map((x) => h("div", {}, h("span", {}, x.name), h("span", { class: "faint" }, x.position ? x.position.replace(/_/g, " ") : t("mm.background"))))));
		}
		if (s.kind === "mmmanager") parts.push(h("div", { class: "acts" }, h("button", { class: "btn", onclick: (e) => act(e.currentTarget, s, "restart", fill) }, t("mm.restart"))));
		parts.push(h("div", { class: "sec" }, t("sheet.events")));
		parts.push(
			d.events.length
				? h("div", { class: "box events" }, d.events.map((ev) => h("div", {}, h("span", { class: "when" }, new Date(ev.t).toLocaleString(LOCALE, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })), h("span", {}, `${t(`ev.${ev.to}`)}${ev.detail ? ` – ${ev.detail}` : ""}`))))
				: h("div", { class: "note" }, t("sheet.noEvents"))
		);
		parts.push(
			h("div", { class: "acts" },
				s.url ? h("a", { class: "btn primary", href: urlFor(s), target: "_blank", rel: "noopener noreferrer" }, html(UI.open), t("sheet.open")) : null,
				h("button", { class: "btn", onclick: async (e) => {
					const b = e.currentTarget;
					b.classList.add("busy");
					b.textContent = t("sheet.checking");
					const r = await guard(() => api("POST", `/api/services/${sid}/check`));
					if (r) {
						if (S.live && r.data) S.live.data[sid] = r.data;
						toast(`${t("sheet.checked")}: ${statusText(r)}${r.ms !== null && r.ms !== undefined ? ` · ${fmtMs(r.ms)}` : ""}${r.error ? ` · ${r.error}` : ""}`, r.status === "down");
					}
					await fill();
					loadLive();
				} }, t("sheet.checkNow")),
				h("button", { class: "btn", onclick: () => (sheet.close(), serviceForm(s)) }, t("sheet.edit")))
		);
		const top = sheet.body.scrollTop;
		sheet.body.replaceChildren(...parts);
		sheet.body.scrollTop = top;
	};
	fill(true);
}

const kpi = (k, v) => h("div", { class: "kpi" }, h("div", { class: "k" }, k), h("div", { class: "v num", title: v }, v));

// bars: [{ ok, ms }]; with ms the height shows the response time
function bars(list, byMs) {
	const max = Math.max(1, ...list.map((b) => b.ms || 0));
	return h("div", { class: "hbars", style: `--n:${list.length}` }, list.map((b) => {
		const cls = b.ok === null ? "none" : b.ok >= 0.999 ? "" : b.ok > 0 ? "part" : "bad";
		const height = b.ok === null ? 8 : byMs && b.ms ? Math.max(12, (b.ms / max) * 100) : 100;
		return h("i", { class: cls, style: `height:${height}%`, title: b.ok === null ? "–" : `${Math.round(b.ok * 100)} %${b.ms ? ` · ${fmtMs(b.ms)}` : ""}` });
	}));
}

function containerPart(s, c, refresh) {
	const box = h("div");
	box.append(h("div", { class: "sec" }, `${t("sheet.container")} · ${s.container}`));
	if (!c || c.error) {
		box.append(h("div", { class: "note warn" }, (c && c.error) || t("settings.dockerOff")));
		return box;
	}
	const running = c.state === "running";
	box.append(
		h("div", { class: "box kv" },
			h("div", {}, h("span", {}, t("sheet.state")), h("span", {}, c.status || c.state)),
			h("div", {}, h("span", {}, t("sheet.image")), h("span", {}, c.image)),
			running && c.cpu !== null ? h("div", {}, h("span", {}, t("sheet.cpu")), h("span", { class: "num" }, `${nf(c.cpu, 1)} %`)) : null,
			running && c.memory !== null ? h("div", {}, h("span", {}, t("sheet.memory")), h("span", { class: "num" }, fmtBytes(c.memory))) : null),
		h("div", { class: "acts" },
			running ? h("button", { class: "btn", onclick: (e) => act(e.currentTarget, s, "restart", refresh) }, t("sheet.restart")) : h("button", { class: "btn primary", onclick: (e) => act(e.currentTarget, s, "start", refresh) }, t("sheet.start")),
			running ? h("button", { class: "btn", onclick: (e) => act(e.currentTarget, s, "stop", refresh) }, t("sheet.stop")) : null,
			h("button", { class: "btn", onclick: () => logsSheet(s) }, t("sheet.logs")))
	);
	return box;
}

async function act(btn, s, what, refresh) {
	if (what === "stop" && !(await confirmSheet(t("sheet.stopConfirm", { n: s.name }), t("sheet.stop"), true))) return;
	btn.classList.add("busy");
	toast(t(what === "start" ? "act.starting" : what === "stop" ? "act.stopping" : "act.restarting", { n: s.name }));
	const r = await guard(() => api("POST", `/api/services/${s.id}/action`, { what }));
	btn.classList.remove("busy");
	if (r) toast(t("act.done"));
	if (refresh) refresh();
	setTimeout(loadLive, 1500);
	setTimeout(loadLive, 8000);
}

// Logs: tidy lines (time, level, message), search, level filter, repeats folded, live.
async function logsSheet(s) {
	const sheet = openSheet({ wide: true });
	sheet.el.classList.add("logs-sheet");
	sheet.head(...headOf(s));
	const st = { q: "", level: "all", fold: true, live: true, tail: 400, entries: [] };
	const search = h("input", { class: "input", placeholder: t("logs.search"), oninput: (e) => ((st.q = e.target.value.trim().toLowerCase()), draw()) });
	const chips = h("div", { class: "log-chips" });
	const fold = h("input", { type: "checkbox", checked: true, onchange: (e) => ((st.fold = e.target.checked), draw()) });
	const live = h("input", { type: "checkbox", checked: true, onchange: (e) => (st.live = e.target.checked) });
	const tail = h("select", { class: "input", style: "width:auto", onchange: (e) => ((st.tail = Number(e.target.value)), load()) }, [200, 400, 1000, 2000].map((n) => h("option", { value: n, selected: n === st.tail }, t("logs.lines", { n }))));
	const box = h("div", { class: "log-list" });
	sheet.body.append(
		h("div", { class: "log-bar" }, search, chips),
		h("div", { class: "log-bar" },
			h("label", { class: "log-opt" }, fold, t("logs.fold")),
			h("label", { class: "log-opt" }, live, t("logs.live")),
			h("span", { style: "flex:1" }),
			tail),
		box
	);
	const draw = () => {
		const counts = { all: st.entries.length, warn: st.entries.filter((e) => e.level === "warn").length, error: st.entries.filter((e) => e.level === "error").length };
		chips.replaceChildren(...["all", "warn", "error"].map((l) => h("button", { class: `chip${st.level === l ? " on" : ""}${l !== "all" && counts[l] ? ` ${l}` : ""}`, onclick: () => ((st.level = l), draw()) }, `${t(`logs.${l}`)} ${counts[l]}`)));
		let list = st.entries.filter((e) => (st.level === "all" || e.level === st.level || (st.level === "warn" && e.level === "error")) && (!st.q || e.msg.toLowerCase().includes(st.q)));
		if (st.fold) {
			const out = [];
			for (const e of list) {
				const last = out[out.length - 1];
				if (last && last.key === e.key) (last.count++, (last.lastTs = e.ts));
				else out.push({ ...e, count: 1, lastTs: e.ts });
			}
			list = out;
		}
		const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
		const mark = (text) => {
			if (!st.q) return esc(text);
			const i = text.toLowerCase().indexOf(st.q);
			return i < 0 ? esc(text) : `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + st.q.length))}</mark>${esc(text.slice(i + st.q.length))}`;
		};
		box.innerHTML = list.length
			? list.slice(-1500).map((e) => `<div class="log-row ${e.level}"><span class="log-ts">${e.ts ? fmtLogTime(e.ts) : ""}</span><span class="log-lv">${t(`logs.lv.${e.level}`)}</span><span class="log-msg">${mark(e.msg)}${e.count > 1 ? ` <span class="log-rep">×${e.count} · ${t("logs.last")} ${fmtLogTime(e.lastTs)}</span>` : ""}</span></div>`).join("")
			: `<div class="log-empty">${t("logs.none")}</div>`;
		if (atBottom || !box.dataset.scrolled) (box.scrollTop = box.scrollHeight), (box.dataset.scrolled = "1");
	};
	const load = async () => {
		const r = await api("GET", `/api/services/${s.id}/logs?tail=${st.tail}`).catch((err) => ({ error: err.message }));
		if (r.error) return box.replaceChildren(h("div", { class: "note bad" }, r.error));
		st.entries = parseLogs(r.text || "");
		draw();
	};
	await load();
	search.focus();
	const timer = setInterval(() => st.live && !document.hidden && load(), 3000);
	sheet.onclose = () => clearInterval(timer);
}

// "2026-10-18T10:53:58.73Z [10:53:58] [INF] [54] Message" → { ts, level, msg, key }
function parseLogs(text) {
	const out = [];
	for (const raw of text.split("\n")) {
		if (!raw.trim()) continue;
		const m = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s?(.*)$/.exec(raw);
		const ts = m ? Date.parse(m[1]) : null;
		let msg = (m ? m[2] : raw).replace(/\x1b\[[0-9;]*m/g, "");
		const lv = /\b(FTL|FATAL|CRIT(?:ICAL)?|ERR(?:OR)?|PANIC)\b/i.test(msg.slice(0, 80)) || /^\s*E\d{4}/.test(msg) ? "error" : /\b(WRN|WARN(?:ING)?)\b/i.test(msg.slice(0, 80)) ? "warn" : /\b(DBG|DEBUG|TRC|TRACE|VRB)\b/i.test(msg.slice(0, 60)) ? "debug" : "info";
		// drop the app's own time stamp, level and thread number at the start – shown separately
		msg = msg.replace(/^\s*\[?\d{1,2}:\d\d:\d\d(?:[.,]\d+)?\]?\s*/, "").replace(/^\[?(INF|INFO|WRN|WARN|ERR|ERROR|DBG|DEBUG|FTL|TRC)\]?:?\s*/i, "").replace(/^\[\d+\]\s*/, "");
		if (!msg.trim()) continue;
		// a line without its own time continues the entry before (stack traces)
		if (!m && out.length && /^\s/.test(raw)) {
			out[out.length - 1].msg += `\n${msg}`;
			continue;
		}
		out.push({ ts, level: lv, msg, key: `${lv}|${msg}` });
	}
	return out;
}

function fmtLogTime(ts) {
	const d = new Date(ts);
	const today = new Date().toDateString() === d.toDateString();
	const time = d.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
	return today ? time : `${d.toLocaleDateString(LOCALE, { day: "numeric", month: "numeric" })} ${time}`;
}

async function statusSheet() {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("status.title"))));
	const x = ctx();
	const order = { down: 0, slow: 1, pending: 2, unknown: 3, up: 4 };
	const list = services().slice().sort((a, b) => (order[(x.live.status[a.id] || {}).status] ?? 2) - (order[(x.live.status[b.id] || {}).status] ?? 2) || a.name.localeCompare(b.name));
	sheet.body.append(
		list.length
			? h("div", { class: "box rows" }, list.map((s) => {
					const st = x.live.status[s.id];
					return h("button", { onclick: () => (sheet.close(), serviceSheet(s.id)) }, html(logo(s)),
						h("div", { class: "grow" }, h("div", { class: "title" }, s.name), h("div", { class: "sub" }, `${statusText(st)}${st && st.status === "down" && st.error ? ` – ${st.error}` : st && st.ms ? ` · ${fmtMs(st.ms)}` : ""}`)),
						h("span", { class: `tag ${st ? st.status : ""}` }, st && (st.status === "down" || st.status === "slow") ? t(`tag.${st.status}`) : ""));
				}))
			: h("div", { class: "note" }, t("status.noServices"))
	);
}

// Server details; follows the live data like the tile does. Click a value for its 24 h chart.
function hostSheet() {
	if (!S.live || !S.live.host) return;
	const sheet = openSheet();
	let open = null;
	let points = null;
	const loadHistory = async () => {
		const r = await api("GET", "/api/host/history").catch(() => null);
		points = r ? r.points : [];
		fill();
	};
	// [t, cpu, mem, disk, rx, tx, temp, load]
	const SERIES = { cpu: [[1, "#9dbcff"]], memory: [[2, "#f5b83d"]], disk: [[3, "#9aa4b2"]], net: [[4, "#5fd39a"], [5, "#9dbcff"]], temp: [[6, "#ff8a65"]], load: [[7, "#c792ea"]] };
	const UNIT = { cpu: (v) => `${nf(v, 0)} %`, memory: (v) => `${nf(v, 1)} %`, disk: (v) => `${nf(v, 1)} %`, net: (v) => `${fmtBytes(v)}/s`, temp: (v) => `${nf(v, 0)} °C`, load: (v) => nf(v, 2) };
	const fill = () => {
		const hst = S.live && S.live.host;
		if (!hst) return;
		const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
		sheet.head(html(`<span class="logo" style="--c:#9dbcff">${svg(GLYPHS.server)}</span>`), h("div", { class: "tt" }, h("b", {}, hst.name), h("span", { class: "sub" }, t("host.up", { t: fmtDuration(hst.uptime) }))));
		const row = (key, k, v) => {
			const isOpen = open === key;
			const r = [h("button", { class: `host-row${isOpen ? " open" : ""}`, onclick: () => ((open = isOpen ? null : key), !points && open ? loadHistory() : fill()) }, h("span", {}, k), h("span", { class: "num" }, v, h("span", { class: "chev", html: svg("<path d='M9 6l6 6-6 6'/>", 2) })))];
			if (isOpen) r.push(h("div", { class: "host-chart" }, points ? chart(points, SERIES[key], UNIT[key], key === "net" ? [t("host.down"), t("host.upNet")] : null) : h("div", { class: "faint sm" }, "…")));
			return r;
		};
		const top = sheet.body.scrollTop;
		sheet.body.replaceChildren(
			h("div", { class: "box kv host-kv" },
				row("cpu", t("host.cpu"), `${hst.cpu} %`),
				h("div", {}, h("span", {}, t("host.cores")), h("span", { class: "num" }, String(hst.cores))),
				row("load", t("host.load"), nf(hst.load, 2)),
				row("memory", t("host.memory"), `${t("host.of", { a: fmtBytes(hst.memUsed), b: fmtBytes(hst.memTotal) })} (${pct(hst.memUsed, hst.memTotal)} %)`),
				hst.diskTotal ? row("disk", t("host.disk"), `${t("host.of", { a: fmtBytes(hst.diskUsed), b: fmtBytes(hst.diskTotal) })} (${pct(hst.diskUsed, hst.diskTotal)} %)`) : null,
				hst.net ? row("net", t("host.net"), `↓ ${fmtBytes(hst.net.rx)}/s · ↑ ${fmtBytes(hst.net.tx)}/s`) : null,
				hst.temp !== null ? row("temp", t("host.temp"), `${hst.temp} °C`) : null),
			h("div", { class: "note", style: "margin-top:12px" }, t("host.loadHelp"))
		);
		sheet.body.scrollTop = top;
	};
	fill();
	S.hostFill = fill;
	sheet.onclose = () => (S.hostFill = null);
}

// A 24 h line chart with min/max/now and an hour axis. series: [[index in point, colour]]
function chart(points, series, unit, names) {
	const w = 520, hh = 130;
	const pts = points.filter((p) => series.some(([i]) => p[i] !== null && p[i] !== undefined));
	if (pts.length < 2) return h("div", { class: "faint sm" }, t("host.noHistory"));
	const t0 = Date.now() - 24 * 3600 * 1000;
	const vals = pts.flatMap((p) => series.map(([i]) => p[i]).filter((v) => v !== null && v !== undefined));
	const max = Math.max(...vals, 1) * 1.1;
	const x = (tm) => ((tm - t0) / (24 * 3600 * 1000)) * w;
	const y = (v) => hh - (v / max) * (hh - 6);
	const paths = series.map(([i, color]) => {
		const d = pts.filter((p) => p[i] !== null && p[i] !== undefined).map((p, k) => `${k ? "L" : "M"}${x(p[0]).toFixed(1)},${y(p[i]).toFixed(1)}`).join("");
		return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
	});
	const grid = [0.25, 0.5, 0.75].map((f) => `<line x1="0" x2="${w}" y1="${hh * f}" y2="${hh * f}" stroke="rgba(255,255,255,.05)"/>`).join("");
	const last = pts[pts.length - 1];
	const stat = series.map(([i, color], k) => {
		const v = pts.map((p) => p[i]).filter((v2) => v2 !== null && v2 !== undefined);
		return h("span", { class: "chart-stat" }, h("i", { style: `background:${color}` }), names ? `${names[k]} ` : "", `${t("host.now")} ${unit(last[i] ?? 0)} · ${t("host.max")} ${unit(Math.max(...v))} · Ø ${unit(v.reduce((a, b) => a + b, 0) / v.length)}`);
	});
	const hours = [0, 6, 12, 18, 24].map((hr) => new Date(t0 + hr * 3600 * 1000).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" }));
	return h("div", {},
		h("div", { html: `<svg class="host-svg" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none">${grid}${paths.join("")}</svg>` }),
		h("div", { class: "axis", style: "padding:4px 0 0" }, hours.map((x2) => h("span", {}, x2))),
		h("div", { class: "chart-stats" }, stat));
}

// ---------- service form ----------

async function serviceForm(s, prefill = {}, onSaved) {
	const isNew = !s || !s.id;
	const cur = { name: "", url: "", icon: "", kind: null, container: null, check: true, insecure: false, secrets: {}, ...(s || {}), ...prefill };
	const sheet = openSheet();
	const preview = h("span", { style: "display:contents" });
	const updatePreview = () => preview.replaceChildren(html(logo({ name: name.value || "?", icon: icon.value.trim(), kind: kind.value || null }, "logo")));
	sheet.head(h("div", { class: "tt" }, h("b", {}, isNew ? t("form.newService") : t("form.editService"))));
	const name = h("input", { class: "input", value: cur.name, oninput: updatePreview, maxlength: 60 });
	const url = h("input", { class: "input", value: cur.url, placeholder: t("form.urlPh"), inputmode: "url", autocapitalize: "off", spellcheck: "false" });
	const urlAway = h("input", { class: "input", value: cur.urlAway || "", placeholder: t("form.urlAwayPh"), inputmode: "url", autocapitalize: "off", spellcheck: "false" });
	const icon = h("input", { class: "input", value: cur.icon, placeholder: slug(cur.name) || "sonarr", oninput: updatePreview, autocapitalize: "off", spellcheck: "false" });
	const kind = h("select", { class: "input", onchange: () => (drawSecrets(), updatePreview()) }, h("option", { value: "" }, t("form.kindNone")), Object.entries(S.state.kinds).map(([k, v]) => h("option", { value: k, selected: cur.kind === k }, L(v.label))));
	const container = h("select", { class: "input" }, h("option", { value: "" }, t("form.noContainer")));
	if (cur.container) container.append(h("option", { value: cur.container, selected: true }, cur.container));
	const check = h("input", { type: "checkbox", checked: cur.check !== false });
	// how it's checked: HTTP, HTTP with a text, TCP port, ping, DNS
	const ck = { type: cur.checkType || "http", target: cur.checkTarget || "", keyword: cur.keyword || "", absent: !!cur.keywordAbsent, codes: cur.codes || "", dnsServer: cur.dnsServer || "", dnsType: cur.dnsType || "A", dnsExpect: cur.dnsExpect || "", cert: cur.certWarn !== false };
	const checkBox = h("div", { class: "check-box" });
	const drawCheck = () => {
		const inp = (k, ph, mono) => h("input", { class: `input${mono ? " mono" : ""}`, value: ck[k], placeholder: ph, autocapitalize: "off", spellcheck: "false", oninput: (e) => (ck[k] = e.target.value.trim()) });
		const type = h("select", { class: "input", onchange: (e) => ((ck.type = e.target.value), drawCheck()) }, ["http", "keyword", "tcp", "ping", "dns"].map((x) => h("option", { value: x, selected: ck.type === x }, t(`check.${x}`))));
		const rows = [h("div", { class: "field" }, h("label", {}, t("check.type")), type, h("div", { class: "help" }, t(`check.${ck.type}Help`)))];
		if (ck.type === "keyword") rows.push(h("div", { class: "field" }, h("label", {}, t("check.keyword")), inp("keyword", t("check.keywordPh"))), h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("check.absent")), h("span", { class: "switch" }, h("input", { type: "checkbox", checked: ck.absent, onchange: (e) => (ck.absent = e.target.checked) }), h("span"))));
		if (ck.type === "tcp" || ck.type === "ping" || ck.type === "dns") rows.push(h("div", { class: "field" }, h("label", {}, t(`check.target.${ck.type}`)), inp("target", ck.type === "tcp" ? "192.168.1.1:22" : ck.type === "dns" ? "example.com" : "192.168.1.1", true), h("div", { class: "help" }, t("check.targetHelp"))));
		if (ck.type === "dns") rows.push(h("div", { class: "check-dns" }, h("div", { class: "field" }, h("label", {}, t("check.dnsServer")), inp("dnsServer", "192.168.1.2", true)), h("div", { class: "field" }, h("label", {}, t("check.dnsType")), h("select", { class: "input", onchange: (e) => (ck.dnsType = e.target.value) }, ["A", "AAAA", "CNAME", "MX", "TXT", "NS"].map((x) => h("option", { value: x, selected: ck.dnsType === x }, x)))), h("div", { class: "field" }, h("label", {}, t("check.dnsExpect")), inp("dnsExpect", "192.168.1.10", true))));
		if (ck.type === "http" || ck.type === "keyword") rows.push(h("div", { class: "field" }, h("label", {}, t("check.codes")), inp("codes", "200-299, 401", true), h("div", { class: "help" }, t("check.codesHelp"))), h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("check.cert"), h("div", { class: "help" }, t("check.certHelp"))), h("span", { class: "switch" }, h("input", { type: "checkbox", checked: ck.cert, onchange: (e) => (ck.cert = e.target.checked) }), h("span"))));
		checkBox.replaceChildren(...rows);
	};
	drawCheck();
	const insecure = h("input", { type: "checkbox", checked: !!cur.insecure });
	const secretsBox = h("div");
	const inputs = {};
	const msg = h("div", { class: "form-msg" });
	function drawSecrets() {
		const k = S.state.kinds[kind.value];
		secretsBox.replaceChildren();
		for (const key of Object.keys(inputs)) delete inputs[key];
		if (!k) return;
		for (const f of k.fields) {
			const isSet = cur.secrets && cur.secrets[f.key];
			const input = h("input", { class: "input", type: f.secret ? "password" : "text", placeholder: isSet ? t("form.secretSet") : "", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
			inputs[f.key] = input;
			secretsBox.append(h("div", { class: "field" }, h("label", {}, L(f.label)), input, f.help ? h("div", { class: "help" }, L(f.help)) : null));
		}
	}
	drawSecrets();
	updatePreview();
	if (S.state.docker) {
		api("GET", "/api/containers").then((r) => {
			for (const c of r.items) if (c.name !== cur.container) container.append(h("option", { value: c.name }, `${c.name} · ${c.image}`));
		}).catch(() => {});
	}
	const values = () => {
		const secrets = {};
		for (const [k, input] of Object.entries(inputs)) if (input.value !== "") secrets[k] = input.value;
		return { id: isNew ? undefined : s.id, checkType: ck.type, checkTarget: ck.target, keyword: ck.keyword, keywordAbsent: ck.absent, codes: ck.codes, dnsServer: ck.dnsServer, dnsType: ck.dnsType, dnsExpect: ck.dnsExpect, certWarn: ck.cert, name: name.value, url: url.value.trim(), urlAway: urlAway.value.trim(), icon: icon.value.trim(), kind: kind.value || null, container: container.value || null, check: check.checked, insecure: insecure.checked, secrets };
	};
	const testBtn = h("button", { class: "btn", onclick: async () => {
		testBtn.classList.add("busy");
		msg.replaceChildren();
		try {
			const r = await api("POST", "/api/test", values());
			msg.replaceChildren(h("div", { class: "note ok" }, `${t("form.testOk")}${r.detail ? ` · ${r.detail}` : ""}`));
		} catch (err) {
			msg.replaceChildren(h("div", { class: "note bad" }, err.message));
		}
		testBtn.classList.remove("busy");
	} }, t("form.test"));
	const saveBtn = h("button", { class: "btn primary", onclick: async () => {
		saveBtn.classList.add("busy");
		try {
			const r = await api("POST", isNew ? "/api/services" : `/api/services/${s.id}`, values());
			await loadState();
			sheet.close();
			if (onSaved) await onSaved(r.service);
			render();
			setTimeout(loadLive, 1200);
		} catch (err) {
			msg.replaceChildren(h("div", { class: "note bad" }, err.message));
		}
		saveBtn.classList.remove("busy");
	} }, t("form.save"));
	sheet.body.append(
		h("div", { class: "box" },
			h("div", { class: "field" }, h("label", {}, t("form.name")), h("div", { class: "icon-row" }, preview, name)),
			h("div", { class: "field" }, h("label", {}, t("form.url")), url),
			h("div", { class: "field" }, h("label", {}, t("form.urlAway")), urlAway, h("div", { class: "help" }, t("form.urlAwayHelp"))),
			h("div", { class: "field" }, h("label", {}, t("form.icon")), icon, h("div", { class: "help" }, t("form.iconHelp")))),
		h("div", { class: "sec" }, t("form.kind")),
		h("div", { class: "box" }, h("div", { class: "field" }, kind, h("div", { class: "help" }, t("form.kindHelp"))), secretsBox),
		h("div", { class: "sec" }),
		h("div", { class: "box" },
			S.state.docker ? h("div", { class: "field" }, h("label", {}, t("form.container")), container) : null,
			h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("form.check")), h("span", { class: "switch" }, check, h("span"))),
			checkBox,
			h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("form.insecure"), h("div", { class: "help" }, t("form.insecureHelp"))), h("span", { class: "switch" }, insecure, h("span")))),
		msg,
		h("div", { class: "acts" },
			saveBtn, testBtn,
			h("span", { style: "flex:1" }),
			isNew ? null : h("button", { class: "btn danger", onclick: async () => {
				if (!(await confirmSheet(t("form.deleteConfirm", { n: s.name }), t("form.delete"), true))) return;
				if (!(await guard(() => api("POST", `/api/services/${s.id}/delete`)))) return;
				await loadState();
				if (S.editing) S.tiles = structuredClone(board().tiles);
				sheet.close();
				render();
			} }, t("form.delete")))
	);
	if (isNew && !cur.name) setTimeout(() => name.focus(), 250);
}

// "Reachable through Tailscale": switches Tailscale Serve for this service right away.
// In the service details: share it in the tailnet on a port of your choice, the address right below.
function tailscalePart(s, refresh) {
	const ts = S.state.tailscale || {};
	if (!ts.available || !s || !s.id || !ts.local || !ts.local[s.id]) return null;
	if (ts.error) return h("div", { class: "note warn" }, ts.error);
	const link = tsLink(s);
	const current = link ? Number((/:(\d+)$/.exec(link) || [, 443])[1]) : null;
	const homePort = Number((/:(\d+)/.exec(s.url.replace(/^https?:\/\//, "")) || [, s.url.startsWith("https") ? 443 : 80])[1]);
	const port = h("input", { class: "input ts-port", type: "number", min: 1, max: 65535, value: current || (homePort === 80 ? 8080 : homePort) });
	const send = async (enable) => {
		const r = await guard(() => api("POST", `/api/services/${s.id}/tailscale`, { enable, port: Number(port.value) }));
		if (r) {
			S.state.tailscale = r;
			toast(enable ? `${t("ts.on")} ${tsLink(s) || ""}` : t("ts.off"));
		}
		refresh();
	};
	const sw = h("input", { type: "checkbox", checked: !!link, onchange: (e) => ((e.target.disabled = true), send(e.target.checked)) });
	const move = link ? h("button", { class: "btn", style: "padding:6px 12px", onclick: (e) => (Number(port.value) !== current ? (e.currentTarget.classList.add("busy"), send(true)) : null) }, t("ts.move")) : null;
	// the port: always there while shared; while off only as "port 8443 · change"
	const portRow = h("div", { class: "field ts-port-row" }, h("label", {}, t("ts.portLabel")), h("div", { class: "icon-row" }, h("span", { class: "faint sm", style: "white-space:nowrap" }, `https://${ts.dnsName}:`), port, move));
	const portHint = h("button", { class: "ts-port-hint", onclick: () => portHint.replaceWith(portRow) }, t("ts.portHint", { p: port.value }));
	return h("div", { class: "box" },
		h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("ts.share"), link ? h("a", { href: link, target: "_blank", rel: "noopener", class: "help", style: "color:var(--accent)" }, link.replace(/^https:\/\//, "")) : h("div", { class: "help" }, t("ts.offHelp"), " · ", portHint)), h("span", { class: "switch" }, sw, h("span"))),
		link ? portRow : null);
}

// ---------- adding tiles ----------

// Archived notes: newest first, back to the list or gone for good.
function archiveSheet(tile) {
	const sheet = openSheet();
	const draw = () => {
		const list = (tile.archive || []).map((a, i) => ({ ...a, i })).reverse();
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("notes.archiveTitle")), h("span", { class: "sub" }, t("notes.archiveCount", { n: list.length }))));
		sheet.body.replaceChildren(
			list.length
				? h("div", { class: "box rows" }, list.map((a) =>
						h("div", { class: "row" },
							h("div", { class: "grow" }, h("div", { class: "title", style: "white-space:normal", html: markdown(a.text).replace(/^<p>|<\/p>$/g, "") }), h("div", { class: "sub" }, new Date(a.at).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "numeric", year: "numeric" }))),
							h("button", { class: "btn", onclick: () => {
								tile.archive.splice(a.i, 1);
								tile.text = `${notesText(tile).replace(/\s*$/, "")}${notesText(tile).trim() ? "\n" : ""}- [ ] ${a.text}`;
								delete tile.notes;
								saveNotes(tile);
								draw();
							} }, t("notes.restore")),
							h("button", { class: "btn danger", onclick: () => {
								tile.archive.splice(a.i, 1);
								saveNotes(tile);
								draw();
							} }, "×"))))
				: h("div", { class: "note" }, t("notes.archiveEmpty")),
			list.length ? h("div", { class: "acts" }, h("button", { class: "btn danger", onclick: async () => {
				if (!(await confirmSheet(t("notes.clearArchiveConfirm", { n: list.length }), t("notes.clearArchive"), true))) return;
				tile.archive = [];
				saveNotes(tile);
				draw();
			} }, t("notes.clearArchive"))) : null
		);
	};
	draw();
}

// myStrom switch in the tile, MagicMirror restart from the mirror tile
document.addEventListener("click", async (e) => {
	const sw = e.target.closest("[data-ms-mac]");
	const mr = e.target.closest("[data-mm-restart]");
	if ((!sw && !mr) || S.editing) return;
	e.stopPropagation();
	const el = e.target.closest(".bento > .t[data-id]");
	const tile = el && tiles().find((x) => x.id === el.dataset.id);
	if (mr) {
		const mgr = serviceById(mr.dataset.mmRestart);
		if (!mgr || !(await confirmSheet(t("sheet.restartConfirm", { n: "MagicMirror" }), t("sheet.restart")))) return;
		mr.classList.add("busy");
		toast(t("act.restarting", { n: "MagicMirror" }));
		if (await guard(() => api("POST", `/api/services/${mgr.id}/action`, { what: "restart" }))) toast(t("act.done"));
		setTimeout(loadLive, 8000);
		return;
	}
	if (e.target.tagName !== "INPUT") return; // the label passes the click on to its checkbox
	const s = (tile && serviceById(tile.service)) || services().find((x) => x.kind === "mystrom");
	const input = e.target;
	input.disabled = true;
	const r = await guard(() => api("POST", `/api/services/${s.id}/action`, { what: "relay", mac: sw.dataset.msMac, on: input.checked }));
	if (!r) input.checked = !input.checked;
	input.disabled = false;
	setTimeout(loadLive, 1200);
}, true);

// ---------- releases ----------

// The tile object to change: the edit copy while editing, else the board's own.
function liveTile(id) {
	return (S.editing ? S.tiles : board().tiles).find((x) => x.id === id);
}
async function saveBoardTiles() {
	const b = board();
	if (S.editing) b.tiles = structuredClone(S.tiles);
	renderGrid();
	const r = await guard(() => api("POST", `/api/boards/${b.id}/tiles`, { tiles: b.tiles }));
	if (r && !S.editing) b.tiles = r.board.tiles;
	loadLive();
}

document.addEventListener("click", (e) => {
	const el = e.target.closest(".bento > .t[data-id]");
	if (!el) return;
	const rel = e.target.closest("[data-release]");
	const manage = e.target.closest("[data-rel-manage]");
	const seenAll = e.target.closest("[data-rel-seen]");
	if (!rel && !manage && !seenAll) return;
	e.stopPropagation();
	if (S.editing) return;
	const tile = liveTile(el.dataset.id);
	if (!tile) return;
	if (manage) return releasesManageSheet(tile);
	if (seenAll) {
		const data = (S.live && S.live.releases) || {};
		tile.seen = { ...(tile.seen || {}) };
		for (const r of tile.repos || []) if (data[r] && data[r].latest) tile.seen[r] = data[r].latest.tag;
		return saveBoardTiles();
	}
	const [repo, tag] = rel.dataset.release.split("|");
	if (e.target.closest("[data-rel-update]")) {
		const d = S.live && S.live.releases && S.live.releases[repo];
		const s = d && d.service && serviceById(d.service);
		if (s) updateService(s, d);
		return;
	}
	releaseSheet(tile, repo, tag);
}, true);

// Update a container: ask, then follow the log until it is done (or rolled back).
async function updateService(s, d) {
	// the versions big (just the numbers), the full build names small below
	const core = (v) => (/\d+(?:\.\d+)+/.exec(String(v || "")) || [String(v || "")])[0];
	const from = d && d.running;
	const to = d && d.latest && d.latest.tag.replace(/^release-/i, "");
	const body = from && to
		? h("div", { class: "upd-versions" },
				h("div", { class: "upd-ver" }, h("span", { class: "num old" }, core(from)), h("span", { class: "arrow" }, "→"), h("span", { class: "num new" }, core(to))),
				core(from) !== from || core(to) !== to ? h("div", { class: "upd-builds" }, `${from} → ${to}`) : null)
		: null;
	if (!(await confirmSheet({ title: t("upd.confirmTitle", { n: s.name }), body, help: t("upd.confirmHelp") }, t("upd.go")))) return;
	const r = await guard(() => api("POST", `/api/services/${s.id}/update`));
	if (!r) return;
	const sheet = openSheet({ wide: true });
	sheet.head(...headOf(s));
	const status = h("div", { class: "note" }, t("upd.running"));
	const log = h("div", { class: "log" }, "");
	sheet.body.append(status, log);
	for (;;) {
		await new Promise((res) => setTimeout(res, 1500));
		const j = await api("GET", `/api/updates/${r.job}`).catch(() => null);
		if (!j) break;
		log.textContent = j.log.join("\n");
		log.scrollTop = log.scrollHeight;
		if (j.state === "running") continue;
		status.className = `note ${j.state === "done" ? "ok" : "bad"}`;
		status.textContent = j.state === "failed" ? j.error : j.updated ? t("upd.done", { n: s.name }) : j.pinned ? t("upd.pinned") : t("upd.same");
		loadLive();
		break;
	}
}

// Release notes; opening them counts as seen.
// Release notes as GitHub writes them, made readable: no HTML leftovers, short #123 links for
// issues and pull requests, no commit hashes, no empty lines between the points.
function cleanNotes(body) {
	return String(body)
		.replace(/\r/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/?(samp|sup|sub|b|i|em|strong|code|kbd|span|div|p|details|summary)[^>]*>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
		// "[a3f68](…/commit/…)", "(a3f68)" after a point
		.replace(/\s*\[?\(?\b[0-9a-f]{5,12}\b\)?\]?\(https:\/\/github\.com\/[^)]+\/commit\/[0-9a-f]+\)/gi, "")
		.replace(/\s*\(\b[0-9a-f]{5,12}\b\)\s*$/gim, "")
		// list points that start with a full commit hash (LinuxServer, release-drafter)
		.replace(/^(\s*[-*]\s+)[0-9a-f]{7,40}\s+/gim, "$1")
		// "compare/v1...v2" links: short
		.replace(/(?<!\()https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/compare\/\S+/g, (u) => `[${t("rel.compare")}](${u})`)
		// links to issues and pull requests: #123
		.replace(/(?<!\()https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)(?:#[\w-]+)?/g, (u, n) => `[#${n}](${u})`)
		.replace(/[ \t]+-[ \t]+by /g, " – by ")
		.replace(/^(#{1,6})\s+/gm, "$1 ")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n");
}

async function releaseSheet(tile, repo, tag) {
	const n = await guard(() => api("GET", `/api/releases/notes?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`));
	if (!n) return;
	tile.seen = { ...(tile.seen || {}), [repo]: tag };
	saveBoardTiles();
	const sheet = openSheet({ wide: true });
	sheet.head(h("div", { class: "tt" }, h("b", {}, `${repo.split("/")[1]} ${n.tag}`), h("span", { class: "sub" }, `${repo}${n.date ? ` · ${new Date(n.date).toLocaleDateString(LOCALE, { day: "numeric", month: "long", year: "numeric" })}` : ""}`)));
	sheet.body.append(
		n.name && n.name !== n.tag ? h("div", { class: "sec", style: "margin-top:4px" }, n.name) : null,
		h("div", { class: "md rel-notes", html: n.body ? markdown(cleanNotes(n.body)) : `<p class="faint">${t("rel.noNotes")}</p>` }),
		h("div", { class: "acts" },
			(() => {
				const d = S.live && S.live.releases && S.live.releases[repo];
				const s = d && d.current === false && d.service && serviceById(d.service);
				return s && s.container ? h("button", { class: "btn primary", onclick: () => (sheet.close(), updateService(s, d)) }, t("upd.button", { v: d.latest.tag })) : null;
			})(),
			h("a", { class: "btn", href: n.url, target: "_blank", rel: "noopener noreferrer" }, html(UI.open), t("rel.onGithub")))
	);
}

// Subscriptions: what is subscribed, suggestions from the services, any repository by hand.
async function releasesManageSheet(tile) {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("rel.manageTitle"))));
	const sugg = (await api("GET", "/api/releases/suggest").catch(() => ({ items: [] }))).items;
	const input = h("input", { class: "input", placeholder: "owner/repo · https://github.com/…", autocapitalize: "off", spellcheck: "false" });
	const msg = h("div");
	const add = async (repo) => {
		tile.repos = [...new Set([...(tile.repos || []), repo])];
		await saveBoardTiles();
		draw();
	};
	const draw = () => {
		const data = (S.live && S.live.releases) || {};
		const subscribed = (tile.repos || []).map((r) =>
			h("div", { class: "ts-row" }, h("div", { class: "grow" }, h("div", { class: "title" }, r), h("div", { class: "sub" }, data[r] && data[r].latest ? data[r].latest.tag : data[r] && data[r].error ? data[r].error : "…")),
				h("button", { class: "ts-x", style: "opacity:1", title: t("tile.remove"), onclick: async () => {
					tile.repos = tile.repos.filter((x) => x !== r);
					if (tile.seen) delete tile.seen[r];
					await saveBoardTiles();
					draw();
				}, html: UI.x }))
		);
		const open = sugg.filter((x) => !(tile.repos || []).includes(x.repo));
		const sRows = open.map((x) => {
			const svc = serviceById(x.service);
			return h("div", { class: "ts-row" }, html(svc ? logo(svc) : ""), h("div", { class: "grow" }, h("div", { class: "title" }, svc ? svc.name : x.repo), h("div", { class: "sub" }, x.repo)), h("button", { class: "btn", style: "padding:6px 12px;background:var(--tile-3)", onclick: () => add(x.repo) }, "+"));
		});
		sheet.body.replaceChildren(
			h("div", { class: "sec" }, t("rel.subscribed"), h("span", { class: "faint" }, String((tile.repos || []).length))),
			h("div", { class: "box" }, subscribed.length ? subscribed : h("div", { class: "ts-row" }, h("span", { class: "sub" }, t("rel.none")))),
			open.length ? h("div", { class: "sec" }, t("rel.suggestions"), h("button", { class: "btn", style: "padding:4px 10px", onclick: async () => {
				tile.repos = [...new Set([...(tile.repos || []), ...open.map((x) => x.repo)])];
				await saveBoardTiles();
				draw();
			} }, t("add.all"))) : null,
			open.length ? h("div", { class: "box" }, sRows) : null,
			h("div", { class: "sec" }, t("rel.other")),
			h("div", { class: "box" }, h("div", { class: "field" }, h("div", { class: "icon-row" }, input, h("button", { class: "btn primary", onclick: async (e) => {
				const b = e.currentTarget;
				b.classList.add("busy");
				try {
					const r = await api("GET", `/api/releases/check?repo=${encodeURIComponent(input.value)}`);
					input.value = "";
					msg.replaceChildren();
					await add(r.repo);
				} catch (err) {
					msg.replaceChildren(h("div", { class: "note bad", style: "margin-top:8px" }, err.message));
				}
				b.classList.remove("busy");
			} }, t("rel.add"))))),
			msg
		);
	};
	draw();
}

// Info card for a movie or show (Jellyfin, Radarr, Sonarr).
async function mediaSheet(sid, ref) {
	const s = serviceById(sid);
	if (!s) return;
	const m = await guard(() => api("GET", `/api/media/${sid}/${encodeURIComponent(ref)}`));
	if (!m) return;
	const sheet = openSheet({ wide: true });
	sheet.head(h("div", { class: "tt" }, h("b", {}, m.title), h("span", { class: "sub" }, [m.year, m.certification, m.network].filter(Boolean).join(" · "))));
	const facts = [
		m.rating ? `★ ${nf(m.rating, 1)}` : null,
		m.runtime ? t("media.min", { n: m.runtime }) : null,
		m.seasons ? t("media.seasons", { n: m.seasons }) : null,
		m.episodes && m.episodes.total ? t("media.episodes", { a: m.episodes.have ?? 0, b: m.episodes.total }) : null,
		m.downloaded === true ? t("media.downloaded") : m.downloaded === false ? t("media.missing") : null,
		m.size ? fmtBytes(m.size) : null
	].filter(Boolean);
	sheet.body.append(
		h("div", { class: "media" },
			h("div", { class: "media-poster", style: `background-image:url('/api/img/${sid}/${encodeURIComponent(ref)}')` }),
			h("div", { class: "media-info" },
				m.genres.length ? h("div", { class: "media-genres" }, m.genres.slice(0, 4).map((g) => h("span", { class: "chip" }, g))) : null,
				facts.length ? h("div", { class: "media-facts" }, facts.join(" · ")) : null,
				m.overview ? h("p", { class: "media-overview" }, m.overview) : null,
				h("div", { class: "acts" }, m.links.map((l, i) => h("a", { class: `btn${i === 0 ? " primary" : ""}`, href: l.url, target: "_blank", rel: "noopener noreferrer" }, html(UI.open), t("media.open", { n: l.name }))))))
	);
}

const DEFAULT_SIZE = { storage: [2, 1], arr: [3, 2], api: [2, 2], markets: [2, 2], holidays: [2, 2], countdown: [2, 1], camera: [2, 2], weather: [2, 2], clock: [2, 1], disks: [2, 2], network: [2, 2], ical: [2, 2], rss: [2, 3], iframe: [3, 2], mystrom: [2, 2], energy: [2, 2], mirror: [2, 2], releases: [2, 3], tailscale: [2, 2], docker: [3, 2], events: [3, 3], service: [1, 1], status: [2, 1], host: [2, 2], uptime: [2, 2], jellyfin: [3, 3], recent: [3, 2], calendar: [3, 2], downloads: [3, 1], solar: [2, 2], links: [2, 2], notes: [2, 2] };

function addTile(tile) {
	const [w, hh] = DEFAULT_SIZE[tile.type];
	if (!S.editing) {
		S.editing = true;
		S.tiles = structuredClone(board().tiles);
		render();
	}
	const id = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
	const added = { id, w, h: hh, ...tile };
	S.tiles.push(added);
	saveTiles();
	renderGrid();
	return added;
}

// extra search words for the tiles in "Add tile"
const ADD_KEYS = {
	host: "server system cpu memory ram arbeitsspeicher temperature temperatur",
	uptime: "uptime status monitoring history verlauf verfügbarkeit",
	docker: "container",
	events: "events log history ereignisse verlauf",
	releases: "releases updates github versions versionen",
	calendar: "calendar kalender upcoming episodes movies episoden filme",
	storage: "storage speicher platz space disk movies shows filme serien grösse size",
	ical: "calendar kalender ical ics caldav google icloud outlook nextcloud events termine appointments",
	weather: "weather wetter forecast prognose",
	clock: "clock uhr time zeit timezone zeitzone analog",
	disks: "disks storage drives speicher festplatten laufwerke",
	network: "network netzwerk traffic bandwidth bandbreite",
	rss: "rss atom feed news nachrichten",
	iframe: "iframe embed website webseite einbetten",
	api: "api json rest custom eigene",
	markets: "markets märkte stocks aktien crypto krypto bitcoin currency währung forex",
	holidays: "holidays feiertage",
	countdown: "countdown timer date datum",
	camera: "camera kamera webcam stream snapshot mjpeg",
	links: "links bookmarks lesezeichen",
	notes: "notes notizen markdown todo",
	recent: "recently added movies shows filme serien neu",
	arr: "sonarr radarr prowlarr queue missing indexers warteschlange fehlt"
};

// the tiles the command palette can add: title and subtitle
const ADD_TILES = { storage: "sto.title", host: "add.host", uptime: "add.uptime", events: "ev.title", releases: "rel.title", calendar: "add.calendar", ical: "ical.title", weather: "wx.title", clock: "clk.title", disks: "disks.title", network: "net.title", rss: "rss.title", iframe: "frame.title", api: "api.title", markets: "mk.title", holidays: "hol.title", countdown: "cd.title", camera: "cam.title", links: "add.links", notes: "add.notes" };
const ADD_SUBS = { storage: "add.storageSub", host: "add.hostSub", uptime: "add.uptimeSub", events: "add.eventsSub", releases: "add.releasesSub", calendar: "add.calendarSub", ical: "add.icalSub", weather: "add.weatherSub", clock: "add.clockSub", disks: "add.disksSub", network: "add.netSub", rss: "add.rssSub", iframe: "add.frameSub", api: "add.apiSub", markets: "add.marketsSub", holidays: "add.holidaysSub", countdown: "add.countdownSub", camera: "add.cameraSub", links: "add.linksSub", notes: "add.notesSub" };

async function addTileSheet(query) {
	// also from the command palette: adding happens in edit mode
	if (!S.editing) toggleEdit();
	const sheet = openSheet();
	// a search over everything below: suggestions, services, tiles
	const search = h("input", { class: "input add-search", type: "search", placeholder: t("add.searchPh"), autocomplete: "off", spellcheck: "false", oninput: () => applySearch() });
	sheet.head(h("div", { class: "tt add-head" }, h("b", {}, t("add.title")), search));
	setTimeout(() => search.focus(), 250);
	const applySearch = () => {
		const q = search.value.trim().toLowerCase();
		const words = q.split(/\s+/).filter(Boolean);
		let any = false;
		for (const box of sheet.body.querySelectorAll(".box.rows")) {
			let shown = 0;
			for (const r of box.children) {
				const text = `${r.textContent} ${r.dataset.keys || ""}`.toLowerCase();
				const hit = !words.length || words.every((w) => text.includes(w));
				r.style.display = hit ? "" : "none";
				if (hit) shown++;
			}
			box.style.display = shown ? "" : "none";
			const sec = box.previousElementSibling;
			if (sec && sec.classList.contains("sec")) sec.style.display = shown ? "" : "none";
			if (shown) any = true;
		}
		let none = sheet.body.querySelector(".add-none");
		if (!any && words.length) {
			if (!none) sheet.body.append((none = h("div", { class: "note add-none" }, t("add.nothing"))));
		} else if (none) none.remove();
	};
	const onBoard = (pred) => S.tiles.some(pred);
	// a tile's add button knows its type, so the search also finds it by other words (in both languages)
	const row = (logoHtml, title, sub, onclick, done) =>
		h("button", { disabled: !!done, onclick, "data-keys": (onclick && ADD_KEYS[onclick.type]) || "" }, html(logoHtml), h("div", { class: "grow" }, h("div", { class: "title" }, title), sub ? h("div", { class: "sub" }, sub) : null), done ? h("span", { class: "done" }, done) : h("span", { class: "plus" }, "+"));
	const glyphLogo = (g, c) => `<span class="logo" style="--c:${c}">${svg(GLYPHS[g] || g)}</span>`;
	const dockerBox = h("div", { class: "box rows" }, h("div", { class: "row" }, h("span", { class: "sub" }, "…")));
	const draw = () => {
		const content = [];
		const add = (tile) => Object.assign(() => {
			addTile(tile);
			toast(t("add.added"));
			draw();
		}, { type: tile.type });
		content.push(row(glyphLogo("server", "#9dbcff"), t("add.host"), t("add.hostSub"), add({ type: "host" }), onBoard((x) => x.type === "host") && t("add.onBoard")));
		content.push(row(glyphLogo("<path d='M4 18V8M9 18V5M14 18v-7M19 18V9'/>", "#5fd39a"), t("add.uptime"), t("add.uptimeSub"), add({ type: "uptime" }), onBoard((x) => x.type === "uptime") && t("add.onBoard")));
		if (S.state.docker) content.push(row(glyphLogo("<path d='M3 13h18a6 6 0 01-6 6H9a6 6 0 01-6-6z'/><path d='M5 13V9h3v4M8 13V9h3v4M11 13V9h3v4M8 9V5h3v4M14 13V9h3v4'/>", "#2496ed"), "Docker", t("add.dockerSub"), add({ type: "docker" }), onBoard((x) => x.type === "docker") && t("add.onBoard")));
		content.push(row(glyphLogo("<path d='M12 7v5l3 2'/><circle cx='12' cy='12' r='8.5'/>", "#9dbcff"), t("ev.title"), t("add.eventsSub"), add({ type: "events" }), onBoard((x) => x.type === "events") && t("add.onBoard")));
		content.push(row(glyphLogo("<path d='M12 3v12M7 10l5 5 5-5M5 21h14'/>", "#9dbcff"), t("rel.title"), t("add.releasesSub"), async () => {
			// start with the repositories of the services
			const s0 = await api("GET", "/api/releases/suggest").catch(() => ({ items: [] }));
			addTile({ type: "releases", repos: [...new Set(s0.items.map((x) => x.repo))], seen: {} });
			toast(t("add.added"));
			draw();
		}, onBoard((x) => x.type === "releases") && t("add.onBoard")));
		if (S.state.tailscale && S.state.tailscale.available) content.push(row(glyphLogo("<circle cx='6' cy='6' r='1.8'/><circle cx='12' cy='6' r='1.8'/><circle cx='18' cy='6' r='1.8'/><circle cx='6' cy='12' r='1.8'/><circle cx='12' cy='12' r='1.8'/><circle cx='18' cy='12' r='1.8'/><circle cx='12' cy='18' r='1.8'/>", "#9aa4b2"), "Tailscale", t("add.tsSub"), add({ type: "tailscale" }), onBoard((x) => x.type === "tailscale") && t("add.onBoard")));
		for (const s of services()) {
			const k = s.kind && S.state.kinds[s.kind];
			if (s.kind === "solar") content.push(row(logo(s), `${s.name}: ${t("en.title")}`, null, add({ type: "energy", service: s.id }), onBoard((x) => x.type === "energy") && t("add.onBoard")));
			if (s.kind === "magicmirror") content.push(row(logo(s), `${s.name}: ${t("add.mirror")}`, null, add({ type: "mirror", service: s.id }), onBoard((x) => x.type === "mirror") && t("add.onBoard")));
			if (["sonarr", "radarr", "prowlarr"].includes(s.kind)) content.push(row(logo(s), `${s.name}: ${t(s.kind === "prowlarr" ? "arr.addProwlarr" : "arr.add")}`, null, add({ type: "arr", service: s.id }), onBoard((x) => x.type === "arr" && x.service === s.id) && t("add.onBoard")));
			if (!k || !k.tile || k.tile === "calendar") continue;
			content.push(row(logo(s), `${s.name}: ${t(k.tile === "jellyfin" ? "jf.now" : k.tile === "downloads" ? "dl.title" : k.tile === "mystrom" ? "ms.devices" : "solar.title")}`, null, add({ type: k.tile, service: s.id }), onBoard((x) => x.type === k.tile && x.service === s.id) && t("add.onBoard")));
			if (k.tile === "jellyfin") content.push(row(logo(s), `${s.name}: ${t("add.recent")}`, null, add({ type: "recent", service: s.id }), onBoard((x) => x.type === "recent" && x.service === s.id) && t("add.onBoard")));
		}
		if (services().some((s) => s.kind === "sonarr" || s.kind === "radarr")) content.push(row(glyphLogo("<rect x='4' y='5' width='16' height='15' rx='3'/><path d='M4 10h16M9 3v4M15 3v4'/>", "#35c5f4"), t("add.calendar"), t("add.calendarSub"), add({ type: "calendar" }), onBoard((x) => x.type === "calendar") && t("add.onBoard")));
		if (services().some((s) => s.kind === "sonarr" || s.kind === "radarr")) content.push(row(glyphLogo("<ellipse cx='12' cy='6' rx='7.5' ry='2.8'/><path d='M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8'/>", "#ffc230"), t("sto.title"), t("add.storageSub"), add({ type: "storage" }), onBoard((x) => x.type === "storage") && t("add.onBoard")));
		const addAndSetUp = (tile) => Object.assign(() => {
			const added = addTile(tile);
			draw();
			tileOptions(added);
		}, { type: tile.type });
		content.push(row(glyphLogo("<path d='M7 17.5h10a4 4 0 00.5-8 5.8 5.8 0 00-10.9-1.2A4.6 4.6 0 007 17.5z'/>", "#6fb3ff"), t("wx.title"), t("add.weatherSub"), S.state.config.location ? add({ type: "weather" }) : addAndSetUp({ type: "weather" })));
		content.push(row(glyphLogo("<circle cx='12' cy='12' r='8.5'/><path d='M12 7.5V12l3 2'/>", "#9dbcff"), t("clk.title"), t("add.clockSub"), add({ type: "clock" }), onBoard((x) => x.type === "clock") && t("add.onBoard")));
		content.push(row(glyphLogo("<ellipse cx='12' cy='6' rx='7.5' ry='2.8'/><path d='M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8'/>", "#9dbcff"), t("disks.title"), t("add.disksSub"), add({ type: "disks" }), onBoard((x) => x.type === "disks") && t("add.onBoard")));
		content.push(row(glyphLogo("<path d='M7 4v14M3.5 14.5L7 18l3.5-3.5M17 20V6M13.5 9.5L17 6l3.5 3.5'/>", "#5fd39a"), t("net.title"), t("add.netSub"), add({ type: "network" }), onBoard((x) => x.type === "network") && t("add.onBoard")));
		content.push(row(glyphLogo("<rect x='4' y='5' width='16' height='15' rx='3'/><path d='M4 10h16M9 3v4M15 3v4M8 14h3'/>", "#9dbcff"), t("ical.title"), t("add.icalSub"), addAndSetUp({ type: "ical", calendars: [] })));
		content.push(row(glyphLogo("<path d='M5 5a14 14 0 0114 14M5 11a8 8 0 018 8'/><circle cx='6' cy='18' r='1.3'/>", "#ff9f5a"), t("rss.title"), t("add.rssSub"), addAndSetUp({ type: "rss", feeds: [] })));
		content.push(row(glyphLogo("<rect x='3.5' y='4.5' width='17' height='15' rx='3'/><path d='M3.5 9h17M7 6.8h.01M9.5 6.8h.01'/>", "#9dbcff"), t("frame.title"), t("add.frameSub"), addAndSetUp({ type: "iframe" })));
		content.push(row(glyphLogo("<path d='M8 7l-5 5 5 5M16 7l5 5-5 5M13.5 5l-3 14'/>", "#9dbcff"), t("api.title"), t("add.apiSub"), addAndSetUp({ type: "api", api: { url: "", method: "GET", headers: [], fields: [], ttl: 60 } })));
		content.push(row(glyphLogo("<path d='M4 17l5-5 4 3 7-8'/><path d='M15 7h5v5'/>", "#5fd39a"), t("mk.title"), t("add.marketsSub"), addAndSetUp({ type: "markets", symbols: ["^GSPC"], fx: ["EUR", "USD"], crypto: [], base: "CHF" })));
		content.push(row(glyphLogo("<path d='M5 21V4M5 4h11l-2 4 2 4H5'/>", "#ff6066"), t("hol.title"), t("add.holidaysSub"), addAndSetUp({ type: "holidays", canton: "ZH" })));
		content.push(row(glyphLogo("<circle cx='12' cy='13' r='7.5'/><path d='M12 9v4l2.5 2M9.5 2.5h5'/>", "#c792ea"), t("cd.title"), t("add.countdownSub"), addAndSetUp({ type: "countdown", items: [] })));
		content.push(row(glyphLogo("<rect x='3' y='6' width='13' height='12' rx='2.5'/><path d='M16 10l5-3v10l-5-3'/>", "#9dbcff"), t("cam.title"), t("add.cameraSub"), addAndSetUp({ type: "camera", mode: "snapshot", refresh: 5 })));
		content.push(row(glyphLogo("link", "#9dbcff"), t("add.links"), t("add.linksSub"), add({ type: "links", links: [] })));
		content.push(row(glyphLogo("<rect x='5' y='4' width='14' height='16' rx='3'/><path d='M9 9h6M9 13h6M9 17h3'/>", "#f5b83d"), t("add.notes"), t("add.notesSub"), add({ type: "notes", notes: [] })));
		const mine = services().map((s) => row(logo(s), s.name, s.url.replace(/^https?:\/\//, ""), add({ type: "service", service: s.id }), onBoard((x) => x.type === "service" && x.service === s.id) && t("add.onBoard")));
		sheet.body.replaceChildren(
			h("div", { class: "sec" }, t("add.docker")),
			dockerBox,
			h("div", { class: "box rows", style: "margin-top:8px" }, row(`<span class="logo" style="--c:#9dbcff">${UI.plus}</span>`, t("add.new"), t("add.newSub"), () => serviceForm(null, {}, (svc) => (addTile({ type: "service", service: svc.id }), draw())))),
			mine.length ? h("div", { class: "sec" }, t("add.services")) : null,
			mine.length ? h("div", { class: "box rows" }, mine) : null,
			h("div", { class: "sec" }, t("add.content")),
			h("div", { class: "box rows" }, content)
		);
		applySearch();
	};
	const loadDocker = async () => {
		if (!S.state.docker) return dockerBox.replaceChildren(h("div", { class: "row" }, h("span", { class: "sub" }, t("add.dockerOff"))));
		const r = await api("GET", "/api/discover").catch((err) => ({ items: [], error: err.message }));
		const items = r.items || [];
		if (!items.length) return dockerBox.replaceChildren(h("div", { class: "row" }, h("span", { class: "sub" }, r.error || (r.docker === false ? t("add.dockerOff") : t("add.dockerNone")))));
		const withUrl = items.filter((it) => it.url && it.state === "running");
		dockerBox.replaceChildren(
			withUrl.length > 1 ? h("div", { class: "row" }, h("span", { class: "sub grow" }, `${withUrl.length} ×`), h("button", { class: "btn primary", onclick: async (e) => { if (await autoSetup(e.currentTarget)) sheet.close(); } }, t("add.all"))) : "",
			...items.map((it) =>
				row(logo({ name: it.name, icon: it.icon }), it.name, `${it.url ? it.url.replace(/^https?:\/\//, "") : it.image}${it.state !== "running" ? ` · ${it.state}` : ""}`, () =>
					serviceForm(null, { name: it.name, url: it.url, icon: it.icon, kind: it.kind, container: it.container }, (svc) => {
						addTile({ type: "service", service: svc.id });
						loadDocker();
						draw();
					})
				)
			)
		);
		applySearch();
	};
	if (typeof query === "string") search.value = query;
	draw();
	loadDocker();
}

function linksSheet(tile) {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("links.edit"))));
	const links = (tile.links || []).map((l) => ({ ...l }));
	const list = h("div", { class: "box" });
	const title = h("input", { class: "input", value: tile.title || "", placeholder: t("links.title") });
	const draw = () =>
		list.replaceChildren(
			...links.map((l, i) =>
				h("div", { class: "link-edit" },
					h("input", { class: "input", value: l.name, placeholder: t("links.name"), oninput: (e) => (l.name = e.target.value) }),
					h("input", { class: "input", value: l.url, placeholder: "https://", inputmode: "url", autocapitalize: "off", oninput: (e) => (l.url = e.target.value.trim()) }),
					h("button", { class: "x", style: "width:30px;height:30px;border-radius:50%;background:var(--tile-3);display:grid;place-items:center", onclick: () => (links.splice(i, 1), draw()), html: UI.x }))
			),
			h("div", { class: "field" }, h("button", { class: "btn", onclick: () => (links.push({ name: "", url: "" }), draw()) }, html(UI.plus), t("links.add")))
		);
	draw();
	sheet.body.append(
		h("div", { class: "box" }, h("div", { class: "field" }, h("label", {}, t("settings.title")), title)),
		h("div", { class: "sec" }, t("links.title")),
		list,
		h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => {
			updateTile(tile.id, { links: links.filter((l) => /^https?:\/\//.test(l.url)), title: title.value.trim() || undefined });
			sheet.close();
		} }, t("form.save")))
	);
}

// ---------- tile options ----------

const OPTION_TILES = ["links", "weather", "clock", "ical", "rss", "iframe", "disks", "api", "markets", "holidays", "countdown", "camera"];

// Changes a tile: while editing in the edited copy, else right on the board.
function updateTile(id, patch) {
	if (S.editing) {
		const tl = S.tiles.find((x) => x.id === id);
		if (tl) Object.assign(tl, patch);
		saveTiles();
	} else {
		const b = board();
		const tl = b.tiles.find((x) => x.id === id);
		if (!tl) return;
		Object.assign(tl, patch);
		guard(() => api("POST", `/api/boards/${b.id}/tiles`, { tiles: b.tiles })).then((r) => {
			if (r) b.tiles = r.board.tiles;
			loadLive();
		});
	}
	renderGrid();
}

async function tileOptions(tile) {
	if (tile.type === "links") return linksSheet(tile);
	if (MORE_OPTIONS[tile.type]) return MORE_OPTIONS[tile.type](tile);
	const sheet = openSheet();
	const title = h("input", { class: "input", value: tile.title || "", placeholder: t(`${tile.type === "iframe" ? "frame" : tile.type}.title`), maxlength: 40 });
	const titleBox = h("div", { class: "box" }, h("div", { class: "field" }, h("label", {}, t("settings.title")), title));
	const save = (patch) => {
		updateTile(tile.id, { title: title.value.trim() || undefined, ...patch });
		sheet.close();
	};
	const saveBtn = (get) => h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => save(get()) }, t("form.save")));

	if (tile.type === "weather") {
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("wx.title"))));
		let place = tile.place || null;
		const def = S.state.config.location;
		const cur = h("div", { class: "place-now" });
		const reset = h("button", { class: "btn", onclick: () => ((place = null), show()) }, t("wx.useDefault"));
		const show = () => {
			cur.replaceChildren(place ? t("wx.ownPlace", { n: place.name }) : def ? t("wx.defaultPlace", { n: def.name }) : h("span", { class: "faint" }, t("wx.noPlace")));
			reset.style.display = place && def ? "" : "none";
		};
		show();
		sheet.body.append(
			h("div", { class: "box" }, h("div", { class: "field" }, h("label", {}, t("wx.place")), cur, placePicker((p) => ((place = p), show())), h("div", { class: "help" }, t("wx.placeHelp")), reset)),
			saveBtn(() => ({ place: place || undefined }))
		);
		return;
	}

	if (tile.type === "clock") {
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("clk.title"))));
		const sec = h("input", { type: "checkbox", checked: !!tile.seconds });
		const face = h("select", { class: "input" }, [["digital", t("clk.digital")], ["analog", t("clk.analog")]].map(([v, l]) => h("option", { value: v, selected: (tile.analog ? "analog" : "digital") === v }, l)));
		const zones = (tile.zones || []).map((z) => ({ ...z }));
		const list = h("div", { class: "zone-list" });
		const timeIn = (zone) => new Date().toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", timeZone: zone });
		const draw = () =>
			list.replaceChildren(
				...zones.map((z, i) =>
					h("div", { class: "zone-row" },
						h("div", { class: "zone-time num" }, timeIn(z.zone)),
						h("input", { class: "input", value: z.name, placeholder: cityOf(z.zone), oninput: (e) => (z.name = e.target.value) }),
						h("span", { class: "faint sm zone-id" }, z.zone.replace(/_/g, " ")),
						h("button", { class: "x row-x", onclick: () => (zones.splice(i, 1), draw()), html: UI.x }))
				),
				zones.length < 4 ? zonePicker((z) => (zones.push(z), draw())) : null
			);
		draw();
		sheet.body.append(
			h("div", { class: "box" },
				h("div", { class: "field" }, h("label", {}, t("clk.face")), face),
				h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("clk.seconds")), h("span", { class: "switch" }, sec, h("span")))),
			h("div", { class: "sec" }, t("clk.zones")),
			h("div", { class: "box" }, list),
			saveBtn(() => ({ seconds: sec.checked, analog: face.value === "analog", zones: zones.filter((z) => z.zone) }))
		);
		return;
	}

	if (tile.type === "ical" || tile.type === "rss") {
		const ical = tile.type === "ical";
		sheet.head(h("div", { class: "tt" }, h("b", {}, t(ical ? "ical.title" : "rss.title"))));
		const COLORS = ["#9dbcff", "#5fd39a", "#f5b83d", "#ff8a65", "#c792ea", "#4dd0e1"];
		const items = ((ical ? tile.calendars : tile.feeds) || []).map((c) => ({ ...c }));
		// private calendars: a login per calendar (stays on the server)
		const logins = {};
		const hasLogin = ical && tile.id ? ((await api("GET", `/api/tiles/${tile.id}/secrets`).catch(() => ({ secrets: {} }))).secrets || {}) : {};
		// a login for a private calendar: folded away until needed
		const calLogin = (c) => {
			c.id = c.id || hex10();
			const set = hasLogin[`${c.id}:user`] || hasLogin[`${c.id}:password`];
			const l = (logins[c.id] = logins[c.id] || {});
			const box = h("div", { class: "cal-login" });
			const open = () =>
				box.replaceChildren(
					h("input", { class: "input", placeholder: set ? t("form.secretSet") : t("form.user"), autocomplete: "off", oninput: (e) => (l.user = e.target.value) }),
					h("input", { class: "input", type: "password", placeholder: set ? t("form.secretSet") : t("ical.appPassword"), autocomplete: "off", oninput: (e) => (l.password = e.target.value) }),
					set ? h("button", { class: "chip", onclick: () => ((l.user = ""), (l.password = ""), toast(t("ical.loginRemoved"))) }, t("ical.removeLogin")) : null
				);
			if (set) open();
			else box.replaceChildren(h("button", { class: "chip", onclick: open }, t("ical.addLogin")));
			return box;
		};
		const list = h("div");


		const draw = () =>
			list.replaceChildren(
				...items.map((c, i) =>
					h("div", { class: `link-edit${ical ? " with-color" : ""}` },
						ical ? h("input", { type: "color", class: "color-in", value: c.color || COLORS[i % COLORS.length], oninput: (e) => (c.color = e.target.value) }) : null,
						h("input", { class: "input", value: c.name || "", placeholder: t("links.name"), oninput: (e) => (c.name = e.target.value) }),
						h("input", { class: "input", value: c.url || "", placeholder: ical ? "https://… .ics · webcal://…" : "https://…/rss", inputmode: "url", autocapitalize: "off", spellcheck: "false", oninput: (e) => (c.url = e.target.value.trim()) }),
						h("button", { class: "x row-x", onclick: () => (items.splice(i, 1), draw()), html: UI.x }),
						ical ? calLogin(c) : null)
				),
				h("div", { class: "field" }, h("button", { class: "btn", onclick: () => (items.push({ name: "", url: "", color: COLORS[items.length % COLORS.length] }), draw()) }, html(UI.plus), t(ical ? "ical.add" : "rss.add")))
			);
		draw();
		// a few feeds to start with
		const presets = ical ? [] : [["SRF News", "https://www.srf.ch/news/bnf/rss/1646"], ["NZZ", "https://www.nzz.ch/recent.rss"], ["heise online", "https://www.heise.de/rss/heise-atom.xml"], ["Hacker News", "https://hnrss.org/frontpage"], ["Tagesschau", "https://www.tagesschau.de/index~rss2.xml"]];
		const chips = presets.length ? h("div", { class: "chips-row" }, presets.map(([n, u]) => h("button", { class: "chip", onclick: () => (items.some((x) => x.url === u) || items.push({ name: n, url: u }), draw()) }, `+ ${n}`))) : null;
		sheet.body.append(
			titleBox,
			h("div", { class: "sec" }, t(ical ? "ical.calendars" : "rss.feeds")),
			h("div", { class: "box" }, list),
			chips,
			ical
				? h("div", { class: "help cal-help" },
						h("div", { class: "cal-help-head" }, t("ical.helpHead")),
						[["Google", "ical.helpGoogle"], ["iCloud", "ical.helpIcloud"], ["Outlook", "ical.helpOutlook"], ["Nextcloud · Radicale · Baïkal", "ical.helpPrivate"]].map(([n, k]) => h("div", { class: "cal-help-row" }, h("b", {}, n), h("span", {}, t(k)))))
				: h("div", { class: "help", style: "margin:8px 2px 0" }, t("rss.help")),
			ical
				? h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: async () => {
						for (const c of items) c.id = c.id || hex10();
						updateTile(tile.id, { title: title.value.trim() || undefined, calendars: items.filter((c) => c.url) });
						const secrets = Object.fromEntries(Object.entries(logins).flatMap(([cid, l]) => [[`${cid}:user`, l.user], [`${cid}:password`, l.password]]).filter(([, v]) => v !== undefined));
						if (Object.keys(secrets).length) {
							if (!(await savePageNow())) return;
							await guard(() => api("POST", `/api/tiles/${tile.id}/secrets`, { secrets }));
						}
						sheet.close();
						loadLive();
					} }, t("form.save")))
				: saveBtn(() => ({ feeds: items.filter((c) => c.url) }))
		);
		return;
	}

	if (tile.type === "iframe") {
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("frame.title"))));
		const url = h("input", { class: "input", value: tile.url || "", placeholder: "https://", inputmode: "url", autocapitalize: "off", spellcheck: "false" });
		sheet.body.append(
			h("div", { class: "box" }, h("div", { class: "field" }, h("label", {}, t("frame.url")), url, h("div", { class: "help" }, t("frame.help"))), h("div", { class: "field" }, h("label", {}, t("settings.title")), title)),
			saveBtn(() => ({ url: url.value.trim() }))
		);
		return;
	}

	// file systems: only a title
	sheet.head(h("div", { class: "tt" }, h("b", {}, t(`${tile.type}.title`))));
	sheet.body.append(titleBox, saveBtn(() => ({})));
}

// Time zones by city: "Tok" finds Tokio, "New Y" New York – with the time there right now.
const CITY_DE = { "Asia/Tokyo": "Tokio", "Asia/Shanghai": "Peking", "Europe/Moscow": "Moskau", "Europe/Rome": "Rom", "Africa/Cairo": "Kairo", "Europe/Lisbon": "Lissabon", "Europe/Prague": "Prag", "Europe/Warsaw": "Warschau", "Europe/Vienna": "Wien", "Europe/Brussels": "Brüssel", "Europe/Copenhagen": "Kopenhagen", "Europe/Athens": "Athen", "Asia/Singapore": "Singapur", "Asia/Kolkata": "Indien", "America/Mexico_City": "Mexiko-Stadt", "Asia/Hong_Kong": "Hongkong", "Asia/Taipei": "Taipeh", "Europe/Kyiv": "Kiew", "Europe/Kiev": "Kiew" };
const cityOf = (zone) => (LANG === "de" && CITY_DE[zone]) || String(zone || "").split("/").pop().replace(/_/g, " ");
function zonePicker(onPick) {
	const all = (Intl.supportedValuesOf && Intl.supportedValuesOf("timeZone")) || [];
	const input = h("input", { class: "input", placeholder: t("clk.searchPh"), autocomplete: "off", spellcheck: "false" });
	const hits = h("div", { class: "place-hits zone-hits" });
	const norm = (x) => x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[_\s-]+/g, " ");
	// matches at the start of the city name first
	const rank = (x, q) => norm(x.city).indexOf(q) + 1 || 99;
	const find = () => {
		const q = norm(input.value.trim());
		if (q.length < 2) return hits.replaceChildren();
		const found = all
			.map((z) => ({ z, city: cityOf(z), en: z.split("/").pop().replace(/_/g, " ") }))
			.filter((x) => norm(x.city).includes(q) || norm(x.en).includes(q) || norm(x.z).includes(q))
			.sort((a, b) => rank(a, q) - rank(b, q))
			.slice(0, 8);
		hits.replaceChildren(
			...(found.length
				? found.map((x) => h("button", { class: "place-hit", onclick: () => ((input.value = ""), hits.replaceChildren(), onPick({ name: x.city, zone: x.z })) }, h("b", {}, x.city), h("span", { class: "faint" }, x.z.split("/")[0].replace(/_/g, " ")), h("span", { class: "num zone-now" }, new Date().toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", timeZone: x.z }))))
				: [h("div", { class: "help" }, t("wx.noHits"))])
		);
	};
	input.addEventListener("input", find);
	return h("div", { class: "zone-add" }, input, hits);
}

// Search a place by name (Open-Meteo), pick one of the hits.
function placePicker(onPick) {
	const input = h("input", { class: "input", placeholder: t("wx.searchPh"), onkeydown: (e) => e.key === "Enter" && (e.preventDefault(), find()) });
	const hits = h("div", { class: "place-hits" });
	const find = async () => {
		const q = input.value.trim();
		if (!q) return;
		hits.replaceChildren(h("div", { class: "help" }, "…"));
		const r = await guard(() => api("GET", `/api/geocode?q=${encodeURIComponent(q)}&lang=${LANG}`));
		if (!r) return hits.replaceChildren();
		if (!r.items.length) return hits.replaceChildren(h("div", { class: "help" }, t("wx.noHits")));
		hits.replaceChildren(
			...r.items.map((p) =>
				h("button", { class: "place-hit", onclick: () => {
					hits.replaceChildren();
					input.value = "";
					onPick({ name: p.name, lat: p.lat, lon: p.lon });
				} }, h("b", {}, p.name), h("span", { class: "faint" }, p.region))
			)
		);
	};
	return h("div", {}, h("div", { class: "place-row" }, input, h("button", { class: "btn", onclick: find }, html(UI.search), t("wx.search"))), hits);
}

// Clocks tick every second; only their text changes, the tile isn't redrawn.
function tickClocks() {
	const now = new Date();
	for (const el of document.querySelectorAll("[data-analog]")) {
		const hh = now.getHours() % 12;
		const mm = now.getMinutes();
		const ss = now.getSeconds();
		const set = (sel, deg) => {
			const hand = el.querySelector(sel);
			if (hand) hand.setAttribute("transform", `rotate(${deg} 50 50)`);
		};
		set(".ah", hh * 30 + mm / 2);
		set(".am", mm * 6 + ss / 10);
		set(".as", ss * 6);
	}
	for (const el of document.querySelectorAll("[data-clock]")) {
		const sec = el.hasAttribute("data-sec");
		const time = now.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", ...(sec ? { second: "2-digit" } : {}) });
		const date = now.toLocaleDateString(LOCALE, { weekday: "long", day: "numeric", month: "long" });
		const tt = el.querySelector(".clk-t");
		const dd = el.querySelector(".clk-d");
		if (tt && tt.textContent !== time) tt.textContent = time;
		if (dd && dd.textContent !== date) dd.textContent = date;
	}
	// other places: their time, "+1" / "−1" when it's another day there
	const ymd = (tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
	for (const el of document.querySelectorAll("[data-clock-zone]")) {
		let text = "–";
		let day = 0;
		try {
			text = now.toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", timeZone: el.dataset.clockZone });
			day = Math.round((Date.parse(ymd(el.dataset.clockZone)) - Date.parse(ymd(undefined))) / 86400000);
		} catch {
			// unknown zone
		}
		const html = `${text}${day ? `<sup>${day > 0 ? "+" : "−"}${Math.abs(day)}</sup>` : ""}`;
		if (el.innerHTML !== html) el.innerHTML = html;
	}
}
setInterval(tickClocks, 1000);

// ---------- boards ----------

function nameSheet(title, value, onSave, extra) {
	const sheet = openSheet();
	sheet.el.classList.add("center");
	sheet.el.style.width = "440px";
	sheet.head(h("div", { class: "tt" }, h("b", {}, title)));
	const input = h("input", { class: "input", value: value || "", maxlength: 40, onkeydown: (e) => e.key === "Enter" && save() });
	const save = async () => {
		if (await onSave(input.value.trim())) sheet.close();
	};
	sheet.body.append(h("div", { class: "box" }, h("div", { class: "field" }, h("label", {}, t("board.name")), input)), h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: save }, t("form.save")), h("span", { style: "flex:1" }), extra ? extra(sheet) : null));
	setTimeout(() => input.focus(), 250);
}

function addBoard() {
	nameSheet(t("board.add"), "", async (name) => {
		const r = await guard(() => api("POST", "/api/boards", { name }));
		if (!r) return false;
		await loadState();
		switchBoard(r.board.id);
		return true;
	});
}

function boardSheet(b) {
	nameSheet(t("board.rename"), b.name, async (name) => {
		if (!(await guard(() => api("POST", `/api/boards/${b.id}`, { name })))) return false;
		await loadState();
		render();
		return true;
	}, (sheet) =>
		S.state.config.boards.length > 1
			? h("button", { class: "btn danger", onclick: async () => {
					if (!(await confirmSheet(t("board.removeConfirm", { n: b.name || t("board.default") }), t("board.remove"), true))) return;
					if (!(await guard(() => api("POST", `/api/boards/${b.id}/delete`)))) return;
					sheet.close();
					await loadState();
					switchBoard(S.state.config.boards[0].id);
				} }, t("board.remove"))
			: null
	);
}

// ---------- command palette (⌘K) ----------

let pal = null;
function palette() {
	if (pal) return pal.input.focus();
	const input = h("input", { class: "pal-in", placeholder: t("pal.placeholder"), autocomplete: "off", spellcheck: "false", "aria-label": t("pal.placeholder") });
	const list = h("div", { class: "pal-res", role: "listbox" });
	const el = h("div", { class: "pal", role: "dialog", "aria-modal": "true" }, input, list);
	const scrim = h("div", { class: "pal-scrim", onclick: () => close() });
	document.body.append(scrim, el);
	requestAnimationFrame(() => (el.classList.add("on"), scrim.classList.add("on")));
	let sel = 0;
	let results = [];
	const close = () => {
		el.remove();
		scrim.remove();
		pal = null;
	};
	const run = (i) => {
		const r = results[i];
		close();
		if (r) r.run();
	};
	const draw = () => {
		results = paletteResults(input.value.trim());
		sel = Math.min(sel, Math.max(0, results.length - 1));
		let last = null;
		list.replaceChildren(
			...results.flatMap((r, i) => {
				const cap = r.cap !== last ? h("div", { class: "pal-cap" }, r.cap) : null;
				last = r.cap;
				return [cap, h("div", { class: `pal-it${i === sel ? " sel" : ""}`, role: "option", onmousemove: () => mark(i), onclick: () => run(i) }, html(r.icon), h("span", { class: "pal-t" }, r.title), r.hint ? h("span", { class: "pal-k" }, r.hint) : null)];
			})
		);
	};
	const mark = (i) => {
		sel = i;
		list.querySelectorAll(".pal-it").forEach((x, k) => x.classList.toggle("sel", k === i));
		const cur = list.querySelectorAll(".pal-it")[i];
		if (cur) cur.scrollIntoView({ block: "nearest" });
	};
	input.addEventListener("input", () => ((sel = 0), draw()));
	input.addEventListener("keydown", (e) => {
		if (e.key === "ArrowDown") (mark(Math.min(results.length - 1, sel + 1)), e.preventDefault());
		else if (e.key === "ArrowUp") (mark(Math.max(0, sel - 1)), e.preventDefault());
		else if (e.key === "Enter") (run(sel), e.preventDefault());
		else if (e.key === "Escape") (close(), e.stopPropagation());
	});
	pal = { input, close };
	draw();
	input.focus();
}

function paletteResults(q) {
	const low = q.toLowerCase();
	const words = low.split(/\s+/).filter(Boolean);
	const hit = (text) => !words.length || words.every((w) => text.toLowerCase().includes(w));
	// "restart", "logs" … in the query narrows to that action
	const wantsAction = /neu|start|restart|log|detail|tailscale/.test(low);
	const nameWords = (s) => words.filter((w) => s.name.toLowerCase().includes(w));
	const glyph = (g) => `<span class="logo" style="--c:var(--muted)">${svg(g, 2)}</span>`;
	const I = {
		restart: glyph("<path d='M20 11a8 8 0 10-2.3 5.7M20 5v6h-6'/>"),
		logs: glyph("<path d='M5 6h14M5 12h14M5 18h9'/>"),
		info: glyph("<circle cx='12' cy='12' r='8.5'/><path d='M12 11v5M12 8h.01'/>"),
		page: glyph("<rect x='4' y='4' width='7' height='7' rx='2'/><rect x='13' y='4' width='7' height='7' rx='2'/><rect x='4' y='13' width='7' height='7' rx='2'/><rect x='13' y='13' width='7' height='7' rx='2'/>"),
		link: glyph(GLYPHS.link),
		web: glyph("<circle cx='11' cy='11' r='7'/><path d='M20 20l-3.5-3.5'/>"),
		gear: glyph("<circle cx='12' cy='12' r='3'/><path d='M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1'/>"),
		ts: glyph("<circle cx='6' cy='6' r='1.6'/><circle cx='12' cy='6' r='1.6'/><circle cx='18' cy='6' r='1.6'/><circle cx='6' cy='12' r='1.6'/><circle cx='12' cy='12' r='1.6'/><circle cx='18' cy='12' r='1.6'/><circle cx='12' cy='18' r='1.6'/>")
	};
	const out = [];
	const st = (s) => (S.live && S.live.status[s.id]) || {};
	const order = { down: 0, slow: 1 };
	const list = services()
		.filter((s) => !words.length || nameWords(s).length || hit(`${s.name} ${s.url} ${s.kind || ""}`))
		.sort((a, b) => (order[st(a).status] ?? 2) - (order[st(b).status] ?? 2) || a.name.localeCompare(b.name));
	const capS = t("pal.services");
	const capA = t("pal.actions");
	for (const s of (wantsAction && !list.some((x) => nameWords(x).length) ? [] : list).slice(0, words.length ? 8 : 6)) {
		const status = st(s).status;
		out.push({ cap: capS, icon: logo(s), title: s.name, hint: status === "down" ? t("status.down") : status === "slow" ? t("status.slow") : (s.url || "").replace(/^https?:\/\//, ""), run: () => (s.url ? window.open(urlFor(s), "_blank", "noopener,noreferrer") : serviceSheet(s.id)) });
	}
	// actions: for the services named in the query, or for the problem ones when only an action was typed
	const named = list.filter((s) => nameWords(s).length);
	const targets = named.length ? named : wantsAction ? services().filter((s) => ["down", "slow"].includes(st(s).status) || /log|detail|tailscale/.test(low)) : [];
	if (words.length) {
		for (const s of targets.slice(0, 6)) {
			const down = st(s).status === "down";
			if (s.container && (!/log|detail|tailscale/.test(low) || /neu|start/.test(low))) out.push({ cap: capA, icon: I.restart, title: t(down ? "pal.start" : "pal.restart", { n: s.name }), run: () => paletteAction(s, down ? "start" : "restart") });
			if (s.kind === "mmmanager" && (!wantsAction || /neu|start/.test(low))) out.push({ cap: capA, icon: I.restart, title: t("mm.restart"), run: () => paletteAction(s, "restart") });
			if (s.container && (!wantsAction || /log/.test(low))) out.push({ cap: capA, icon: I.logs, title: t("pal.logs", { n: s.name }), run: () => logsSheet(s) });
			if (!wantsAction || /detail/.test(low)) out.push({ cap: capA, icon: I.info, title: t("pal.details", { n: s.name }), run: () => serviceSheet(s.id) });
			if (tsLink(s) && (!wantsAction || /tailscale/.test(low))) out.push({ cap: capA, icon: I.ts, title: t("pal.tailscale", { n: s.name }), hint: tsLink(s).replace(/^https:\/\//, ""), run: () => window.open(tsLink(s), "_blank", "noopener,noreferrer") });
		}
	}
	for (const b of S.state.config.boards) {
		const name = b.name || t("board.default");
		if (b.id !== S.boardId && words.length && hit(`${name} ${t("pal.pageWord")}`)) out.push({ cap: t("pal.pages"), icon: I.page, title: t("pal.page", { n: name }), run: () => switchBoard(b.id) });
	}
	const links = S.state.config.boards.flatMap((b) => b.tiles.filter((x) => x.type === "links").flatMap((x) => x.links || []));
	for (const l of links.filter((l) => words.length && hit(`${l.name} ${l.url}`)).slice(0, 5)) out.push({ cap: t("pal.links"), icon: I.link, title: l.name || l.url, hint: l.url.replace(/^https?:\/\//, ""), run: () => window.open(l.url, "_blank", "noopener,noreferrer") });
	if (words.length && hit(t("app.settings"))) out.push({ cap: t("app.settings"), icon: I.gear, title: t("app.settings"), run: settingsSheet });
	if (words.length && hit(t("tile.add"))) out.push({ cap: t("app.settings"), icon: I.page, title: t("tile.add"), run: () => addTileSheet() });
	// tiles to add, also found by other words ("cal" → Calendar)
	if (words.length) {
		const sonarr = services().some((s) => s.kind === "sonarr" || s.kind === "radarr");
		const tiles = Object.keys(ADD_TILES).filter((k) => (!["calendar", "storage"].includes(k) || sonarr) && hit(`${t(ADD_TILES[k])} ${ADD_KEYS[k] || ""} ${t("tile.add")}`));
		for (const k of tiles.slice(0, 4)) out.push({ cap: t("tile.add"), icon: I.page, title: t(ADD_TILES[k]), hint: t(ADD_SUBS[k]), run: () => addTileSheet(t(ADD_TILES[k])) });
	}
	if (q) out.push({ cap: t("pal.web"), icon: I.web, title: t("pal.webSearch", { q }), run: () => window.open(`https://duckduckgo.com/?q=${encodeURIComponent(q)}`, "_blank", "noopener,noreferrer") });
	return out;
}

async function paletteAction(s, what) {
	toast(t(what === "start" ? "act.starting" : "act.restarting", { n: s.name }));
	const r = await guard(() => api("POST", `/api/services/${s.id}/action`, { what }));
	if (r) toast(t("act.done"));
	setTimeout(loadLive, 1500);
	setTimeout(loadLive, 8000);
}

document.addEventListener("keydown", (e) => {
	if (!S.state || $(".login")) return;
	const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || "");
	if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
		e.preventDefault();
		palette();
	} else if (e.key === "/" && !typing && !topSheet()) {
		e.preventDefault();
		palette();
	}
});

// ---------- settings and login ----------

function settingsSheet() {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("app.settings"))));
	const title = h("input", { class: "input", value: S.state.config.title || "", placeholder: t("app.title"), maxlength: 40, onchange: async (e) => {
		if (await guard(() => api("POST", "/api/settings", { title: e.target.value }))) {
			await loadState();
			render();
		}
	} });
	let cur = "";
	try {
		cur = localStorage.getItem("homebento.lang") || "";
	} catch {
		// storage blocked
	}
	const lang = h("select", { class: "input", onchange: (e) => {
		try {
			if (e.target.value) localStorage.setItem("homebento.lang", e.target.value);
			else localStorage.removeItem("homebento.lang");
		} catch {
			// storage blocked
		}
		location.reload();
	} }, [["", t("settings.langAuto")], ["de", "Deutsch"], ["en", "English"]].map(([v, l]) => h("option", { value: v, selected: v === cur }, l)));
	const placeNow = h("div", { class: "place-now" });
	const showPlace = () => placeNow.replaceChildren(S.state.config.location ? h("span", {}, S.state.config.location.name) : h("span", { class: "faint" }, t("settings.placeNone")));
	showPlace();
	sheet.body.append(
		h("div", { class: "box" },
			h("div", { class: "field" }, h("label", {}, t("settings.title")), title),
			widthField(),
			columnsField(),
			h("div", { class: "field" }, h("label", {}, t("settings.lang")), lang),
			h("div", { class: "field" }, h("label", {}, t("settings.place")), placeNow, placePicker(async (p) => {
				if (await guard(() => api("POST", "/api/settings", { location: p }))) {
					await loadState();
					showPlace();
					loadLive();
				}
			}), h("div", { class: "help" }, t("settings.placeHelp")))),
		h("div", { class: "sec" }),
		h("div", { class: "box rows settings-more" },
			h("button", { onclick: () => alertsSheet() }, html(`<span class="logo" style="--c:#f5b83d">${svg("<path d='M6 16V11a6 6 0 0112 0v5l1.5 2h-15zM10 20a2 2 0 004 0'/>", 2)}</span>`), h("div", { class: "grow" }, h("div", { class: "title" }, t("al.title")), h("div", { class: "sub" }, S.state.notify ? t("settings.notifyOn") : t("al.none"))), h("span", { class: "plus" }, "›")),
			h("button", { onclick: () => configSheet() }, html(`<span class="logo" style="--c:#9dbcff">${svg("<path d='M12 3v12M7 10l5 5 5-5M5 21h14'/>", 2)}</span>`), h("div", { class: "grow" }, h("div", { class: "title" }, t("cfg.title")), h("div", { class: "sub" }, t("cfg.sub"))), h("span", { class: "plus" }, "›")),
			h("button", { onclick: () => kioskSheet() }, html(`<span class="logo" style="--c:#5fd39a">${svg("<rect x='3' y='4' width='18' height='13' rx='2.5'/><path d='M8 21h8M12 17v4'/>", 2)}</span>`), h("div", { class: "grow" }, h("div", { class: "title" }, t("ki.title")), h("div", { class: "sub" }, t("ki.sub"))), h("span", { class: "plus" }, "›"))),
		h("div", { class: "sec" }),
		h("div", { class: "box kv" },
			h("div", {}, h("span", {}, t("settings.docker")), h("span", {}, S.state.docker ? t("settings.dockerOn") : t("settings.dockerOff"))),
			h("div", {}, h("span", {}, t("settings.checks")), h("span", {}, t("settings.checksEvery", { n: S.state.checkSeconds }))),

			h("div", {}, h("span", {}, t("settings.version")), h("span", {}, S.state.version))),
		S.state.auth ? h("div", { class: "acts" }, h("button", { class: "btn", onclick: async () => (await fetch("/api/logout", { method: "POST" }), location.reload()) }, t("settings.logout"))) : null
	);
}

const SELF_LOGO = `<span class="logo" style="--c:#9dbcff"><img src="icon.svg" alt=""></span>`;

function tailscaleSheet() {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, "Tailscale"), h("span", { class: "sub" }, (S.state.tailscale || {}).dnsName || "")));
	sheet.body.append(tailscaleSettings());
	sheet.onclose = () => loadLive();
}
document.addEventListener("click", (e) => {
	if (!e.target.closest("[data-ts-manage]") || S.editing) return;
	e.stopPropagation();
	tailscaleSheet();
}, true);

// Every Tailscale Serve entry of this machine (also those made by hand), and sharing more.
function tailscaleSettings() {
	const box = h("div");
	let adding = false;
	const draw = () => {
		const st = S.state.tailscale || {};
		const head = h("div", { class: "sec" }, "Tailscale", st.dnsName ? h("span", { class: "faint", style: "font-weight:500" }, st.dnsName) : null);
		if (!st.available || st.error) return box.replaceChildren(head, h("div", { class: "note" }, st.error || t("ts.notConnected")));
		const self = st.self || {};
		const rows = (st.mappings || []).map((m) => {
			const svc = services().find((s) => st.links && st.links[s.id] === m.url);
			const port = m.proxy && (/:(\d+)/.exec(m.proxy) || [])[1];
			const isSelf = !svc && self.url === m.url;
			const name = svc ? svc.name : isSelf ? "HomeBento" : port ? t("ts.port", { p: port }) : m.proxy || "–";
			return h("div", { class: "ts-row" },
				html(svc ? logo(svc) : isSelf ? SELF_LOGO : `<span class="logo" style="--c:var(--muted)">${svg(GLYPHS.globe)}</span>`),
				h("div", { class: "grow" }, h("div", { class: "title" }, name, m.funnel ? h("span", { class: "tag slow", style: "margin-left:8px" }, "Funnel") : null), h("a", { class: "sub", href: m.url, target: "_blank", rel: "noopener noreferrer" }, m.url.replace(/^https:\/\//, ""))),
				h("button", { class: "ts-x", title: t("tile.remove"), "aria-label": t("tile.remove"), onclick: async () => {
					if (!(await confirmSheet(t("ts.removeConfirm", { u: m.url }), t("tile.remove"), true))) return;
					const r = await guard(() => api("POST", "/api/tailscale/remove", { port: m.port }));
					if (r) (S.state.tailscale = r), draw(), loadLive();
				}, html: UI.x }));
		});
		if (!rows.length) rows.push(h("div", { class: "ts-row" }, h("span", { class: "sub" }, t("ts.none"))));
		const free = services().filter((s) => st.local && st.local[s.id] && !(st.links && st.links[s.id]));
		const selfFree = self.port && !self.url;
		if (adding && selfFree)
			rows.push(h("div", { class: "ts-row" }, html(SELF_LOGO), h("div", { class: "grow" }, h("div", { class: "title" }, "HomeBento"), h("div", { class: "sub" }, t("ts.selfSub", { p: self.port }))),
				h("button", { class: "btn", onclick: async (e) => {
					e.currentTarget.classList.add("busy");
					const r = await guard(() => api("POST", "/api/tailscale/self", { enable: true }));
					if (r) (S.state.tailscale = r), (adding = false), draw(), toast(`${t("ts.on")} ${r.self && r.self.url ? r.self.url : ""}`);
				} }, t("ts.shareBtn"))));
		if ((free.length || selfFree) && !adding) rows.push(h("button", { class: "ts-row ts-add", onclick: () => ((adding = true), draw()) }, html(`<span class="logo" style="--c:var(--accent)">${UI.plus}</span>`), h("span", {}, t("ts.add"))));
		if (adding)
			for (const s of free)
				rows.push(h("div", { class: "ts-row" }, html(logo(s)), h("div", { class: "grow" }, h("div", { class: "title" }, s.name), h("div", { class: "sub" }, s.url.replace(/^https?:\/\//, ""))),
					h("button", { class: "btn", onclick: async (e) => {
						e.currentTarget.classList.add("busy");
						const r = await guard(() => api("POST", `/api/services/${s.id}/tailscale`, { enable: true }));
						if (r) (S.state.tailscale = r), (adding = false), draw(), toast(`${t("ts.on")} ${tsLink(s) || ""}`);
					} }, t("ts.shareBtn"))));
		box.replaceChildren(head, h("div", { class: "box" }, rows));
	};
	draw();
	return box;
}

function showLogin() {
	if ($(".login")) return;
	clearInterval(poller);
	const pw = h("input", { class: "input", type: "password", placeholder: t("login.password"), autocomplete: "current-password", onkeydown: (e) => e.key === "Enter" && go() });
	const msg = h("div");
	const go = async () => {
		const r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: pw.value }) });
		if (r.ok) return location.reload();
		const d = await r.json().catch(() => ({}));
		msg.replaceChildren(h("div", { class: "note bad" }, d.error || "Error"));
	};
	$("#app").replaceChildren(h("div", { class: "login" }, h("h1", {}, t("login.title")), pw, h("button", { class: "btn primary", onclick: go }, t("login.go")), msg));
	setTimeout(() => pw.focus(), 50);
}

// ---------- start ----------

let poller = null;
async function start() {
	try {
		await loadState();
	} catch (err) {
		if (!$(".login")) $("#app").replaceChildren(h("div", { class: "login" }, h("div", { class: "note bad" }, err.message)));
		return;
	}
	render();
	await loadLive();
	poller = setInterval(() => !document.hidden && loadLive(), 5000);
	document.addEventListener("visibilitychange", () => !document.hidden && loadLive());
}
start();
