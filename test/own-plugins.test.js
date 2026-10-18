"use strict";
// Own plugins in the data folder: loaded next to the built-in ones, with a tile and an action.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-plugins-"));
fs.writeFileSync(
	path.join(dir, "plugs.js"),
	`module.exports = {
		kind: "myplugs",
		label: "My plugs",
		tile: "mystrom",
		fields: [],
		async fetch({ url, json }) { return json(url + "/state"); },
		async action({ url, request, what, body }) {
			if (what !== "relay") throw new Error("Unknown action");
			const r = await request(url + "/relay", { method: "POST", body });
			if (r.status !== 200) throw new Error("HTTP " + r.status);
			return { ok: true };
		}
	};`
);
fs.writeFileSync(path.join(dir, "broken.js"), "module.exports = {");
process.env.PLUGINS_DIR = dir;

const { KINDS } = require("../lib/kinds");
const { Integrations } = require("../lib/integrations");

let server;
let base;
let switched = null;
test.before(async () => {
	server = http.createServer((req, res) => {
		if (req.url === "/state") return res.end(JSON.stringify({ devices: [{ mac: "AA", name: "Lamp", on: true, online: true, w: 7 }], watts: 7, todayWh: 40, price: null }));
		if (req.url === "/relay" && req.method === "POST") {
			let b = "";
			req.on("data", (c) => (b += c));
			req.on("end", () => ((switched = JSON.parse(b)), res.end("{}")));
			return;
		}
		res.writeHead(404).end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => (server.close(), fs.rmSync(dir, { recursive: true, force: true })));

test("own plugins: loaded from the data folder with their tile; a broken one doesn't stop the rest", () => {
	assert.equal(KINDS.myplugs.tile, "mystrom");
	assert.equal(KINDS.myplugs.plugin, true);
	assert.ok(KINDS.jellyfin, "built-in kinds stay");
});

test("own plugins: their data goes to the tile as it is, actions are called", async () => {
	const i = new Integrations({ secretsOf: () => ({}) });
	const s = { id: "p", kind: "myplugs", url: base };
	const { data } = await i.data(s);
	assert.equal(data.devices[0].name, "Lamp");
	assert.deepEqual(await i.action(s, "relay", { mac: "AA", on: false }), { ok: true });
	assert.deepEqual(switched, { mac: "AA", on: false });
	await assert.rejects(i.action(s, "fly", {}), /Unknown action/);
});
