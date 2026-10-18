"use strict";
// HomeBento web app: boards of tiles, live data every few seconds, edit mode,
// service details with actions, and forms for services and tiles. No framework.

const S = { state: null, live: null, boardId: null, editing: false, tiles: null, drag: null };
const $ = (sel, root = document) => root.querySelector(sel);

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
	hostName: S.state.host
});

async function loadState() {
	S.state = await api("GET", "/api/state");
	const saved = localStorage.getItem("homebento.board");
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

function render() {
	const app = $("#app");
	app.replaceChildren(h("div", { class: "wrap" }, topBar(), setupBanner(), h("div", { class: `bento${S.editing ? " editing" : ""}`, id: "bento" })));
	document.title = S.state.config.title || t("app.title");
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
	S.live = null;
	render();
	loadLive();
}

// Draws the tiles; a tile's DOM is only touched when its HTML changed (no flicker, images stay).
function renderGrid() {
	const grid = $("#bento");
	if (!grid) return;
	const x = ctx();
	const list = tiles();
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
		if (el.dataset.html !== content) {
			el.innerHTML = content;
			el.dataset.html = content;
		}
		seen.add(tile.id);
		els.push(el);
	}
	if (S.editing) els.push(grid.querySelector(":scope > .adder") || h("button", { class: "t w1 h1 adder", onclick: addTileSheet, html: `${UI.plus}${t("tile.add")}` }));
	else if (!list.length) els.push(grid.querySelector(":scope > .empty") || emptyCard());
	// put everything in order, drop what's gone
	els.forEach((el, i) => {
		if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null);
	});
	while (grid.children.length > els.length) grid.lastChild.remove();
}

function controls(tile) {
	const opts = tile.type === "links" || tile.type === "notes" ? `<button data-act="opts" title="${t("tile.options")}">⋯</button>` : "";
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

// ticking a note right on the board (outside edit mode)
document.addEventListener("change", (e) => {
	const box = e.target.closest("input[data-note]");
	if (!box || S.editing) return;
	const el = box.closest(".bento > .t[data-id]");
	const b = board();
	const tile = b.tiles.find((x) => x.id === el.dataset.id);
	if (!tile || !tile.notes) return;
	tile.notes[Number(box.dataset.note)].done = box.checked;
	guard(() => api("POST", `/api/boards/${b.id}/tiles`, { tiles: b.tiles })).then(() => renderGrid());
});

document.addEventListener("click", (e) => {
	if (e.target.closest(".note-row") && !S.editing) return;
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
		} else if (act.dataset.act === "opts") (tile.type === "notes" ? notesSheet : linksSheet)(tile);
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
const urlFor = (s) => (viaTailscale() && tsLink(s)) || s.url;

// One tap opens the service itself; a service that is down shows what's wrong instead.
function openTile(tile) {
	const s = tileService(tile);
	if (s && s.url) {
		const st = S.live && S.live.status[s.id];
		if (st && st.status === "down") return serviceSheet(s.id);
		window.open(urlFor(s), "_blank", "noopener");
		return;
	}
	return openTileDetails(tile);
}

function openTileDetails(tile) {
	const x = ctx();
	if (tile.service) return serviceSheet(tile.service);
	if (tile.type === "status" || tile.type === "uptime") return statusSheet();
	if (tile.type === "host") return hostSheet();
	if (tile.type === "notes" || tile.type === "links") return;
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
	const el = h("div", { class: `sheet${wide ? " wide" : ""}`, role: "dialog", "aria-modal": "true" });
	const head = h("div", { class: "hd" });
	const body = h("div", { class: "bd" });
	el.append(head, body);
	document.body.append(el);
	$("#scrim").classList.add("on");
	requestAnimationFrame(() => el.classList.add("on"));
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
			else $("#scrim").classList.remove("on");
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
});

function confirmSheet(text, yes = t("confirm.yes"), danger = false) {
	return new Promise((resolve) => {
		const s = openSheet();
		let answered = false;
		s.head(h("div", { class: "tt" }, h("b", {}, text)));
		s.el.style.width = "440px";
		s.onclose = () => !answered && resolve(false);
		s.body.append(
			h("div", { class: "acts", style: "margin-top:4px;justify-content:flex-end" },
				h("button", { class: "btn", onclick: () => s.close() }, t("form.cancel")),
				h("button", { class: `btn ${danger ? "danger" : "primary"}`, onclick: () => ((answered = true), s.close(), resolve(true)) }, yes))
		);
	});
}

function headOf(s) {
	return [
		html(logo(s)),
		h("div", { class: "tt" }, h("b", {}, s.name), s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener" }, s.url.replace(/^https?:\/\//, "")) : null)
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
		parts.push(h("div", { class: "sec" }, t("sheet.last24")), h("div", { class: "box" }, bars(d.hours, true), h("div", { class: "axis" }, h("span", {}, "−24 h"), h("span", {}, t("time.now")))));
		parts.push(h("div", { class: "sec" }, t("sheet.last30")), h("div", { class: "box" }, bars(d.days.map((ok) => ({ ok, ms: null })), false), h("div", { class: "axis" }, h("span", {}, "−30 d"), h("span", {}, t("cal.today")))));
		if (tsLink(s)) parts.push(h("div", { class: "sec" }, "Tailscale"), h("div", { class: "box kv" }, h("div", {}, h("span", {}, t("ts.address")), h("a", { href: tsLink(s), target: "_blank", rel: "noopener" }, tsLink(s).replace(/^https:\/\//, "")))));
		if (s.container) parts.push(containerPart(s, d.container, fill));
		if (s.kind === "mmmanager") parts.push(h("div", { class: "acts" }, h("button", { class: "btn", onclick: (e) => act(e.currentTarget, s, "restart", fill) }, t("mm.restart"))));
		parts.push(h("div", { class: "sec" }, t("sheet.events")));
		parts.push(
			d.events.length
				? h("div", { class: "box events" }, d.events.map((ev) => h("div", {}, h("span", { class: "when" }, new Date(ev.t).toLocaleString(LOCALE, { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" })), h("span", {}, `${t(`ev.${ev.to}`)}${ev.detail ? ` – ${ev.detail}` : ""}`))))
				: h("div", { class: "note" }, t("sheet.noEvents"))
		);
		parts.push(
			h("div", { class: "acts" },
				s.url ? h("a", { class: "btn primary", href: urlFor(s), target: "_blank", rel: "noopener" }, html(UI.open), t("sheet.open")) : null,
				h("button", { class: "btn", onclick: async (e) => { e.currentTarget.classList.add("busy"); await guard(() => api("POST", `/api/services/${sid}/check`)); fill(); loadLive(); } }, t("sheet.checkNow")),
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

async function logsSheet(s) {
	const sheet = openSheet({ wide: true });
	sheet.head(...headOf(s));
	const pre = h("div", { class: "log" }, "…");
	const load = async () => {
		const r = await guard(() => api("GET", `/api/services/${s.id}/logs?tail=400`));
		if (!r) return;
		pre.textContent = r.text || "–";
		pre.scrollTop = pre.scrollHeight;
	};
	sheet.body.append(h("div", { class: "sec" }, t("sheet.logs"), h("button", { class: "btn", style: "padding:4px 10px", onclick: load }, "↻")), pre);
	load();
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

// Server details; follows the live data like the tile does.
function hostSheet() {
	if (!S.live || !S.live.host) return;
	const sheet = openSheet();
	const fill = () => {
		const hst = S.live && S.live.host;
		if (!hst) return;
		const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
		sheet.head(html(`<span class="logo" style="--c:#9dbcff">${svg(GLYPHS.server)}</span>`), h("div", { class: "tt" }, h("b", {}, hst.name), h("span", { class: "sub" }, t("host.up", { t: fmtDuration(hst.uptime) }))));
		const row = (k, v) => h("div", {}, h("span", {}, k), h("span", { class: "num" }, v));
		sheet.body.replaceChildren(
			h("div", { class: "box kv" },
				row(t("host.cpu"), `${hst.cpu} %`),
				row(t("host.cores"), String(hst.cores)),
				row(t("host.load"), nf(hst.load, 2)),
				row(t("host.memory"), `${t("host.of", { a: fmtBytes(hst.memUsed), b: fmtBytes(hst.memTotal) })} (${pct(hst.memUsed, hst.memTotal)} %)`),
				hst.diskTotal ? row(t("host.disk"), `${t("host.of", { a: fmtBytes(hst.diskUsed), b: fmtBytes(hst.diskTotal) })} (${pct(hst.diskUsed, hst.diskTotal)} %)`) : null,
				hst.net ? row(t("host.net"), `↓ ${fmtBytes(hst.net.rx)}/s · ↑ ${fmtBytes(hst.net.tx)}/s`) : null,
				hst.temp !== null ? row(t("host.temp"), `${hst.temp} °C`) : null),
			h("div", { class: "note", style: "margin-top:12px" }, t("host.loadHelp"))
		);
	};
	fill();
	S.hostFill = fill;
	sheet.onclose = () => (S.hostFill = null);
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
	const icon = h("input", { class: "input", value: cur.icon, placeholder: slug(cur.name) || "sonarr", oninput: updatePreview, autocapitalize: "off", spellcheck: "false" });
	const kind = h("select", { class: "input", onchange: () => (drawSecrets(), updatePreview()) }, h("option", { value: "" }, t("form.kindNone")), Object.entries(S.state.kinds).map(([k, v]) => h("option", { value: k, selected: cur.kind === k }, L(v.label))));
	const container = h("select", { class: "input" }, h("option", { value: "" }, t("form.noContainer")));
	if (cur.container) container.append(h("option", { value: cur.container, selected: true }, cur.container));
	const check = h("input", { type: "checkbox", checked: cur.check !== false });
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
		return { id: isNew ? undefined : s.id, name: name.value, url: url.value.trim(), icon: icon.value.trim(), kind: kind.value || null, container: container.value || null, check: check.checked, insecure: insecure.checked, secrets };
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
			h("div", { class: "field" }, h("label", {}, t("form.icon")), icon, h("div", { class: "help" }, t("form.iconHelp")))),
		h("div", { class: "sec" }, t("form.kind")),
		h("div", { class: "box" }, h("div", { class: "field" }, kind, h("div", { class: "help" }, t("form.kindHelp"))), secretsBox),
		h("div", { class: "sec" }),
		h("div", { class: "box" },
			S.state.docker ? h("div", { class: "field" }, h("label", {}, t("form.container")), container) : null,
			h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("form.check")), h("span", { class: "switch" }, check, h("span"))),
			h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("form.insecure"), h("div", { class: "help" }, t("form.insecureHelp"))), h("span", { class: "switch" }, insecure, h("span")))),
		tailscalePart(s, msg),
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
function tailscalePart(s, msg) {
	const ts = S.state.tailscale || {};
	if (!ts.available || !s || !s.id) return null;
	if (ts.error) return h("div", { class: "box", style: "margin-top:8px" }, h("div", { class: "field" }, h("label", {}, "Tailscale"), h("div", { class: "help" }, ts.error)));
	if (!ts.local || !ts.local[s.id]) return null;
	const link = tsLink(s);
	const sw = h("input", { type: "checkbox", checked: !!link, onchange: async (e) => {
		e.target.disabled = true;
		try {
			S.state.tailscale = await api("POST", `/api/services/${s.id}/tailscale`, { enable: e.target.checked });
			msg.replaceChildren(e.target.checked && tsLink(s) ? h("div", { class: "note ok" }, `${t("ts.on")} ${tsLink(s)}`) : h("div", { class: "note" }, t("ts.off")));
		} catch (err) {
			e.target.checked = !e.target.checked;
			msg.replaceChildren(h("div", { class: "note bad" }, err.message));
		}
		e.target.disabled = false;
		sub.textContent = tsLink(s) || t("ts.help", { n: ts.dnsName });
	} });
	const sub = h("div", { class: "help" }, link || t("ts.help", { n: ts.dnsName }));
	return h("div", { class: "box", style: "margin-top:8px" }, h("label", { class: "switch-row" }, h("div", { class: "grow" }, t("ts.share"), sub), h("span", { class: "switch" }, sw, h("span"))));
}

// ---------- adding tiles ----------

const DEFAULT_SIZE = { service: [1, 1], status: [2, 1], host: [2, 2], uptime: [2, 2], jellyfin: [3, 3], recent: [3, 2], calendar: [3, 2], downloads: [3, 1], solar: [2, 2], links: [2, 2], notes: [2, 2] };

function addTile(tile) {
	const [w, hh] = DEFAULT_SIZE[tile.type];
	if (!S.editing) {
		S.editing = true;
		S.tiles = structuredClone(board().tiles);
		render();
	}
	const id = [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
	S.tiles.push({ id, w, h: hh, ...tile });
	saveTiles();
	renderGrid();
}

async function addTileSheet() {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("add.title"))));
	const onBoard = (pred) => S.tiles.some(pred);
	const row = (logoHtml, title, sub, onclick, done) =>
		h("button", { disabled: !!done, onclick }, html(logoHtml), h("div", { class: "grow" }, h("div", { class: "title" }, title), sub ? h("div", { class: "sub" }, sub) : null), done ? h("span", { class: "done" }, done) : h("span", { class: "plus" }, "+"));
	const glyphLogo = (g, c) => `<span class="logo" style="--c:${c}">${svg(GLYPHS[g] || g)}</span>`;
	const dockerBox = h("div", { class: "box rows" }, h("div", { class: "row" }, h("span", { class: "sub" }, "…")));
	const draw = () => {
		const content = [];
		const add = (tile) => () => {
			addTile(tile);
			toast(t("add.added"));
			draw();
		};
		content.push(row(glyphLogo("<path d='M12 3l9 4.5v9L12 21l-9-4.5v-9z'/>", "#5fd39a"), t("add.status"), t("add.statusSub"), add({ type: "status" }), onBoard((x) => x.type === "status") && t("add.onBoard")));
		content.push(row(glyphLogo("server", "#9dbcff"), t("add.host"), t("add.hostSub"), add({ type: "host" }), onBoard((x) => x.type === "host") && t("add.onBoard")));
		content.push(row(glyphLogo("<path d='M4 18V8M9 18V5M14 18v-7M19 18V9'/>", "#5fd39a"), t("add.uptime"), t("add.uptimeSub"), add({ type: "uptime" }), onBoard((x) => x.type === "uptime") && t("add.onBoard")));
		for (const s of services()) {
			const k = s.kind && S.state.kinds[s.kind];
			if (!k || !k.tile || k.tile === "calendar") continue;
			content.push(row(logo(s), `${s.name}: ${t(k.tile === "jellyfin" ? "jf.now" : k.tile === "downloads" ? "dl.title" : "solar.title")}`, null, add({ type: k.tile, service: s.id }), onBoard((x) => x.type === k.tile && x.service === s.id) && t("add.onBoard")));
			if (k.tile === "jellyfin") content.push(row(logo(s), `${s.name}: ${t("add.recent")}`, null, add({ type: "recent", service: s.id }), onBoard((x) => x.type === "recent" && x.service === s.id) && t("add.onBoard")));
		}
		if (services().some((s) => s.kind === "sonarr" || s.kind === "radarr")) content.push(row(glyphLogo("<rect x='4' y='5' width='16' height='15' rx='3'/><path d='M4 10h16M9 3v4M15 3v4'/>", "#35c5f4"), t("add.calendar"), t("add.calendarSub"), add({ type: "calendar" }), onBoard((x) => x.type === "calendar") && t("add.onBoard")));
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
	};
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
			const tl = S.tiles.find((x) => x.id === tile.id);
			if (tl) {
				tl.links = links.filter((l) => /^https?:\/\//.test(l.url));
				tl.title = title.value.trim() || undefined;
				saveTiles();
				renderGrid();
			}
			sheet.close();
		} }, t("form.save")))
	);
}

function notesSheet(tile) {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("notes.edit"))));
	const notes = (tile.notes || []).map((n) => ({ ...n }));
	const title = h("input", { class: "input", value: tile.title || "", placeholder: t("notes.title") });
	const list = h("div", { class: "box" });
	const draw = () =>
		list.replaceChildren(
			...notes.map((n, i) =>
				h("div", { class: "link-edit", style: "grid-template-columns:auto 1fr auto" },
					h("input", { type: "checkbox", checked: n.done, onchange: (e) => (n.done = e.target.checked) }),
					h("input", { class: "input", value: n.text, oninput: (e) => (n.text = e.target.value), onkeydown: (e) => e.key === "Enter" && (notes.splice(i + 1, 0, { text: "", done: false }), draw(), list.querySelectorAll("input.input")[i + 1].focus()) }),
					h("button", { class: "x", style: "width:30px;height:30px;border-radius:50%;background:var(--tile-3);display:grid;place-items:center", onclick: () => (notes.splice(i, 1), draw()), html: UI.x }))
			),
			h("div", { class: "field" }, h("button", { class: "btn", onclick: () => (notes.push({ text: "", done: false }), draw(), [...list.querySelectorAll("input.input")].pop().focus()) }, html(UI.plus), t("notes.add")))
		);
	draw();
	sheet.body.append(
		h("div", { class: "box" }, h("div", { class: "field" }, h("label", {}, t("settings.title")), title)),
		h("div", { class: "sec" }),
		list,
		h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => {
			const tl = S.tiles.find((x) => x.id === tile.id);
			if (tl) {
				tl.notes = notes.filter((n) => n.text.trim());
				tl.title = title.value.trim() || undefined;
				saveTiles();
				renderGrid();
			}
			sheet.close();
		} }, t("form.save")))
	);
}

// ---------- boards ----------

function nameSheet(title, value, onSave, extra) {
	const sheet = openSheet();
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
	sheet.body.append(
		h("div", { class: "box" }, h("div", { class: "field" }, h("label", {}, t("settings.title")), title), h("div", { class: "field" }, h("label", {}, t("settings.lang")), lang)),
		h("div", { class: "sec" }),
		h("div", { class: "box kv" },
			h("div", {}, h("span", {}, t("settings.docker")), h("span", {}, S.state.docker ? t("settings.dockerOn") : t("settings.dockerOff"))),
			h("div", {}, h("span", {}, t("settings.checks")), h("span", {}, t("settings.checksEvery", { n: S.state.checkSeconds }))),
			h("div", {}, h("span", {}, t("settings.notify")), h("span", {}, S.state.notify ? t("settings.notifyOn") : t("settings.notifyOff"))),
			h("div", {}, h("span", {}, t("settings.version")), h("span", {}, S.state.version))),
		tailscaleSettings(),
		S.state.auth ? h("div", { class: "acts" }, h("button", { class: "btn", onclick: async () => (await fetch("/api/logout", { method: "POST" }), location.reload()) }, t("settings.logout"))) : null
	);
}

// Every Tailscale Serve entry of this machine, also those not made in HomeBento.
function tailscaleSettings() {
	const ts = S.state.tailscale || {};
	const box = h("div");
	const draw = () => {
		const st = S.state.tailscale || {};
		const rows = [];
		if (!st.available) rows.push(h("div", {}, h("span", {}, t("ts.status")), h("span", {}, t("ts.notConnected"))));
		else if (st.error) rows.push(h("div", {}, h("span", {}, t("ts.status")), h("span", {}, st.error)));
		else {
			rows.push(h("div", {}, h("span", {}, t("ts.machine")), h("span", {}, st.dnsName || st.state)));
			for (const m of st.mappings || []) {
				const svc = services().find((s) => st.links && st.links[s.id] === m.url);
				rows.push(h("div", {},
					h("span", { style: "min-width:0" }, h("a", { href: m.url, target: "_blank", rel: "noopener", style: "color:var(--text)" }, `:${m.port}${m.path === "/" ? "" : m.path}`), " ", h("span", { class: "faint sm" }, `→ ${svc ? svc.name : m.proxy || "–"}${m.funnel ? " · Funnel" : ""}`)),
					h("button", { class: "btn danger", style: "padding:4px 10px", onclick: async () => {
						if (!(await confirmSheet(t("ts.removeConfirm", { u: m.url }), t("tile.remove"), true))) return;
						const r = await guard(() => api("POST", "/api/tailscale/remove", { port: m.port }));
						if (r) (S.state.tailscale = r), draw();
					} }, t("tile.remove"))));
			}
			if (!(st.mappings || []).length) rows.push(h("div", {}, h("span", {}, t("ts.none"))));
		}
		box.replaceChildren(h("div", { class: "sec" }, "Tailscale"), h("div", { class: "box kv" }, rows));
	};
	if (ts.available !== undefined) draw();
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
