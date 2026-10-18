"use strict";
// Every text exists in German and English, and no key is there twice.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "i18n.js"), "utf8");
const block = (lang, next) => src.slice(src.indexOf(`\t${lang}: {`), next ? src.indexOf(`\t${next}: {`) : undefined);
const keys = (b) => [...b.matchAll(/^\t\t"([^"]+)":/gm)].map((m) => m[1]);

test("i18n: the same texts in German and English, none twice", () => {
	const de = keys(block("de", "en"));
	const en = keys(block("en"));
	assert.ok(de.length > 300);
	assert.deepEqual(de.filter((k) => !en.includes(k)), [], "missing in English");
	assert.deepEqual(en.filter((k) => !de.includes(k)), [], "missing in German");
	assert.deepEqual(de.filter((k, i) => de.indexOf(k) !== i), [], "twice in German");
	assert.deepEqual(en.filter((k, i) => en.indexOf(k) !== i), [], "twice in English");
});
