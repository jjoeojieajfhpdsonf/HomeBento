"use strict";
// Plugins for apps (Mealie, Tandoor, Karakeep, Linkwarden, Miniflux, Homebox, Trilium, Spoolman,
// Plant-it, Syncthing Relay, Firefly III, Wallos), each against a small fake server that answers
// like the real API.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { request, json } = require("../lib/util");

const TOKEN = "good-token";
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const TODAY = isoDay(new Date());

// Starts a fake server; handler(req, url, send, body) with send(value, status, headers).
async function serve(handler) {
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			const url = new URL(req.url, "http://x");
			const send = (v, status = 200, headers = {}) => {
				res.writeHead(status, { "Content-Type": "application/json", ...headers });
				res.end(JSON.stringify(v));
			};
			const out = handler(req, url, send, body);
			if (out === undefined && !res.headersSent) send({ message: "Not Found" }, 404);
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => (server.close(r), server.closeAllConnections())) };
}

async function run(kind, handler, secrets = {}) {
	const plugin = require(`../lib/plugins/${kind}`);
	const srv = await serve(handler);
	try {
		return await plugin.fetch({ url: srv.url, secrets, service: { id: "s1", kind }, request, json });
	} finally {
		await srv.close();
	}
}

const values = (r) => r.metrics.map((m) => (m.value !== null && typeof m.value === "object" ? m.value.en : m.value));
const items = (r) => r.items.map((i) => [i.title, i.sub, i.status]);

// ---------- Mealie ----------

function mealie(v2) {
	return (req, url, send) => {
		if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ detail: "Not authenticated" }, 401);
		const base = v2 ? "households" : "groups";
		if (url.pathname === `/api/${base}/statistics`) return send({ totalRecipes: 142, totalUsers: 3, totalCategories: 12, totalTags: 30, totalTools: 4 });
		if (url.pathname === `/api/${base}/mealplans/today`)
			return send([
				{ date: TODAY, entryType: "dinner", title: "", recipe: { name: "Lasagne" } },
				{ date: TODAY, entryType: "breakfast", title: "Müesli", recipe: null }
			]);
	};
}

test("Mealie v2: statistics and today's meal plan", async () => {
	const r = await run("mealie", mealie(true), { token: TOKEN });
	assert.deepEqual(values(r), [142, 3, 12, 2]);
	assert.deepEqual(items(r), [
		["Müesli", "breakfast", "ok"],
		["Lasagne", "dinner", "ok"]
	]);
	assert.equal(r.summary, "Today: Müesli, Lasagne");
});

test("Mealie v1 falls back to the group API", async () => {
	const r = await run("mealie", mealie(false), { token: TOKEN });
	assert.deepEqual(values(r), [142, 3, 12, 2]);
});

test("Mealie with a wrong or missing token", async () => {
	await assert.rejects(run("mealie", mealie(true), { token: "wrong" }), /Access denied/);
	await assert.rejects(run("mealie", mealie(true), {}), /API token missing/);
});

// ---------- Tandoor ----------

function tandoor(req, url, send) {
	if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ detail: "Authentication credentials were not provided." }, 403);
	if (url.pathname === "/api/recipe/") return send({ count: 87, next: null, previous: null, results: [{ id: 1, name: "Rösti" }] });
	if (url.pathname === "/api/keyword/") return send({ count: 25, results: [] });
	if (url.pathname === "/api/meal-plan/") {
		assert.equal(url.searchParams.get("from_date"), TODAY);
		return send([
			{ id: 2, title: "", recipe: { name: "Zürcher Geschnetzeltes" }, meal_type: { name: "Dinner", order: 2 }, from_date: TODAY },
			{ id: 1, title: "Gipfeli", recipe: null, meal_type: { name: "Breakfast", order: 0 }, from_date: TODAY }
		]);
	}
}

test("Tandoor: recipes, keywords and today's meal plan", async () => {
	const r = await run("tandoor", tandoor, { token: TOKEN });
	assert.deepEqual(values(r), [87, 25, 2]);
	assert.deepEqual(items(r), [
		["Gipfeli", "Breakfast", "ok"],
		["Zürcher Geschnetzeltes", "Dinner", "ok"]
	]);
});

test("Tandoor with a wrong token", async () => {
	await assert.rejects(run("tandoor", tandoor, { token: "nope" }), /Access denied/);
});

// ---------- Karakeep ----------

test("Karakeep: bookmarks, lists and tags", async () => {
	const r = await run(
		"karakeep",
		(req, url, send) => {
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ code: "UNAUTHORIZED" }, 401);
			if (url.pathname === "/api/v1/users/me/stats") return send({ numBookmarks: 512, numFavorites: 20, numArchived: 100, numTags: 64, numLists: 7, numHighlights: 3 });
		},
		{ apiKey: TOKEN }
	);
	assert.deepEqual(values(r), [512, 20, 7, 64]);
	assert.equal(r.summary, "100 archived");
});

test("Karakeep without the statistics API asks for an update", async () => {
	await assert.rejects(run("karakeep", (req, url, send) => send({}, 404), { apiKey: TOKEN }), /update/);
});

// ---------- Linkwarden ----------

test("Linkwarden: links summed over collections", async () => {
	const r = await run(
		"linkwarden",
		(req, url, send) => {
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ response: "You must be logged in." }, 401);
			if (url.pathname === "/api/v1/collections")
				return send({
					response: [
						{ id: 1, name: "Unorganized", _count: { links: 12 } },
						{ id: 2, name: "Homelab", _count: { links: 40 } },
						{ id: 3, name: "Recipes", _count: { links: 0 } }
					]
				});
			if (url.pathname === "/api/v1/tags") return send({ response: [{ id: 1, name: "docker" }, { id: 2, name: "linux" }] });
		},
		{ token: TOKEN }
	);
	assert.deepEqual(values(r), [52, 3, 2]);
	assert.deepEqual(items(r)[0], ["Homelab", "40 links", "ok"]);
});

// ---------- Miniflux ----------

function miniflux(req, url, send) {
	if (req.headers["x-auth-token"] !== TOKEN) return send({ error_message: "Access Unauthorized" }, 401);
	if (url.pathname === "/v1/feeds/counters") return send({ reads: { 1: 10, 2: 4, 3: 0 }, unreads: { 1: 5, 2: 0, 3: 9 } });
	if (url.pathname === "/v1/feeds")
		return send([
			{ id: 1, title: "Heise", parsing_error_count: 0, parsing_error_message: "", disabled: false },
			{ id: 2, title: "Broken Blog", parsing_error_count: 3, parsing_error_message: "404 Not Found", disabled: false },
			{ id: 3, title: "SRF News", parsing_error_count: 0, disabled: false },
			{ id: 4, title: "Old feed", parsing_error_count: 9, parsing_error_message: "timeout", disabled: true }
		]);
}

test("Miniflux: unread entries and failing feeds", async () => {
	const r = await run("miniflux", miniflux, { apiKey: TOKEN });
	assert.deepEqual(values(r), [14, 3, 1]);
	assert.equal(r.metrics[2].warn, true);
	assert.deepEqual(items(r), [
		["Broken Blog", "404 Not Found", "bad"],
		["SRF News", "9 unread", "ok"],
		["Heise", "5 unread", "ok"]
	]);
	assert.deepEqual(r.warnings, ["Feed Broken Blog: 404 Not Found"]);
});

test("Miniflux with a wrong key", async () => {
	await assert.rejects(run("miniflux", miniflux, { apiKey: "bad" }), /Access denied/);
});

// ---------- Homebox ----------

function homebox(state) {
	return (req, url, send, body) => {
		if (url.pathname === "/api/v1/users/login" && req.method === "POST") {
			state.logins++;
			const p = new URLSearchParams(body);
			if (req.headers["content-type"] !== "application/x-www-form-urlencoded" || p.get("username") !== "me@home.ch" || p.get("password") !== "secret") return send({ error: "authentication failed" }, 401);
			return send({ token: `Bearer tok${state.logins}`, expiresAt: new Date(Date.now() + 3600000).toISOString() });
		}
		if (req.headers.authorization !== `Bearer tok${state.valid}`) return send({ error: "unauthorized" }, 401);
		if (url.pathname === "/api/v1/groups/statistics") return send({ totalUsers: 2, totalItems: 321, totalLocations: 9, totalLabels: 14, totalItemPrice: 12345.5, totalWithWarranty: 6 });
		if (url.pathname === "/api/v1/groups") return send({ id: "g", name: "Home", currency: "chf" });
		if (url.pathname === "/api/v1/locations")
			return send([
				{ id: "1", name: "Garage", itemCount: 40 },
				{ id: "2", name: "Office", itemCount: 120 }
			]);
	};
}

test("Homebox: logs in, keeps the token and logs in again after a 401", async () => {
	const plugin = require("../lib/plugins/homebox");
	const state = { logins: 0, valid: 1 };
	const srv = await serve(homebox(state));
	const secrets = { username: "me@home.ch", password: "secret" };
	try {
		const r = await plugin.fetch({ url: srv.url, secrets, service: { id: "s1" }, request, json });
		assert.deepEqual(values(r), [321, 9, 14, "CHF 12,345.50"]);
		assert.equal(r.metrics[3].value.de, "CHF 12'345.50");
		assert.deepEqual(items(r), [
			["Office", "120 items", "ok"],
			["Garage", "40 items", "ok"]
		]);
		await plugin.fetch({ url: srv.url, secrets, service: { id: "s1" }, request, json });
		assert.equal(state.logins, 1);
		state.valid = 2; // token expired on the server
		const again = await plugin.fetch({ url: srv.url, secrets, service: { id: "s1" }, request, json });
		assert.equal(state.logins, 2);
		assert.equal(again.metrics[0].value, 321);
	} finally {
		await srv.close();
	}
});

test("Homebox with a wrong or missing password", async () => {
	await assert.rejects(run("homebox", homebox({ logins: 0, valid: 1 }), { username: "me@home.ch", password: "wrong" }), /check username and password/);
	await assert.rejects(run("homebox", homebox({ logins: 0, valid: 1 }), { username: "me@home.ch" }), /password missing/);
});

// ---------- Trilium ----------

test("Trilium: notes and version from the ETAPI metrics", async () => {
	const r = await run(
		"trilium",
		(req, url, send) => {
			if (req.headers.authorization !== TOKEN) return send({ status: 401, code: "NOT_AUTHENTICATED" }, 401);
			if (url.pathname === "/etapi/metrics" && url.searchParams.get("format") === "json")
				return send({
					version: { app: "0.98.1", db: 233, node: "v22", sync: 36, buildDate: "", buildRevision: "" },
					database: { totalNotes: 1300, deletedNotes: 100, activeNotes: 1200, protectedNotes: 5, activeAttachments: 80 },
					timestamp: new Date().toISOString(),
					statistics: { databaseSizeBytes: 52428800 }
				});
		},
		{ token: TOKEN }
	);
	assert.deepEqual(values(r), [1200, 80, "50 MB", "v0.98.1"]);
	assert.equal(r.summary, "5 protected notes");
});

test("Trilium without metrics shows the version", async () => {
	const r = await run(
		"trilium",
		(req, url, send) => {
			if (url.pathname === "/etapi/app-info") return send({ appVersion: "0.63.7", dbVersion: 228 });
		},
		{ token: TOKEN }
	);
	assert.deepEqual(values(r), [null, "v0.63.7"]);
});

// ---------- Spoolman ----------

test("Spoolman: remaining filament and low spools", async () => {
	const r = await run("spoolman", (req, url, send) => {
		if (url.pathname === "/api/v1/spool")
			return send([
				{ id: 1, filament: { name: "Galaxy Black", material: "PLA", vendor: { name: "Prusament" }, weight: 1000 }, initial_weight: 1000, remaining_weight: 820.4, location: "Shelf", archived: false },
				{ id: 2, filament: { name: "Orange", material: "PETG", vendor: { name: "Sunlu" }, weight: 1000 }, remaining_weight: 73, archived: false },
				{ id: 3, filament: { name: "White", material: "PLA" }, remaining_weight: 1500, initial_weight: 2000, archived: false }
			]);
	});
	assert.deepEqual(values(r), [3, "2.4 kg", 1]);
	assert.equal(r.metrics[2].warn, true);
	assert.deepEqual(items(r), [
		["Sunlu Orange", "73 g left (7 %) · PETG", "warn"],
		["Prusament Galaxy Black", "820 g left (82 %) · PLA · Shelf", "ok"],
		["White", "1.5 kg left (75 %) · PLA", "ok"]
	]);
	assert.deepEqual(r.warnings, ["Sunlu Orange (#2): only 73 g left"]);
});

// ---------- Plant-it ----------

test("Plant-it: plants and due care tasks", async () => {
	const day = 86400000;
	const now = Date.now();
	const r = await run(
		"plantit",
		(req, url, send) => {
			if (req.headers.key !== TOKEN) return send({ message: "Unauthorized" }, 401);
			if (url.pathname === "/api/stats") return send({ diaryEntryCount: 57, plantCount: 12, botanicalInfoCount: 10, imageCount: 30 });
			if (url.pathname === "/api/reminder/occurrences") {
				assert.ok(url.searchParams.get("from") && url.searchParams.get("to"));
				return send({
					content: [
						{ date: new Date(now - 3 * day).toISOString(), reminderId: 1, reminderAction: "WATERING", reminderTargetId: 4, reminderTargetInfoPersonalName: "Monstera" },
						{ date: new Date(now - 1 * day).toISOString(), reminderId: 1, reminderAction: "WATERING", reminderTargetId: 4, reminderTargetInfoPersonalName: "Monstera" },
						{ date: new Date(now + 2 * day).toISOString(), reminderId: 2, reminderAction: "FERTILIZING", reminderTargetId: 5, reminderTargetInfoPersonalName: "Ficus" }
					],
					totalElements: 3
				});
			}
		},
		{ apiKey: TOKEN }
	);
	assert.deepEqual(values(r), [12, 1, 1, 57]);
	assert.equal(r.metrics[1].warn, true);
	assert.equal(r.items.length, 2);
	assert.equal(r.items[0].title, "Monstera");
	assert.match(r.items[0].sub, /^watering · overdue since \d{4}-\d\d-\d\d$/);
	assert.equal(r.items[0].status, "warn");
	assert.match(r.items[1].sub, /^fertilizing · \d{4}-\d\d-\d\d$/);
	assert.equal(r.summary, "Due: Monstera (watering)");
});

test("Plant-it with a wrong key", async () => {
	await assert.rejects(run("plantit", (req, url, send) => send({ message: "Unauthorized" }, 401), { apiKey: "x" }), /Access denied/);
});

// ---------- Syncthing Relay ----------

test("Syncthing Relay: sessions, connections and data relayed", async () => {
	const r = await run("strelaysrv", (req, url, send) => {
		if (url.pathname === "/status")
			return send({ numActiveSessions: 4, numConnections: 11, numPendingSessionKeys: 0, numProxies: 8, bytesProxied: 5368709120, kbps10s1m5m15m30m60m: [100, 2500, 2000, 1500, 1000, 900], uptimeSeconds: 200000, goVersion: "go1.22" });
	});
	assert.deepEqual(values(r), [4, 11, "5.0 GB", "2.5 Mbit/s"]);
	assert.equal(r.summary, "Up 2 d 7 h");
});

test("Syncthing Relay on the wrong port", async () => {
	await assert.rejects(run("strelaysrv", (req, url, send) => send({ hello: "world" })), /status port/);
});

// ---------- Firefly III ----------

test("Firefly III: net worth and this month", async () => {
	const r = await run(
		"firefly",
		(req, url, send) => {
			if (req.headers.authorization !== `Bearer ${TOKEN}`) return send({ message: "Unauthenticated." }, 401);
			if (url.pathname === "/api/v1/summary/basic") {
				assert.match(url.searchParams.get("start"), /^\d{4}-\d\d-01$/);
				const entry = (key, v, parsed) => ({ key, title: key, monetary_value: v, currency_id: "1", currency_code: "CHF", currency_symbol: "CHF", currency_decimal_places: 2, value_parsed: parsed });
				return send({
					"balance-in-CHF": entry("balance-in-CHF", "1200.00", "CHF 1,200.00"),
					"spent-in-CHF": entry("spent-in-CHF", "-2345.60", "-CHF 2,345.60"),
					"earned-in-CHF": entry("earned-in-CHF", "6500.00", "CHF 6,500.00"),
					"bills-unpaid-in-CHF": { key: "bills-unpaid-in-CHF", monetary_value: "120", currency_symbol: "CHF" },
					"net-worth-in-CHF": entry("net-worth-in-CHF", "45210.00", "CHF 45,210.00"),
					"spent-in-EUR": { key: "spent-in-EUR", monetary_value: "-10", currency_symbol: "€", value_parsed: "-€10.00" }
				});
			}
		},
		{ token: TOKEN }
	);
	assert.deepEqual(values(r), ["CHF 45,210.00", "-CHF 2,345.60", "CHF 6,500.00", "CHF 120.00"]);
	assert.equal(r.summary, "Also in EUR");
});

// ---------- Wallos ----------

function wallos(req, url, send) {
	if (url.searchParams.get("api_key") !== TOKEN) return send({ success: false, title: "Invalid API key" });
	if (url.pathname === "/api/subscriptions/get_subscriptions.php")
		return send({
			success: true,
			title: "subscriptions",
			subscriptions: [
				{ id: 2, name: "Netflix", price: 18.9, next_payment: "2026-11-02", inactive: 0 },
				{ id: 1, name: "Proton", price: 9.99, next_payment: "2026-10-21", inactive: 0 },
				{ id: 3, name: "Old", price: 5, next_payment: "2026-10-19", inactive: 1 }
			],
			notes: []
		});
	if (url.pathname === "/api/subscriptions/get_monthly_cost.php") return send({ success: true, title: "October 2026", monthly_cost: "1234.5", localized_monthly_cost: "CHF 1,234.50", currency_code: "CHF", currency_symbol: "CHF", notes: [] });
}

test("Wallos: subscriptions, cost and next payment", async () => {
	const r = await run("wallos", wallos, { apiKey: TOKEN });
	assert.deepEqual(values(r), [2, "CHF 1,234.50", "Proton"]);
	assert.equal(r.metrics[1].value.de, "CHF 1'234.50");
	assert.deepEqual(r.metrics[2].label, { de: "nächste am 21.10.2026", en: "next on 2026-10-21" });
	assert.deepEqual(items(r), [
		["Proton", "2026-10-21 · 9.99", "ok"],
		["Netflix", "2026-11-02 · 18.90", "ok"]
	]);
});

test("Wallos with a wrong or missing key", async () => {
	await assert.rejects(run("wallos", wallos, { apiKey: "wrong" }), /Access denied/);
	await assert.rejects(run("wallos", wallos, {}), /API key missing/);
});
