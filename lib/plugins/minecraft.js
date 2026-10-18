"use strict";
// Minecraft (Java Edition) server: players online, version and MOTD via the Server List Ping
// (the status the game shows in its server list), spoken over TCP: a handshake packet with
// "next state = status", a status request, and the JSON answer. Host and port come from the
// service address (e.g. http://192.168.1.10:25565). No login. Bedrock servers speak another
// protocol (UDP) and are not supported.
const net = require("node:net");
const L = (de, en) => ({ de, en });

const DEFAULT_PORT = 25565;
const MAX_PACKET = 1_000_000;

function writeVarInt(n) {
	const out = [];
	n >>>= 0;
	do {
		let b = n & 0x7f;
		n >>>= 7;
		if (n) b |= 0x80;
		out.push(b);
	} while (n);
	return Buffer.from(out);
}

// { value, size } or null when the buffer ends before the number does
function readVarInt(buf, offset = 0) {
	let value = 0;
	for (let i = 0; i < 5; i++) {
		if (offset + i >= buf.length) return null;
		const b = buf[offset + i];
		value |= (b & 0x7f) << (7 * i);
		if (!(b & 0x80)) return { value, size: i + 1 };
	}
	throw new Error("Invalid answer (number too long)");
}

const str = (s) => {
	const b = Buffer.from(s, "utf8");
	return Buffer.concat([writeVarInt(b.length), b]);
};
const packet = (id, ...parts) => {
	const data = Buffer.concat([writeVarInt(id), ...parts]);
	return Buffer.concat([writeVarInt(data.length), data]);
};

function friendly(err) {
	const code = err.code || "";
	if (code === "ECONNREFUSED") return "Connection refused";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Address not found";
	if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "Host unreachable";
	if (code === "ECONNRESET") return "Connection reset";
	return err.message || String(err);
}

// Resolves { status (parsed JSON), ms }.
function ping(host, port, timeout = 8000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		let buf = Buffer.alloc(0);
		let done = false;
		const finish = (err, value) => {
			if (done) return;
			done = true;
			socket.destroy();
			if (err) reject(err);
			else resolve(value);
		};
		const socket = net.connect({ host, port });
		socket.setTimeout(timeout, () => finish(new Error("Timeout")));
		socket.on("error", (err) => finish(new Error(friendly(err))));
		socket.on("close", () => finish(new Error("The server closed the connection without an answer")));
		socket.on("connect", () => {
			const portBuf = Buffer.alloc(2);
			portBuf.writeUInt16BE(port);
			// protocol version -1: "any", the server answers with its own version
			socket.write(Buffer.concat([packet(0x00, writeVarInt(-1), str(host), portBuf, writeVarInt(1)), packet(0x00)]));
		});
		socket.on("data", (chunk) => {
			buf = Buffer.concat([buf, chunk]);
			try {
				const len = readVarInt(buf);
				if (!len) return;
				if (len.value > MAX_PACKET) throw new Error("Answer too large");
				if (buf.length < len.size + len.value) return;
				const body = buf.subarray(len.size, len.size + len.value);
				const id = readVarInt(body);
				if (!id || id.value !== 0x00) throw new Error("Unexpected answer (not a Minecraft server?)");
				const sl = readVarInt(body, id.size);
				if (!sl) throw new Error("Unexpected answer (not a Minecraft server?)");
				const text = body.subarray(id.size + sl.size, id.size + sl.size + sl.value).toString("utf8");
				finish(null, { status: JSON.parse(text), ms: Date.now() - started });
			} catch (err) {
				finish(err instanceof SyntaxError ? new Error("Unexpected answer (no JSON status)") : err);
			}
		});
	});
}

// MOTD: plain text or a chat component ({ text, extra: [...] }); § colour codes removed.
function plain(c) {
	if (c == null) return "";
	if (typeof c === "string") return c;
	if (Array.isArray(c)) return c.map(plain).join("");
	return `${c.text || c.translate || ""}${Array.isArray(c.extra) ? c.extra.map(plain).join("") : ""}`;
}
const motdOf = (d) => plain(d).replace(/§./g, "").replace(/\s+/g, " ").trim();

module.exports = {
	kind: "minecraft",
	label: "Minecraft",
	// Java servers only: not Bedrock servers or helper containers (backup, router)
	match: /minecraft(?![-_.]?(bedrock|backup|router|rcon))/,
	ttl: 30000,
	fields: [],
	ping,
	async fetch({ url }) {
		let u;
		try {
			u = new URL(url);
		} catch {
			throw new Error("Invalid address");
		}
		const host = u.hostname.replace(/^\[|\]$/g, "");
		const port = Number(u.port) || DEFAULT_PORT;
		const { status, ms } = await ping(host, port);
		if (!status || typeof status !== "object") throw new Error("Unexpected answer from the Minecraft server");
		const players = status.players || {};
		const sample = Array.isArray(players.sample) ? players.sample.map((p) => p && p.name).filter((n) => n && !/§/.test(n)) : [];
		const motd = motdOf(status.description);
		return {
			metrics: [
				{ value: `${Number(players.online) || 0}/${Number(players.max) || 0}`, label: L("Spieler", "Players") },
				{ value: (status.version && status.version.name) || "?", label: "Version" },
				{ value: `${ms} ms`, label: "Ping" }
			],
			items: sample.map((name) => ({ title: name, sub: "", status: "ok" })),
			summary: motd || null
		};
	}
};
