"use strict";
// Calendars by link: public iCal, and private ones (Nextcloud CalDAV) with a login.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { calendars } = require("../lib/widgets");

const day = (n) => {
	const d = new Date(Date.now() + n * 86400000);
	return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};
const ICS = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:${day(1)}T090000Z\r\nDTEND:${day(1)}T100000Z\r\nSUMMARY:Zahnarzt\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

let server;
let base;
const seen = [];
test.before(async () => {
	server = http.createServer((req, res) => {
		seen.push({ url: req.url, auth: req.headers.authorization || null });
		if (req.url.startsWith("/public.ics")) return res.end(ICS);
		// like Nextcloud: the calendar collection with ?export, basic auth with an app password
		if (req.url === "/remote.php/dav/calendars/joel/personal/?export") {
			if (req.headers.authorization !== `Basic ${Buffer.from("joel:app-pass").toString("base64")}`) return res.writeHead(401).end();
			return res.end(ICS);
		}
		res.writeHead(404).end();
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test("calendars: a public iCal link needs no login", async () => {
	const r = await calendars([{ name: "Familie", url: `${base}/public.ics` }]);
	assert.deepEqual(r.errors, []);
	assert.equal(r.events[0].title, "Zahnarzt");
	assert.equal(seen.at(-1).auth, null);
});

test("calendars: a Nextcloud calendar gets ?export and the login as basic auth", async () => {
	const r = await calendars([{ name: "Privat", url: `${base}/remote.php/dav/calendars/joel/personal`, user: "joel", password: "app-pass" }]);
	assert.deepEqual(r.errors, []);
	assert.equal(r.events[0].title, "Zahnarzt");
	assert.equal(seen.at(-1).url, "/remote.php/dav/calendars/joel/personal/?export");
});

test("calendars: a missing or wrong login says so", async () => {
	const none = await calendars([{ name: "Ohne", url: `${base}/remote.php/dav/calendars/joel/personal/` }]);
	assert.match(none.errors[0], /needs a login/);
	const wrong = await calendars([{ name: "Falsch", url: `${base}/remote.php/dav/calendars/joel/personal/`, user: "joel", password: "nope" }]);
	assert.match(wrong.errors[0], /Login refused/);
});
