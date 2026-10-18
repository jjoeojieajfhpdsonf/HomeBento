"use strict";
// Configuration (services, boards, tiles) in data/config.json, logins in data/secrets.json.
// Secrets never leave the server: the web app only learns whether one is set.
const path = require("node:path");
const { readJSON, writeJSON, id } = require("./util");
const { UserError } = require("./errors");
const { KINDS } = require("./kinds");

const TILE_TYPES = ["service", "status", "host", "uptime", "jellyfin", "recent", "calendar", "downloads", "solar", "links", "notes"];
const SIZES = [[1, 1], [2, 1], [1, 2], [2, 2], [2, 3], [3, 1], [3, 2], [3, 3]];

function defaults() {
	return {
		version: 1,
		title: "",
		services: [],
		boards: [
			{
				id: id(),
				name: "",
				tiles: [
					{ id: id(), type: "status", w: 2, h: 1 },
					{ id: id(), type: "host", w: 2, h: 2 },
					{ id: id(), type: "uptime", w: 2, h: 2 }
				]
			}
		]
	};
}

class Store {
	constructor(dir) {
		this.file = path.join(dir, "config.json");
		this.secretsFile = path.join(dir, "secrets.json");
		this.config = readJSON(this.file, null) || defaults();
		this.secrets = readJSON(this.secretsFile, {});
		if (!this.config.boards.length) this.config.boards = defaults().boards;
	}

	save() {
		writeJSON(this.file, this.config);
	}

	service(sid) {
		const s = this.config.services.find((x) => x.id === sid);
		if (!s) throw new UserError("Service not found");
		return s;
	}

	board(bid) {
		const b = this.config.boards.find((x) => x.id === bid);
		if (!b) throw new UserError("Board not found");
		return b;
	}

	// Config for the web app: secrets replaced by "is set" flags.
	public() {
		return {
			...this.config,
			services: this.config.services.map((s) => ({ ...s, secrets: Object.fromEntries(Object.keys(this.secrets[s.id] || {}).map((k) => [k, true])) }))
		};
	}

	// ---------- services ----------

	saveService(input, sid) {
		const s = sid ? this.service(sid) : { id: id() };
		const name = String(input.name ?? s.name ?? "").trim();
		if (!name) throw new UserError("Please enter a name");
		const url = String(input.url ?? s.url ?? "").trim();
		if (url && !/^https?:\/\/[^/\s]+/i.test(url)) throw new UserError("The address must start with http:// or https://");
		s.name = name.slice(0, 60);
		s.url = url;
		s.icon = String(input.icon ?? s.icon ?? "").trim().slice(0, 200);
		s.kind = input.kind !== undefined ? (KINDS[input.kind] ? input.kind : null) : s.kind || null;
		s.container = input.container !== undefined ? String(input.container || "").trim() || null : s.container || null;
		s.check = input.check !== undefined ? input.check !== false : s.check !== false;
		s.insecure = input.insecure !== undefined ? !!input.insecure : !!s.insecure;
		if (!sid) this.config.services.push(s);
		// logins: empty string removes, undefined keeps
		if (input.secrets && typeof input.secrets === "object") {
			const cur = { ...(this.secrets[s.id] || {}) };
			for (const [k, v] of Object.entries(input.secrets)) {
				if (v === undefined || v === null) continue;
				if (v === "") delete cur[k];
				else cur[k] = String(v);
			}
			if (Object.keys(cur).length) this.secrets[s.id] = cur;
			else delete this.secrets[s.id];
			writeJSON(this.secretsFile, this.secrets, 0o600);
		}
		this.save();
		return s;
	}

	removeService(sid) {
		this.service(sid);
		this.config.services = this.config.services.filter((s) => s.id !== sid);
		for (const b of this.config.boards) b.tiles = b.tiles.filter((t) => t.service !== sid);
		delete this.secrets[sid];
		writeJSON(this.secretsFile, this.secrets, 0o600);
		this.save();
	}

	secretsOf(sid) {
		return this.secrets[sid] || {};
	}

	setSecret(sid, key, value) {
		this.secrets[sid] = { ...(this.secrets[sid] || {}), [key]: String(value) };
		writeJSON(this.secretsFile, this.secrets, 0o600);
	}

	// ---------- boards and tiles ----------

	addBoard(name) {
		const b = { id: id(), name: String(name || "").trim().slice(0, 40), tiles: [] };
		this.config.boards.push(b);
		this.save();
		return b;
	}

	renameBoard(bid, name) {
		this.board(bid).name = String(name || "").trim().slice(0, 40);
		this.save();
	}

	removeBoard(bid) {
		this.board(bid);
		if (this.config.boards.length === 1) throw new UserError("The last board can't be removed");
		this.config.boards = this.config.boards.filter((b) => b.id !== bid);
		this.save();
	}

	// Replaces the tiles of a board (order, sizes, added and removed tiles) after checking them.
	setTiles(bid, tiles) {
		const b = this.board(bid);
		if (!Array.isArray(tiles)) throw new UserError("Invalid layout");
		const known = new Set(this.config.services.map((s) => s.id));
		b.tiles = tiles
			.filter((t) => t && TILE_TYPES.includes(t.type))
			.map((t) => {
				const [w, h] = SIZES.find(([w, h]) => w === t.w && h === t.h) || [1, 1];
				const tile = { id: typeof t.id === "string" && /^[a-f0-9]{10}$/.test(t.id) ? t.id : id(), type: t.type, w, h };
				if (t.service && known.has(t.service)) tile.service = t.service;
				if (t.type === "links" && Array.isArray(t.links)) tile.links = t.links.slice(0, 20).map((l) => ({ name: String(l.name || "").slice(0, 40), url: String(l.url || "").slice(0, 300) })).filter((l) => /^https?:\/\//.test(l.url));
				// notes are Markdown text (an older list of entries becomes a checklist)
				if (t.type === "notes" && Array.isArray(t.archive)) tile.archive = t.archive.slice(-500).map((a) => ({ text: String((a && a.text) || "").slice(0, 1000), at: Number(a && a.at) || Date.now() })).filter((a) => a.text.trim());
				if (t.type === "notes") tile.text = typeof t.text === "string" ? t.text.slice(0, 20000) : (Array.isArray(t.notes) ? t.notes : []).map((n) => `- [${n.done ? "x" : " "}] ${String(n.text || "")}`).join("\n");
				if (t.title) tile.title = String(t.title).slice(0, 40);
				return tile;
			})
			.filter((t) => t.type !== "service" || t.service);
		this.save();
		return b;
	}

	setTitle(title) {
		this.config.title = String(title || "").trim().slice(0, 40);
		this.save();
	}

	// "tiles": everything as tiles · "combined": problems on top, content tiles, services as a list
	setLayout(layout) {
		this.config.layout = layout === "combined" ? "combined" : "tiles";
		this.save();
	}
}

module.exports = { Store, TILE_TYPES, SIZES };
