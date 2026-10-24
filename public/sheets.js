"use strict";
// More windows: messages (alerts), configuration (export, import, backups), kiosk mode,
// and the settings of the newer tiles (own API, markets, holidays, countdown, camera).

const hex10 = () => [...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("");
const field = (label, input, help) => h("div", { class: "field" }, label ? h("label", {}, label) : null, input, help ? h("div", { class: "help" }, help) : null);
const switchRow = (label, input, help) => h("label", { class: "switch-row" }, h("div", { class: "grow" }, label, help ? h("div", { class: "help" }, help) : null), h("span", { class: "switch" }, input, h("span")));
const until = (ts) => new Date(ts).toLocaleString(LOCALE, { weekday: "short", hour: "2-digit", minute: "2-digit" });

// The tiles of the page right now, saved before a tile's secrets can be stored for it.
async function savePageNow() {
	const b = board();
	if (S.editing) b.tiles = structuredClone(S.tiles);
	const r = await guard(() => api("POST", `/api/boards/${b.id}/tiles`, { tiles: b.tiles }));
	if (r) b.tiles = r.board.tiles;
	return !!r;
}

// ---------- messages ----------

async function alertsSheet() {
	const v = await guard(() => api("GET", "/api/alerts"));
	if (!v) return;
	const sheet = openSheet({ wide: true });
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("al.title")), h("span", { class: "sub" }, t("al.sub"))));
	const chans = v.channels.map((c) => ({ ...c, fields: { ...c.fields }, events: { ...c.events } }));
	const secrets = {};
	const list = h("div", { class: "al-list" });
	const typeLabel = (type) => L(v.types[type].label);
	const EVENTS = [["down", t("al.evDown")], ["up", t("al.evUp")], ["warn", t("al.evWarn")], ["resources", t("al.evRes")]];
	const drawChannels = () => {
		list.replaceChildren(
			...chans.map((c, i) => {
				const sec = (secrets[c.id] = secrets[c.id] || {});
				const inputs = v.types[c.type].fields.map((f) => {
					let input;
					if (f.type === "select") input = h("select", { class: "input", onchange: (e) => (c.fields[f.key] = e.target.value) }, f.options.map((o) => h("option", { value: o.value, selected: (c.fields[f.key] || f.options[0].value) === o.value }, L(o.label))));
					else if (f.type === "checkbox") return switchRow(L(f.label), h("input", { type: "checkbox", checked: c.fields[f.key] === "true", onchange: (e) => (c.fields[f.key] = e.target.checked ? "true" : "") }));
					else if (f.secret) input = h("input", { class: "input", type: "password", autocomplete: "off", placeholder: c.secrets && c.secrets[f.key] ? t("form.secretSet") : f.placeholder || "", oninput: (e) => (sec[f.key] = e.target.value) });
					else input = h("input", { class: "input", value: c.fields[f.key] || "", placeholder: f.placeholder || "", autocapitalize: "off", spellcheck: "false", oninput: (e) => (c.fields[f.key] = e.target.value.trim()) });
					return field(`${L(f.label)}${f.optional ? ` · ${t("al.optional")}` : ""}`, input, f.help ? L(f.help) : null);
				});
				const test = h("button", { class: "btn", onclick: async (e) => {
					const b = e.currentTarget;
					b.classList.add("busy");
					const r = await guard(() => api("POST", "/api/alerts/test", { channel: { id: c.id, type: c.type, name: c.name, fields: c.fields }, secrets: sec }));
					b.classList.remove("busy");
					if (r) toast(t("al.testSent"));
				} }, t("al.test"));
				return h("div", { class: `al-chan${c.enabled === false ? " off" : ""}` },
					h("div", { class: "al-chan-head" },
						h("b", {}, typeLabel(c.type)),
						h("input", { class: "input al-name", value: c.name || "", placeholder: t("al.namePh"), maxlength: 40, oninput: (e) => (c.name = e.target.value) }),
						h("span", { class: "switch" }, h("input", { type: "checkbox", checked: c.enabled !== false, onchange: (e) => ((c.enabled = e.target.checked), drawChannels()) }), h("span")),
						h("button", { class: "x row-x", title: t("tile.remove"), onclick: () => (chans.splice(i, 1), drawChannels()), html: UI.x })),
					c.error ? h("div", { class: "note bad" }, `${t("al.lastError")}: ${c.error.error}`) : null,
					h("div", { class: "al-fields" }, inputs),
					h("div", { class: "al-events" }, h("span", { class: "faint sm" }, t("al.sendFor")), EVENTS.map(([k, label]) => h("label", { class: "chip-check" }, h("input", { type: "checkbox", checked: c.events[k] !== false, onchange: (e) => (c.events[k] = e.target.checked) }), h("span", {}, label))), h("span", { style: "flex:1" }), test));
			}),
			h("div", { class: "al-add" }, h("span", { class: "faint sm" }, t("al.add")), Object.keys(v.types).map((type) => h("button", { class: "chip", onclick: () => (chans.push({ id: hex10(), type, name: "", enabled: true, fields: {}, events: { down: true, up: true, warn: true, resources: true }, secrets: {} }), drawChannels()) }, `+ ${typeLabel(type)}`)))
		);
	};
	drawChannels();

	// global quiet time
	const muteBox = h("div");
	const drawMute = () => {
		const m = v.mutedUntil && v.mutedUntil > Date.now() ? v.mutedUntil : null;
		const set = async (minutes) => {
			const tomorrow = new Date();
			tomorrow.setDate(tomorrow.getDate() + 1);
			tomorrow.setHours(7, 0, 0, 0);
			const ts = minutes === "morning" ? tomorrow.getTime() : minutes ? Date.now() + minutes * 60000 : 0;
			const r = await guard(() => api("POST", "/api/alerts", { mutedUntil: ts }));
			if (r) (v.mutedUntil = r.mutedUntil), drawMute();
		};
		muteBox.replaceChildren(
			h("div", { class: "al-mute" },
				h("div", { class: "grow" }, h("div", { class: "title" }, m ? t("al.mutedUntil", { t: until(m) }) : t("al.notMuted")), h("div", { class: "help" }, t("al.muteHelp"))),
				m ? h("button", { class: "btn", onclick: () => set(0) }, t("al.unmute")) : [h("button", { class: "btn", onclick: () => set(60) }, "1 h"), h("button", { class: "btn", onclick: () => set(480) }, "8 h"), h("button", { class: "btn", onclick: () => set("morning") }, t("al.tillMorning"))])
		);
	};
	drawMute();

	const delay = h("select", { class: "input" }, [0, 2, 5, 10, 30].map((n) => h("option", { value: n, selected: v.delay === n }, n ? t("al.after", { n }) : t("al.atOnce"))));
	const lang = h("select", { class: "input" }, [["de", "Deutsch"], ["en", "English"]].map(([k, l]) => h("option", { value: k, selected: (v.lang || LANG) === k }, l)));
	const lim = (key, unit, min, max) => h("div", { class: "al-limit" }, h("input", { class: "input", type: "number", min, max, value: v.limits[key], oninput: (e) => (v.limits[key] = Number(e.target.value)) }), h("span", { class: "faint" }, unit));
	const active = v.active.length ? h("div", { class: "box warn-list" }, v.active.map((a) => h("div", {}, h("span", { class: "warn-dot" }), h("span", {}, alertText(a))))) : null;

	sheet.body.append(
		active ? h("div", { class: "sec" }, t("al.now")) : null,
		active,
		h("div", { class: "sec" }, t("al.channels"), v.env ? h("span", { class: "faint", style: "font-weight:500" }, t("al.env")) : null),
		list,
		h("div", { class: "sec" }, t("al.quiet")),
		h("div", { class: "box" }, muteBox),
		h("div", { class: "sec" }, t("al.rules")),
		h("div", { class: "box al-rules" },
			field(t("al.delay"), delay, t("al.delayHelp")),
			field(t("al.lang"), lang),
			h("div", { class: "al-limits" },
				field(t("al.limDisk"), lim("disk", "%", 50, 100)),
				field(t("al.limTemp"), lim("temp", "°C", 40, 110)),
				field(t("al.limMem"), lim("memory", "%", 50, 100)),
				field(t("al.limCert"), lim("certDays", t("al.days"), 0, 90)))),
		h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: async () => {
			const body = { channels: chans.map(({ id, type, name, enabled, fields, events }) => ({ id, type, name, enabled, fields, events })), delay: Number(delay.value), lang: lang.value, limits: v.limits, secrets };
			const r = await guard(() => api("POST", "/api/alerts", body));
			if (!r) return;
			toast(t("al.saved"));
			await loadState();
			sheet.close();
		} }, t("form.save")))
	);
}

// What's wrong with the server, in words (problem strip and the messages window).
function alertText(a) {
	if (a.kind === "disk") return t("al.disk", { n: a.name, v: a.value });
	if (a.kind === "temp") return t("al.temp", { v: a.value });
	if (a.kind === "memory") return t("al.memory", { v: a.value });
	if (a.kind === "restarts") return t("al.restarts", { n: a.name });
	if (a.kind === "cert") return a.value < 0 ? t("al.certGone", { n: a.name }) : t("al.cert", { n: a.name, v: a.value });
	return a.name;
}

// ---------- configuration ----------

function download(name, text, type = "application/json") {
	const a = h("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
	document.body.append(a);
	a.click();
	setTimeout(() => (URL.revokeObjectURL(a.href), a.remove()), 1000);
}

async function configSheet() {
	const sheet = openSheet({ wide: true });
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("cfg.title"))));
	const day = new Date().toISOString().slice(0, 10);
	const exp = async (withSecrets) => {
		if (withSecrets && !(await confirmSheet(t("cfg.secretsWarn"), t("cfg.exportSecrets")))) return;
		const r = await guard(() => api("GET", `/api/config/export${withSecrets ? "?secrets=1" : ""}`));
		if (r) download(`homebento-${day}${withSecrets ? "-with-logins" : ""}.json`, JSON.stringify(r, null, "\t"));
	};
	const preview = h("div");
	const picker = h("input", { type: "file", accept: ".json,.yaml,.yml,.html,.htm", style: "display:none", onchange: async (e) => {
		const file = e.target.files[0];
		e.target.value = "";
		if (!file) return;
		const text = await file.text();
		let data = null;
		try {
			data = JSON.parse(text);
		} catch {
			// not JSON: YAML or bookmarks
		}
		if (data && data.homebento) {
			if (!(await confirmSheet(t("cfg.replaceConfirm", { n: (data.config.services || []).length, b: (data.config.boards || []).length }), t("cfg.replace"), true))) return;
			if (!(await guard(() => api("POST", "/api/config/import", data)))) return;
			toast(t("cfg.imported"));
			await loadState();
			render();
			loadLive();
			return sheet.close();
		}
		importPreview(preview, text, file.name, sheet);
	} });
	const backups = h("div", { class: "box rows" });
	const loadBackups = async () => {
		const r = await guard(() => api("GET", "/api/backups"));
		if (!r) return;
		backups.replaceChildren(
			...r.items.slice(0, 8).map((b) => {
				const m = /config-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-([\w-]+)\.json/.exec(b.name) || [];
				const when = m[1] ? `${Number(m[3])}.${Number(m[2])}.${m[1]} ${m[4]}:${m[5]}` : b.name;
				return h("div", { class: "row" }, h("div", { class: "grow" }, h("div", { class: "title" }, when), h("div", { class: "sub" }, t(`cfg.bk.${m[6] || "manual"}`) === `cfg.bk.${m[6]}` ? m[6] : t(`cfg.bk.${m[6] || "manual"}`))),
					h("button", { class: "btn", onclick: async () => {
						if (!(await confirmSheet(t("cfg.restoreConfirm", { t: when }), t("cfg.restore"), true))) return;
						if (!(await guard(() => api("POST", `/api/backups/${encodeURIComponent(b.name)}/restore`)))) return;
						toast(t("cfg.restored"));
						await loadState();
						render();
						loadLive();
						sheet.close();
					} }, t("cfg.restore")));
			}),
			r.items.length ? null : h("div", { class: "row" }, h("span", { class: "sub" }, t("cfg.noBackups")))
		);
	};
	loadBackups();
	sheet.body.append(
		h("div", { class: "sec" }, t("cfg.export")),
		h("div", { class: "box cfg-box" }, h("div", { class: "help" }, t("cfg.exportHelp")), h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => exp(false) }, t("cfg.exportBtn")), h("button", { class: "btn", onclick: () => exp(true) }, t("cfg.exportSecrets")))),
		h("div", { class: "sec" }, t("cfg.import")),
		h("div", { class: "box cfg-box" }, h("div", { class: "help" }, t("cfg.importHelp")), h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => picker.click() }, t("cfg.pick")), picker)),
		preview,
		h("div", { class: "sec" }, t("cfg.backups"), h("button", { class: "sec-link", onclick: async () => (await guard(() => api("POST", "/api/backups"))) && (toast(t("cfg.backedUp")), loadBackups()) }, t("cfg.backupNow"))),
		backups,
		h("div", { class: "help", style: "margin:8px 2px 0" }, t("cfg.backupHelp"))
	);
}

// Services from Homepage, Dashy, Homer, Heimdall or bookmarks: pick, then take over.
async function importPreview(box, text, filename, sheet) {
	const r = await guard(() => api("POST", "/api/import", { text, filename }));
	if (!r) return;
	const skip = new Set();
	const pages = h("input", { type: "checkbox", checked: r.groups.length > 1 });
	const count = r.groups.reduce((a, g) => a + g.services.filter((x) => !x.exists).length, 0);
	box.replaceChildren(
		h("div", { class: "sec" }, t("cfg.found", { s: r.source })),
		h("div", { class: "box imp-list" },
			r.groups.map((g, gi) => [
				h("div", { class: "imp-group" }, g.name || "–"),
				...g.services.map((x, si) =>
					h("label", { class: `imp-row${x.exists ? " exists" : ""}` },
						h("input", { type: "checkbox", checked: !x.exists, disabled: x.exists, onchange: (e) => (e.target.checked ? skip.delete(`${gi}:${si}`) : skip.add(`${gi}:${si}`)) }),
						html(logo({ name: x.name, icon: x.icon, kind: x.kind })),
						h("div", { class: "grow" }, h("div", { class: "title" }, x.name), h("div", { class: "sub" }, [x.url, x.kind && S.state.kinds[x.kind] ? L(S.state.kinds[x.kind].label) : "", Object.keys(x.secrets || {}).length ? t("cfg.withLogin") : ""].filter(Boolean).join(" · "))),
						x.exists ? h("span", { class: "faint sm" }, t("cfg.exists")) : null))
			]),
			r.links.length ? h("div", { class: "imp-group" }, t("cfg.links", { n: r.links.length })) : null),
		r.warnings.length ? h("details", { class: "imp-warn" }, h("summary", {}, t("cfg.warnings", { n: r.warnings.length })), h("ul", {}, r.warnings.map((w) => h("li", {}, w)))) : null,
		h("div", { class: "box", style: "margin-top:8px" }, switchRow(t("cfg.pages"), pages, t("cfg.pagesHelp"))),
		h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: async () => {
			const res = await guard(() => api("POST", "/api/import", { text, filename, apply: true, skip: [...skip], pages: pages.checked }));
			if (!res) return;
			toast(t("cfg.added", { n: res.added }));
			await loadState();
			render();
			loadLive();
			sheet.close();
		} }, t("cfg.take", { n: count })))
	);
}

// ---------- kiosk mode ----------

// A tablet on the wall or a second screen: full screen, no buttons, pages change by themselves,
// darker at night. Settings per device (this browser), or as a link: ?kiosk&rotate=30&dim=22-7
const KIOSK_KEY = "homebento.kiosk";
const kioskDefaults = () => ({ rotate: 30, pages: [], dimFrom: "22:00", dimTo: "07:00", dim: 0.6, nightDim: true });
function kioskOpts() {
	try {
		return { ...kioskDefaults(), ...JSON.parse(localStorage.getItem(KIOSK_KEY) || "{}") };
	} catch {
		return kioskDefaults();
	}
}

function kioskSheet() {
	const sheet = openSheet();
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("ki.title")), h("span", { class: "sub" }, t("ki.sub"))));
	const o = kioskOpts();
	const rotate = h("select", { class: "input" }, [0, 15, 30, 60, 120, 300].map((n) => h("option", { value: n, selected: o.rotate === n }, n ? t("ki.every", { n: n < 60 ? `${n} s` : `${n / 60} min` }) : t("ki.noRotate"))));
	const pages = S.state.config.boards.map((b) => ({ b, input: h("input", { type: "checkbox", checked: !o.pages.length || o.pages.includes(b.id) }) }));
	const night = h("input", { type: "checkbox", checked: o.nightDim });
	const from = h("input", { class: "input", type: "time", value: o.dimFrom });
	const to = h("input", { class: "input", type: "time", value: o.dimTo });
	const fillDim = () => dim.style.setProperty("--p", `${((Number(dim.value) - 0.2) / 0.7) * 100}%`);
	const dim = h("input", { type: "range", class: "width-range", min: 0.2, max: 0.9, step: 0.05, value: o.dim, oninput: () => fillDim() });
	fillDim();
	const read = () => ({ rotate: Number(rotate.value), pages: pages.every((p) => p.input.checked) ? [] : pages.filter((p) => p.input.checked).map((p) => p.b.id), nightDim: night.checked, dimFrom: from.value || "22:00", dimTo: to.value || "07:00", dim: Number(dim.value) });
	const link = () => {
		const x = read();
		const q = new URLSearchParams({ kiosk: "1", rotate: x.rotate });
		if (x.pages.length) q.set("pages", x.pages.join(","));
		if (x.nightDim) q.set("dim", `${x.dimFrom}-${x.dimTo}`), q.set("level", x.dim);
		return `${location.origin}${location.pathname}?${q}`;
	};
	sheet.body.append(
		h("div", { class: "box" },
			field(t("ki.rotate"), rotate),
			h("div", { class: "field" }, h("label", {}, t("ki.pages")), h("div", { class: "ki-pages" }, pages.map((p) => h("label", { class: "chip-check" }, p.input, h("span", {}, p.b.name || t("board.default"))))))),
		h("div", { class: "box", style: "margin-top:8px" },
			switchRow(t("ki.night"), night, t("ki.nightHelp")),
			h("div", { class: "ki-times" }, field(t("ki.from"), from), field(t("ki.to"), to), field(t("ki.level"), dim))),
		h("div", { class: "help", style: "margin:8px 2px 0" }, t("ki.help")),
		h("div", { class: "acts" },
			h("button", { class: "btn primary", onclick: () => {
				const x = read();
				try {
					localStorage.setItem(KIOSK_KEY, JSON.stringify(x));
				} catch {
					// storage blocked: works for now anyway
				}
				sheet.close();
				startKiosk(x, true);
			} }, t("ki.start")),
			h("button", { class: "btn", onclick: async () => {
				try {
					await navigator.clipboard.writeText(link());
					toast(t("ki.copied"));
				} catch {
					prompt(t("ki.link"), link());
				}
			} }, t("ki.copy")))
	);
}

let kiosk = null;
function startKiosk(o, fullscreen) {
	stopKiosk();
	// no windows on the wall
	while (topSheet()) topSheet().sheet.close();
	if (S.editing) toggleEdit();
	document.body.classList.add("kiosk");
	const shade = h("div", { class: "ki-shade" });
	const exit = h("button", { class: "ki-exit", onclick: () => stopKiosk() }, t("ki.exit"));
	document.body.append(shade, exit);
	if (fullscreen && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
	const ids = () => (o.pages.length ? o.pages : S.state.config.boards.map((b) => b.id)).filter((id) => S.state.config.boards.some((b) => b.id === id));
	if (o.pages.length && !o.pages.includes(S.boardId) && ids()[0]) switchBoard(ids()[0]);
	const rot = o.rotate ? setInterval(() => {
		if (topSheet()) return; // someone is looking at details
		const list = ids();
		if (list.length < 2) return;
		switchBoard(list[(list.indexOf(S.boardId) + 1) % list.length]);
	}, o.rotate * 1000) : null;
	// darker at night
	const mins = (s) => Number(s.split(":")[0]) * 60 + Number(s.split(":")[1] || 0);
	const shadeTick = () => {
		const d = new Date();
		const m = d.getHours() * 60 + d.getMinutes();
		const a = mins(o.dimFrom);
		const b = mins(o.dimTo);
		const night = o.nightDim && (a < b ? m >= a && m < b : m >= a || m < b);
		shade.style.opacity = night ? String(o.dim) : "0";
	};
	shadeTick();
	const dimTimer = setInterval(shadeTick, 60000);
	// the cursor and the exit button only while the mouse moves
	let idle = null;
	const wake = () => {
		document.body.classList.remove("ki-idle");
		clearTimeout(idle);
		idle = setTimeout(() => document.body.classList.add("ki-idle"), 3000);
	};
	const key = (e) => e.key === "Escape" && !topSheet() && stopKiosk();
	document.addEventListener("mousemove", wake);
	document.addEventListener("keydown", key);
	wake();
	kiosk = { stop: () => (clearInterval(rot), clearInterval(dimTimer), clearTimeout(idle), document.removeEventListener("mousemove", wake), document.removeEventListener("keydown", key), shade.remove(), exit.remove()) };
}

function stopKiosk() {
	if (!kiosk) return;
	kiosk.stop();
	kiosk = null;
	document.body.classList.remove("kiosk", "ki-idle");
	if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
	if (/[?&]kiosk/.test(location.search)) history.replaceState(null, "", location.pathname);
}

// started by a link (?kiosk&rotate=30&pages=a,b&dim=22:00-07:00&level=0.6)
(function kioskFromLink() {
	const q = new URLSearchParams(location.search);
	if (!q.has("kiosk")) return;
	const wait = () => {
		if (!S.state || !S.live) return setTimeout(wait, 300);
		const o = kioskOpts();
		if (q.has("rotate")) o.rotate = Number(q.get("rotate")) || 0;
		if (q.has("pages")) o.pages = q.get("pages").split(",").filter(Boolean);
		if (q.has("dim")) {
			const [a, b] = q.get("dim").split("-");
			Object.assign(o, { nightDim: true, dimFrom: a.includes(":") ? a : `${a}:00`, dimTo: b.includes(":") ? b : `${b}:00` });
		}
		if (q.has("level")) o.dim = Number(q.get("level")) || 0.6;
		startKiosk(o, false);
	};
	wait();
})();

// ---------- options of the newer tiles ----------

const MORE_OPTIONS = {
	api: apiOptions,
	markets(tile) {
		const sheet = openSheet();
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("mk.title"))));
		const title = h("input", { class: "input", value: tile.title || "", placeholder: t("mk.title"), maxlength: 40 });
		const symbols = h("input", { class: "input", value: (tile.symbols || []).join(", "), placeholder: "^GSPC, NVDA, AAPL", autocapitalize: "characters", spellcheck: "false" });
		const fx = h("input", { class: "input", value: (tile.fx || []).join(", "), placeholder: "EUR, USD", autocapitalize: "characters" });
		const crypto = h("input", { class: "input", value: (tile.crypto || []).join(", "), placeholder: "bitcoin, ethereum", autocapitalize: "off", spellcheck: "false" });
		const base = h("select", { class: "input" }, ["CHF", "EUR", "USD", "GBP"].map((c) => h("option", { value: c, selected: (tile.base || "CHF") === c }, c)));
		const add = (input, v) => {
			const cur = input.value.split(",").map((x) => x.trim()).filter(Boolean);
			if (!cur.includes(v)) input.value = [...cur, v].join(", ");
		};
		// the biggest indices and companies worldwide (any other symbol can be typed)
		const presets = [["S&P 500", "^GSPC"], ["Nasdaq 100", "^NDX"], ["Dow Jones", "^DJI"], ["MSCI World", "URTH"], ["Euro Stoxx 50", "^STOXX50E"], ["DAX", "^GDAXI"], ["Nikkei 225", "^N225"], ["Nvidia", "NVDA"], ["Apple", "AAPL"], ["Microsoft", "MSFT"], ["Alphabet", "GOOGL"], ["Amazon", "AMZN"], ["Meta", "META"], ["Tesla", "TSLA"], ["Gold", "GC=F"]];
		const split = (el, up) => el.value.split(",").map((x) => (up ? x.trim().toUpperCase() : x.trim().toLowerCase())).filter(Boolean);
		sheet.body.append(
			h("div", { class: "box" }, field(t("settings.title"), title)),
			h("div", { class: "sec" }, t("mk.symbols")),
			h("div", { class: "box" }, field(null, symbols, t("mk.symbolsHelp")), h("div", { class: "chips-row" }, presets.map(([n, sym]) => h("button", { class: "chip", onclick: () => add(symbols, sym) }, `+ ${n}`)))),
			h("div", { class: "sec" }, t("mk.fx")),
			h("div", { class: "box" }, field(t("mk.base"), base), field(t("mk.currencies"), fx, t("mk.fxHelp")), field(t("mk.crypto"), crypto, t("mk.cryptoHelp"))),
			h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => {
				updateTile(tile.id, { title: title.value.trim() || undefined, symbols: split(symbols, true), fx: split(fx, true), crypto: split(crypto, false), base: base.value });
				sheet.close();
			} }, t("form.save")))
		);
	},
	holidays(tile) {
		const sheet = openSheet();
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("hol.title"))));
		const canton = h("select", { class: "input" }, Object.entries(S.state.cantons || {}).sort((a, b) => L(a[1]).localeCompare(L(b[1]))).map(([k, v]) => h("option", { value: k, selected: (tile.canton || "ZH") === k }, `${L(v)} (${k})`)));
		sheet.body.append(h("div", { class: "box" }, field(t("hol.canton"), canton, t("hol.help"))), h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => (updateTile(tile.id, { canton: canton.value }), sheet.close()) }, t("form.save"))));
	},
	countdown(tile) {
		const sheet = openSheet();
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("cd.title"))));
		const title = h("input", { class: "input", value: tile.title || "", placeholder: t("cd.title"), maxlength: 40 });
		const items = (tile.items || []).map((c) => ({ ...c }));
		const list = h("div");
		const draw = () =>
			list.replaceChildren(
				...items.map((c, i) =>
					h("div", { class: "link-edit cd-edit" },
						h("input", { class: "input", value: c.name, placeholder: t("cd.namePh"), oninput: (e) => (c.name = e.target.value) }),
						h("input", { class: "input", type: "date", value: c.date.slice(0, 10), oninput: (e) => (c.date = e.target.value) }),
						h("label", { class: "chip-check", title: t("cd.yearlyHelp") }, h("input", { type: "checkbox", checked: !!c.yearly, onchange: (e) => (c.yearly = e.target.checked) }), h("span", {}, t("cd.yearly"))),
						h("button", { class: "x row-x", onclick: () => (items.splice(i, 1), draw()), html: UI.x }))
				),
				items.length < 8 ? h("div", { class: "field" }, h("button", { class: "btn", onclick: () => (items.push({ name: "", date: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10) }), draw()) }, html(UI.plus), t("cd.add"))) : null
			);
		draw();
		sheet.body.append(h("div", { class: "box" }, field(t("settings.title"), title)), h("div", { class: "sec" }, t("cd.items")), h("div", { class: "box" }, list), h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: () => (updateTile(tile.id, { title: title.value.trim() || undefined, items: items.filter((c) => c.date) }), sheet.close()) }, t("form.save"))));
	},
	async camera(tile) {
		const sheet = openSheet();
		sheet.head(h("div", { class: "tt" }, h("b", {}, t("cam.title"))));
		const has = tile.id ? ((await api("GET", `/api/tiles/${tile.id}/secrets`).catch(() => ({ secrets: {} }))).secrets || {}) : {};
		const title = h("input", { class: "input", value: tile.title || "", placeholder: t("cam.title"), maxlength: 40 });
		const url = h("input", { class: "input", value: tile.url || "", placeholder: "http://192.168.1.50/snapshot.jpg", inputmode: "url", autocapitalize: "off", spellcheck: "false" });
		const mode = h("select", { class: "input" }, [["snapshot", t("cam.snapshot")], ["mjpeg", t("cam.mjpeg")]].map(([v, l]) => h("option", { value: v, selected: (tile.mode || "snapshot") === v }, l)));
		const refresh = h("input", { class: "input", type: "number", min: 1, max: 600, value: tile.refresh || 5 });
		const user = h("input", { class: "input", placeholder: has.user ? t("form.secretSet") : "", autocomplete: "off" });
		const pass = h("input", { class: "input", type: "password", placeholder: has.password ? t("form.secretSet") : "", autocomplete: "off" });
		const insecure = h("input", { type: "checkbox", checked: !!tile.insecure });
		sheet.body.append(
			h("div", { class: "box" }, field(t("settings.title"), title), field(t("cam.url"), url, t("cam.urlHelp")), field(t("cam.mode"), mode), field(t("cam.refresh"), refresh)),
			h("div", { class: "sec" }, t("cam.login")),
			h("div", { class: "box" }, field(t("form.user"), user), field(t("form.password"), pass), switchRow(t("form.insecure"), insecure)),
			h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: async () => {
				updateTile(tile.id, { title: title.value.trim() || undefined, url: url.value.trim(), mode: mode.value, refresh: Number(refresh.value) || 5, insecure: insecure.checked });
				if (user.value || pass.value) {
					if (!(await savePageNow())) return;
					await guard(() => api("POST", `/api/tiles/${tile.id}/secrets`, { secrets: { user: user.value, password: pass.value } }));
				}
				sheet.close();
				loadLive();
			} }, t("form.save")))
		);
	}
};

// Own API: an address, a test, then pick the values to show from the answer.
async function apiOptions(tile) {
	const sheet = openSheet({ wide: true });
	sheet.head(h("div", { class: "tt" }, h("b", {}, t("api.title")), h("span", { class: "sub" }, t("api.sub"))));
	const a = structuredClone(tile.api || { url: "", method: "GET", headers: [], fields: [], ttl: 60 });
	a.headers = a.headers || [];
	a.fields = a.fields || [];
	const has = tile.id ? ((await api("GET", `/api/tiles/${tile.id}/secrets`).catch(() => ({ secrets: {} }))).secrets || {}) : {};
	const headerValues = {};
	const title = h("input", { class: "input", value: tile.title || "", placeholder: t("api.title"), maxlength: 40 });
	const url = h("input", { class: "input", value: a.url || "", placeholder: "https://api.example.com/status", inputmode: "url", autocapitalize: "off", spellcheck: "false", oninput: (e) => (a.url = e.target.value.trim()) });
	const method = h("select", { class: "input", onchange: (e) => ((a.method = e.target.value), (bodyField.style.display = a.method === "POST" ? "" : "none")) }, ["GET", "POST"].map((m) => h("option", { value: m, selected: a.method === m }, m)));
	const body = h("textarea", { class: "input", rows: 3, placeholder: '{"query": "…"}', oninput: (e) => (a.body = e.target.value) }, a.body || "");
	body.value = a.body || "";
	const bodyField = field(t("api.body"), body);
	bodyField.style.display = a.method === "POST" ? "" : "none";
	const ttl = h("select", { class: "input", onchange: (e) => (a.ttl = Number(e.target.value)) }, [15, 30, 60, 300, 900, 3600].map((n) => h("option", { value: n, selected: (a.ttl || 60) === n }, n < 60 ? `${n} s` : `${n / 60} min`)));
	const insecure = h("input", { type: "checkbox", checked: !!a.insecure, onchange: (e) => (a.insecure = e.target.checked) });
	const headers = h("div");
	const drawHeaders = () =>
		headers.replaceChildren(
			...a.headers.map((x, i) =>
				h("div", { class: "link-edit" },
					h("input", { class: "input", value: x.name, placeholder: "Authorization", oninput: (e) => (x.name = e.target.value.trim()) }),
					h("input", { class: "input", type: "password", autocomplete: "off", placeholder: has[x.name] ? t("form.secretSet") : "Bearer …", oninput: (e) => (headerValues[x.name] = e.target.value) }),
					h("button", { class: "x row-x", onclick: () => (a.headers.splice(i, 1), drawHeaders()), html: UI.x }))
			),
			a.headers.length < 6 ? h("div", { class: "field" }, h("button", { class: "btn", onclick: () => (a.headers.push({ name: "" }), drawHeaders()) }, html(UI.plus), t("api.addHeader"))) : null
		);
	drawHeaders();

	// what to show: values (label, path, format) and an optional list
	const FORMATS = ["auto", "text", "number", "percent", "bytes", "bitrate", "duration", "date", "relative", "boolean"];
	const fields = h("div");
	const drawFields = () =>
		fields.replaceChildren(
			...a.fields.map((f, i) =>
				h("div", { class: "api-field" },
					h("input", { class: "input", value: f.label, placeholder: t("api.label"), oninput: (e) => (f.label = e.target.value) }),
					h("input", { class: "input mono", value: f.path, placeholder: "data.temperature", spellcheck: "false", oninput: (e) => (f.path = e.target.value.trim()) }),
					h("select", { class: "input", onchange: (e) => (f.format = e.target.value) }, FORMATS.map((x) => h("option", { value: x, selected: (f.format || "auto") === x }, t(`api.f.${x}`)))),
					h("input", { class: "input", value: f.suffix || "", placeholder: t("api.suffix"), oninput: (e) => (f.suffix = e.target.value) }),
					h("input", { class: "input", type: "number", value: f.warnAbove ?? "", placeholder: t("api.warnAbove"), title: t("api.warnAbove"), oninput: (e) => (f.warnAbove = e.target.value === "" ? undefined : Number(e.target.value)) }),
					h("button", { class: "x row-x", onclick: () => (a.fields.splice(i, 1), drawFields()), html: UI.x }))
			),
			a.fields.length ? null : h("div", { class: "help", style: "padding:10px 12px" }, t("api.noFields"))
		);
	drawFields();
	const list = a.list || { path: "", title: "", sub: "", status: "" };
	const useList = h("input", { type: "checkbox", checked: !!a.list });
	const listInputs = ["path", "title", "sub", "status"].map((k) => h("input", { class: "input mono", value: list[k] || "", placeholder: t(`api.list.${k}Ph`), spellcheck: "false", oninput: (e) => (list[k] = e.target.value.trim()) }));

	// the test: answer, time, and the paths to click
	const result = h("div");
	const run = async (e) => {
		const b = e.currentTarget;
		b.classList.add("busy");
		const r = await guard(() => api("POST", "/api/api-preview", { tile: tile.id, api: { ...a, url: url.value.trim() }, secrets: headerValues }));
		b.classList.remove("busy");
		if (!r) return;
		if (r.error) return result.replaceChildren(h("div", { class: "note bad" }, r.error), r.text ? h("pre", { class: "api-raw" }, r.text) : null);
		result.replaceChildren(
			h("div", { class: "note ok" }, t("api.ok", { s: r.status, ms: r.ms })),
			h("div", { class: "help", style: "margin:4px 2px 6px" }, t("api.pick")),
			h("div", { class: "api-paths" },
				r.paths.slice(0, 200).map((p) =>
					h("button", { class: `api-path t-${p.type}`, title: p.type === "array" ? t("api.asList") : t("api.asValue"), onclick: () => {
						if (p.type === "array") {
							list.path = p.path;
							useList.checked = true;
							listInputs[0].value = p.path;
							return toast(t("api.listSet", { p: p.path }));
						}
						a.fields.push({ label: p.path.split(/[.[\]]/).filter(Boolean).pop() || p.path, path: p.path, format: p.type === "number" ? "number" : "auto" });
						drawFields();
					} }, h("span", { class: "mono" }, p.path), h("span", { class: "faint" }, p.sample))))
		);
	};
	sheet.body.append(
		h("div", { class: "box" },
			field(t("settings.title"), title),
			h("div", { class: "api-url" }, method, url),
			bodyField,
			h("div", { class: "api-row2" }, field(t("api.ttl"), ttl), switchRow(t("form.insecure"), insecure))),
		h("div", { class: "sec" }, t("api.headers")),
		h("div", { class: "box" }, headers, h("div", { class: "help", style: "padding:0 12px 10px" }, t("api.headersHelp"))),
		h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: run }, t("api.test"))),
		result,
		h("div", { class: "sec" }, t("api.values")),
		h("div", { class: "box" }, fields),
		h("div", { class: "sec" }, t("api.list")),
		h("div", { class: "box" }, switchRow(t("api.useList"), useList, t("api.listHelp")), h("div", { class: "api-list" }, listInputs.map((input, i) => field(t(`api.list.${["path", "title", "sub", "status"][i]}`), input)))),
		h("div", { class: "acts" }, h("button", { class: "btn primary", onclick: async () => {
			a.url = url.value.trim();
			a.list = useList.checked ? { ...list } : undefined;
			a.headers = a.headers.filter((x) => x.name);
			updateTile(tile.id, { title: title.value.trim() || undefined, api: a });
			const values = Object.fromEntries(Object.entries(headerValues).filter(([k, v]) => k && v));
			if (Object.keys(values).length) {
				if (!(await savePageNow())) return;
				await guard(() => api("POST", `/api/tiles/${tile.id}/secrets`, { secrets: values }));
			}
			sheet.close();
			loadLive();
		} }, t("form.save")))
	);
}

// camera stills: a fresh picture every few seconds (only the picture changes)
setInterval(() => {
	const now = Date.now();
	for (const img of document.querySelectorAll("img[data-cam-refresh]")) {
		const every = Number(img.dataset.camRefresh) * 1000;
		if (now - (Number(img.dataset.at) || 0) < every) continue;
		img.dataset.at = now;
		const next = new Image();
		next.onload = () => (img.src = next.src);
		next.src = `/api/camera/${img.dataset.cam}?t=${now}`;
	}
}, 1000);

// A camera big, as long as the window is open.
function cameraView(tile) {
	const sheet = openSheet({ wide: true });
	sheet.el.classList.add("cam-sheet");
	sheet.head(h("div", { class: "tt" }, h("b", {}, tile.title || t("cam.title"))));
	const img = tile.mode === "mjpeg" ? h("img", { class: "cam-big", src: `/api/camera/${tile.id}`, alt: "" }) : h("img", { class: "cam-big", src: `/api/camera/${tile.id}?t=${Date.now()}`, alt: "", "data-cam": tile.id, "data-cam-refresh": Math.min(tile.refresh || 5, 5) });
	sheet.body.append(img);
	// a stream stops when the window closes
	sheet.onclose = () => img.removeAttribute("src");
}

// ---------- page width ----------

// The width of the page in percent of the screen: a slider, the page follows while dragging,
// saved when let go. Without a setting the page is at most 1480 px wide. Columns follow the
// real width (6, 8 from 1800 px, 10 from 2500 px).
function applyWidth(w) {
	const pct = Number(w);
	const full = w === "wide" || pct >= 100;
	document.body.classList.toggle("wide", full);
	document.documentElement.style.setProperty("--maxw", full ? "none" : pct >= 40 && pct <= 100 ? `${pct}%` : "1480px");
	// a fixed number of columns: a smaller window makes the tiles narrower, nothing moves
	document.documentElement.style.setProperty("--cols", [6, 8, 10].includes(S.state.config.columns) ? S.state.config.columns : 6);
}

// How many columns the tiles have (the same on every screen; below ~1050 px it becomes 4, then 2).
function columnsField() {
	const cur = [6, 8, 10].includes(S.state.config.columns) ? S.state.config.columns : 6;
	const sel = h("select", { class: "input", onchange: async (e) => {
		const n = Number(e.target.value);
		if (await guard(() => api("POST", "/api/settings", { columns: n }))) {
			S.state.config.columns = n;
			applyWidth(S.state.config.width);
		}
	} }, [6, 8, 10].map((n) => h("option", { value: n, selected: cur === n }, t("settings.colsN", { n }))));
	return h("div", { class: "field" }, h("label", {}, t("settings.cols")), sel, h("div", { class: "help" }, t("settings.colsHelp")));
}
function widthField() {
	const cur = S.state.config.width;
	const now = cur === "wide" ? 100 : Number(cur) >= 40 && Number(cur) <= 100 ? Number(cur) : Math.min(100, Math.max(50, Math.round((1480 / window.innerWidth) * 100)));
	const label = h("span", { class: "num width-val" });
	const show = (v) => label.replaceChildren(v >= 100 ? t("settings.widthWide") : `${v} %`);
	const range = h("input", { type: "range", class: "width-range", min: 50, max: 100, step: 1, value: now,
		oninput: (e) => {
			const v = Number(e.target.value);
			show(v);
			applyWidth(v);
			range.style.setProperty("--p", `${((v - 50) / 50) * 100}%`);
		},
		onchange: async (e) => {
			const v = Number(e.target.value);
			if (await guard(() => api("POST", "/api/settings", { width: v }))) S.state.config.width = v;
		} });
	range.style.setProperty("--p", `${((now - 50) / 50) * 100}%`);
	show(now);
	return h("div", { class: "field" }, h("label", { class: "width-label" }, t("settings.width"), label), range, h("div", { class: "help" }, t("settings.widthHelp")));
}


// ---------- appearance: background and main colour ----------

const BG_PRESETS = [["#101012", "default"], ["#000000", "black"], ["#17181c", "graphite"], ["#0c1220", "midnight"], ["#0d1512", "forest"], ["#150f1a", "plum"]];
const ACCENTS = ["#9dbcff", "#b18cff", "#5fd39a", "#4dd0e1", "#f5b83d", "#ff8a65", "#ff7eb6"];

// light or dark text on a colour
const inkOn = (hex) => {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
	return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.55 ? "#0b1530" : "#ffffff";
};

function applyTheme(th) {
	const root = document.documentElement.style;
	th = th || {};
	const bg = th.bg || "#101012";
	root.setProperty("--bg", bg);
	// the tiles: a little lighter than the background, three steps
	root.setProperty("--tile", `color-mix(in srgb, ${bg} 92%, #ffffff)`);
	root.setProperty("--tile-2", `color-mix(in srgb, ${bg} 88%, #ffffff)`);
	root.setProperty("--tile-3", `color-mix(in srgb, ${bg} 84%, #ffffff)`);
	if (!th.bg) ["--tile", "--tile-2", "--tile-3"].forEach((v) => root.removeProperty(v));
	if (th.accent) {
		root.setProperty("--accent", th.accent);
		root.setProperty("--accent-ink", inkOn(th.accent));
	} else ["--accent", "--accent-ink"].forEach((v) => root.removeProperty(v));
	// a picture behind everything, dimmed with the background colour; the tiles go glassy over it
	document.body.classList.toggle("bg-image", !!th.image);
	if (th.image) {
		const dim = th.dim ?? 0.6;
		document.body.style.backgroundImage = `linear-gradient(color-mix(in srgb, ${bg} ${Math.round(dim * 100)}%, transparent), color-mix(in srgb, ${bg} ${Math.round(dim * 100)}%, transparent)), url("${th.image.replace(/"/g, "%22")}")`;
	} else document.body.style.backgroundImage = "";
}

function themeField() {
	const th = { ...(S.state.config.theme || {}) };
	let timer;
	const save = () => {
		applyTheme(th);
		clearTimeout(timer);
		timer = setTimeout(async () => {
			if (await guard(() => api("POST", "/api/settings", { theme: th }))) S.state.config.theme = { ...th };
		}, 400);
	};
	const swatches = (list, key, fallback) => {
		const wrap = h("div", { class: "swatches" });
		const draw = () => {
			const cur = th[key] || fallback;
			wrap.replaceChildren(
				...list.map((c) => h("button", { class: `sw${cur === c ? " on" : ""}`, style: `--sw:${c}`, title: c, onclick: () => ((th[key] = c === fallback ? undefined : c), save(), draw()) })),
				h("label", { class: `sw custom${list.includes(cur) ? "" : " on"}`, title: t("theme.custom") }, h("input", { type: "color", value: cur, oninput: (e) => ((th[key] = e.target.value), save(), draw()) }))
			);
		};
		draw();
		return wrap;
	};
	const dimLabel = h("span", { class: "num width-val" }, `${Math.round((th.dim ?? 0.6) * 100)} %`);
	const dim = h("input", { type: "range", class: "width-range", min: 0, max: 90, step: 5, value: Math.round((th.dim ?? 0.6) * 100),
		oninput: (e) => ((th.dim = Number(e.target.value) / 100), dimLabel.replaceChildren(`${e.target.value} %`), e.target.style.setProperty("--p", `${(e.target.value / 90) * 100}%`), save()) });
	dim.style.setProperty("--p", `${(((th.dim ?? 0.6) * 100) / 90) * 100}%`);
	const dimField = h("div", { class: "field", style: th.image ? "" : "display:none" }, h("label", { class: "width-label" }, t("theme.dim"), dimLabel), dim);
	const img = h("input", { class: "input", type: "url", placeholder: "https://…/bild.jpg", value: th.image || "", spellcheck: "false",
		onchange: (e) => {
			const v = e.target.value.trim();
			th.image = /^https?:\/\//.test(v) ? v : undefined;
			dimField.style.display = th.image ? "" : "none";
			save();
		} });
	const reset = h("button", { class: "chip", onclick: () => {
		for (const k of Object.keys(th)) delete th[k];
		applyTheme(th);
		guard(() => api("POST", "/api/settings", { theme: {} })).then((ok) => ok && (S.state.config.theme = undefined));
		img.value = "";
		dimField.style.display = "none";
		bgBox.replaceChildren(swatches(BG_PRESETS.map((x) => x[0]), "bg", "#101012"));
		acBox.replaceChildren(swatches(ACCENTS, "accent", "#9dbcff"));
	} }, t("theme.reset"));
	const bgBox = h("div", {}, swatches(BG_PRESETS.map((x) => x[0]), "bg", "#101012"));
	const acBox = h("div", {}, swatches(ACCENTS, "accent", "#9dbcff"));
	return h("div", { class: "theme-fields" },
		h("div", { class: "field" }, h("label", {}, t("theme.bg")), bgBox),
		h("div", { class: "field" }, h("label", {}, t("theme.accent")), acBox),
		h("div", { class: "field" }, h("label", {}, t("theme.image")), img, h("div", { class: "help" }, t("theme.imageHelp"))),
		dimField,
		h("div", { class: "field" }, reset));
}
