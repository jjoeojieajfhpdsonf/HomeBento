"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { get, paths, format, fetchApi, preview } = require("../lib/apiwidget");

const doc = {
	data: { temp: 21.5, "key with.dot": "yes", 0: "zero" },
	items: [
		{ name: "sonarr", state: "running", size: 1500 },
		{ name: "radarr", state: "exited", size: 2500 }
	],
	matrix: [{ tags: ["a", "b"] }, { tags: ["c"] }],
	"top key": 1,
	length: 7
};

test("get() reads all path styles and never throws", () => {
	assert.equal(get(doc, "data.temp"), 21.5);
	assert.equal(get(doc, "$.data.temp"), 21.5);
	assert.equal(get(doc, "items[0].name"), "sonarr");
	assert.equal(get(doc, "items.1.name"), "radarr");
	assert.equal(get(doc, "items[-1].name"), "radarr");
	assert.equal(get(doc, "data['key with.dot']"), "yes");
	assert.equal(get(doc, '["top key"]'), 1);
	assert.equal(get(doc, "data.0"), "zero");
	assert.deepEqual(get(doc, "items[*].name"), ["sonarr", "radarr"]);
	assert.deepEqual(get(doc, "items.*.size"), [1500, 2500]);
	assert.deepEqual(get(doc, "matrix[*].tags[*]"), ["a", "b", "c"]);
	assert.equal(get(doc, "items.length"), 2);
	assert.equal(get(doc, "length"), 7);
	assert.equal(get(doc, "items[0].name.length"), 6);
	assert.equal(get(doc, ""), doc);
	assert.equal(get([1, 2, 3], "[1]"), 2);
	for (const p of ["data.nope", "items[5].name", "data.temp.x", "constructor", "__proto__", "items.map", "data['open", "items[", null, undefined]) {
		assert.equal(get(doc, p), undefined, String(p));
	}
	assert.equal(get(null, "a.b"), undefined);
	assert.equal(get("text", "a"), undefined);
});

test("paths() flattens nested JSON for the settings form", () => {
	const p = paths(doc);
	const by = Object.fromEntries(p.map((x) => [x.path, x]));
	assert.deepEqual(by["data.temp"], { path: "data.temp", sample: "21.5", type: "number" });
	assert.equal(by["data['key with.dot']"].type, "string");
	assert.equal(by["data['0']"].sample, "zero");
	assert.deepEqual(by.items, { path: "items", sample: "[2]", type: "array" });
	assert.deepEqual(by["items.length"], { path: "items.length", sample: "2", type: "number" });
	assert.equal(by["items[0].name"].sample, "sonarr");
	assert.equal(by["items[1].name"], undefined, "arrays are shown once");
	assert.equal(by["matrix[0].tags[0]"].type, "string");
	assert.equal(by["['top key']"].type, "number");
	assert.equal(by["['length']"].sample, "7");
	// every suggested path resolves with get()
	for (const x of p) assert.notEqual(get(doc, x.path), undefined, x.path);
	// long strings are shortened, depth is limited, max is respected
	assert.ok(paths({ s: "x".repeat(100) })[0].sample.length <= 40);
	const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
	assert.deepEqual(paths(deep), [{ path: "a.b.c.d.e.f", sample: "{1}", type: "object" }]);
	const many = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
	assert.equal(paths(many, { max: 10 }).length, 10);
	assert.deepEqual(paths([{ a: true }]).map((x) => x.path), ["", "length", "[0].a"]);
});

test("format() for each format", () => {
	const t = (v, f, o) => format(v, f, o).text;
	assert.equal(t(undefined, "number"), "–");
	assert.equal(t(null), "–");
	assert.equal(t("hello", "text"), "hello");
	assert.equal(t(["a", "b"], "text"), "a, b");
	assert.equal(t({ a: 1 }, "text"), '{"a":1}');
	assert.equal(t(1234567.891, "number"), "1'234'567.89");
	assert.equal(t(1234.5, "number", { decimals: 2 }), "1'234.50");
	assert.equal(t("42", "number", { decimals: 0 }), "42");
	assert.equal(t("n/a", "number"), "n/a");
	assert.equal(t(0.423, "percent", { scale: 1 }), "42%");
	assert.equal(t(42.34, "percent", { decimals: 1 }), "42.3%");
	assert.equal(t(512, "bytes"), "512 B");
	assert.equal(t(1500, "bytes"), "1.5 KB");
	assert.equal(t(2_500_000_000, "bytes"), "2.5 GB");
	assert.equal(t(3.2e12, "bytes", { decimals: 2 }), "3.20 TB");
	assert.equal(t(250_000_000, "bitrate"), "250.0 Mbit/s");
	assert.equal(t(800, "bitrate"), "800 bit/s");
	assert.equal(t(3 * 86400 + 4 * 3600 + 120, "duration"), "3 d 4 h");
	assert.equal(t(720, "duration"), "12 min");
	assert.equal(t(3600 + 300, "duration"), "1 h 5 min");
	assert.equal(t(45, "duration"), "45 s");
	const year = new Date().getFullYear();
	assert.equal(t(`${year}-10-18T12:32:00Z`, "date", { timeZone: "Europe/Zurich" }), "18.10. 14:32");
	assert.equal(t(Date.UTC(year, 0, 5, 8, 0) / 1000, "date", { timeZone: "Europe/Zurich" }), "05.01. 09:00");
	assert.equal(t(Date.UTC(year, 0, 5, 8, 0), "date", { timeZone: "Europe/Zurich" }), "05.01. 09:00");
	assert.equal(t("2020-03-01T10:00:00Z", "date", { timeZone: "UTC" }), "01.03.2020 10:00");
	assert.equal(t("2020-03-01T10:00:00Z", "date", { timeZone: "Not/AZone" }).includes("01.03.2020"), true);
	assert.equal(t(Date.now() - 5 * 60000, "relative"), "vor 5 min");
	assert.equal(t(Date.now() - 5 * 60000, "relative", { lang: "en" }), "5 min ago");
	assert.equal(t(new Date(Date.now() - 3 * 86400000).toISOString(), "relative", { lang: "en" }), "3 d ago");
	assert.equal(t(Date.now() + 2 * 3600000 + 1000, "relative"), "in 2 h");
	assert.equal(t(Date.now(), "relative"), "gerade eben");
	assert.equal(t(true, "boolean"), "Ja");
	assert.equal(t("false", "boolean", { lang: "en" }), "No");
	assert.equal(t(1, "boolean", { true: "An", false: "Aus" }), "An");
	assert.equal(t(true), "Ja");
	assert.equal(t(1234.5678), "1'234.57");
	assert.equal(t(21.5, "number", { prefix: "~", suffix: " °C" }), "~21.5 °C");
	assert.equal(t(undefined, "number", { suffix: " °C" }), "–");
});

test("format() threshold states", () => {
	const s = (v, f, o) => format(v, f, o).state;
	assert.equal(s(50, "number"), null);
	const o = { warnAbove: 70, badAbove: "90", warnBelow: "", badBelow: 5 };
	assert.equal(s(50, "number", o), "ok");
	assert.equal(s(75, "number", o), "warn");
	assert.equal(s(95, "number", o), "bad");
	assert.equal(s(2, "number", o), "bad");
	assert.equal(s("n/a", "number", o), null);
	assert.equal(s(undefined, "number", o), null);
	assert.equal(s(0.95, "percent", { scale: 1, badAbove: 90 }), "bad", "percent compares the value in %");
	assert.equal(s(0.5, "percent", { scale: 1, badAbove: 90 }), "ok");
	assert.equal(s(Date.now() - 2 * 86400000, "relative", { badAbove: 86400 }), "bad", "dates compare the age in seconds");
	assert.equal(s(Date.now() - 3600000, "date", { badAbove: 86400 }), "ok");
	assert.equal(s(false, "boolean", { badBelow: 1 }), "bad");
	assert.deepEqual(format(80, "number", { warnAbove: 70, suffix: " %" }), { text: "80 %", state: "warn" });
});

// ---------- against a local server ----------

function server(handler) {
	return new Promise((resolve) => {
		const srv = http.createServer((req, res) => {
			let body = "";
			req.on("data", (c) => (body += c));
			req.on("end", () => handler(req, res, body));
		});
		srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
	});
}

const send = (res, status, body, type = "application/json") => {
	res.writeHead(status, { "Content-Type": type });
	res.end(typeof body === "string" ? body : JSON.stringify(body));
};

test("fetchApi() and preview() against a local server", async (t) => {
	const seen = [];
	const { srv, base } = await server((req, res, body) => {
		seen.push({ url: req.url, method: req.method, headers: req.headers, body });
		if (req.url === "/status") {
			if (req.headers.authorization !== "Bearer s3cret-token") return send(res, 401, { error: "no" });
			return send(res, 200, {
				cpu: 0.874,
				uptime: 3 * 86400 + 4 * 3600,
				name: "nas",
				services: [
					{ name: "sonarr", state: "running", ver: "4.0" },
					{ name: "radarr", state: "exited", ver: "5.1" },
					{ name: "lidarr", state: "Healthy" },
					{ name: "prowlarr" }
				],
				disks: { sda: { ok: true }, sdb: { ok: false } }
			});
		}
		if (req.url === "/post") return send(res, 200, { echo: JSON.parse(body), type: req.headers["content-type"] });
		if (req.url === "/fail") return send(res, 500, { error: "boom" });
		if (req.url === "/html") return send(res, 200, "<html>hi</html>", "text/html");
		if (req.url === "/text") return send(res, 200, "  42 users\n", "text/plain");
		if (req.url === "/big") return send(res, 200, { list: Array.from({ length: 3000 }, (_, i) => ({ i, text: "x".repeat(50) })) });
		if (req.url === "/huge") return send(res, 200, "[" + Array(700_000).fill("123").join(",") + "]");
		if (req.url === "/count") return send(res, 200, { n: seen.filter((s) => s.url === "/count").length });
		send(res, 404, {});
	});
	t.after(() => srv.close());
	const secrets = { Authorization: "Bearer s3cret-token", "X-Empty": "" };

	await t.test("headers from secrets, fields, formats and list status mapping", async () => {
		const r = await fetchApi(
			{
				key: "t1",
				url: `${base}/status`,
				headers: [{ name: "Authorization" }, { name: "X-Empty" }, { name: "X-Missing" }],
				fields: [
					{ label: "CPU", path: "cpu", format: "percent", scale: 1, warnAbove: 70, badAbove: 90 },
					{ label: "Uptime", path: "uptime", format: "duration" },
					{ label: "Name", path: "name", prefix: "Host " },
					{ label: "Missing", path: "nope.deep", format: "number" },
					{ label: "Count", path: "services.length" }
				],
				list: { path: "services", title: "name", sub: "ver", status: "state", okValues: "running, healthy", max: 3 }
			},
			secrets
		);
		assert.equal(r.error, undefined);
		assert.deepEqual(r.values, [
			{ label: "CPU", text: "87%", state: "warn" },
			{ label: "Uptime", text: "3 d 4 h", state: null },
			{ label: "Name", text: "Host nas", state: null },
			{ label: "Missing", text: "–", state: null },
			{ label: "Count", text: "4", state: null }
		]);
		assert.deepEqual(r.items, [
			{ title: "sonarr", sub: "4.0", status: "ok", statusText: "running" },
			{ title: "radarr", sub: "5.1", status: "bad", statusText: "exited" },
			{ title: "lidarr", sub: "–", status: "ok", statusText: "Healthy" }
		]);
		assert.equal(typeof r.at, "number");
		const h = seen.at(-1).headers;
		assert.equal(h.authorization, "Bearer s3cret-token");
		assert.equal(h["x-empty"], undefined);
		assert.equal(h["x-missing"], undefined);
	});

	await t.test("list over an object with $key and default ok values", async () => {
		const r = await fetchApi({ url: `${base}/status`, headers: [{ name: "Authorization" }], fields: [], list: { path: "disks", title: "$key", status: "ok" } }, secrets);
		assert.deepEqual(r.items.map((i) => [i.title, i.status]), [["sda", "ok"], ["sdb", "bad"]]);
	});

	await t.test("POST sends the body as JSON", async () => {
		const r = await fetchApi({ url: `${base}/post`, method: "POST", body: '{"q":"hi"}', fields: [{ label: "Q", path: "echo.q" }, { label: "Type", path: "type" }] }, {});
		assert.deepEqual(r.values.map((v) => v.text), ["hi", "application/json"]);
		assert.equal(seen.at(-1).method, "POST");
	});

	await t.test("errors: HTTP status, not JSON, access denied, bad config – no secrets in messages", async () => {
		assert.deepEqual(await fetchApi({ url: `${base}/fail`, fields: [{ path: "x" }] }, {}), { error: "HTTP 500" });
		assert.match((await fetchApi({ url: `${base}/html`, fields: [{ path: "x" }] }, {})).error, /^Not JSON \(got text\/html\)/);
		const denied = await fetchApi({ url: `${base}/status`, headers: [{ name: "Authorization" }], fields: [{ path: "x" }] }, { Authorization: "Bearer wrong-secret" });
		assert.match(denied.error, /^HTTP 401/);
		assert.ok(!denied.error.includes("wrong-secret"));
		assert.match((await fetchApi({ url: "file:///etc/passwd", fields: [] }, {})).error, /http and https/);
		assert.match((await fetchApi({ url: "not a url", fields: [] }, {})).error, /Invalid address/);
		assert.match((await fetchApi({ url: base, method: "DELETE", fields: [] }, {})).error, /GET or POST/);
		assert.match((await fetchApi({ url: base, headers: [{ name: "Bad Name:" }], fields: [] }, {})).error, /Invalid header name/);
		const crlf = await fetchApi({ url: base, headers: [{ name: "X-Key" }], fields: [] }, { "X-Key": "abc\r\nInjected: 1" });
		assert.match(crlf.error, /invalid value/);
		assert.ok(!crlf.error.includes("abc"));
		assert.match((await fetchApi({ url: `${base}/huge`, fields: [{ path: "x" }] }, {})).error, /too large/i);
		assert.match((await fetchApi({ url: "http://127.0.0.1:1/", fields: [] }, {})).error, /refused/i);
	});

	await t.test("plain text answers with an empty field path", async () => {
		const r = await fetchApi({ url: `${base}/text`, fields: [{ label: "Users", path: "" }] }, {});
		assert.deepEqual(r.values, [{ label: "Users", text: "42 users", state: null }]);
	});

	await t.test("results are cached per tile for the ttl", async () => {
		const cfg = { key: "c", url: `${base}/count`, ttl: 60, fields: [{ label: "n", path: "n" }] };
		const a = await fetchApi(cfg, {});
		const b = await fetchApi(cfg, {});
		assert.equal(a.values[0].text, "1");
		assert.equal(b, a);
		const c = await fetchApi({ ...cfg, fields: [{ label: "N", path: "n" }] }, {});
		assert.equal(c.values[0].text, "2", "a changed config is fetched again");
	});

	await t.test("preview() returns json, paths and status; truncates big answers", async () => {
		const p = await preview({ url: `${base}/status`, headers: [{ name: "Authorization" }] }, secrets);
		assert.equal(p.status, 200);
		assert.equal(typeof p.ms, "number");
		assert.equal(p.json.name, "nas");
		assert.equal(p.truncated, false);
		assert.ok(p.paths.some((x) => x.path === "services[0].state" && x.sample === "running"));
		assert.ok(p.paths.some((x) => x.path === "services" && x.type === "array"));
		const big = await preview({ url: `${base}/big` }, {});
		assert.equal(big.truncated, true);
		assert.ok(JSON.stringify(big.json).length <= 50_000);
		assert.ok(big.paths.some((x) => x.path === "list.length" && x.sample === "3000"));
		assert.deepEqual(await preview({ url: `${base}/fail` }, {}), { error: "HTTP 500" });
		const txt = await preview({ url: `${base}/text` }, {});
		assert.match(txt.error, /Not JSON/);
		assert.equal(txt.text, "  42 users\n");
	});
});
