"use strict";
// A small YAML reader for the configuration files of other dashboards (Homepage, Dashy, Homer).
// It covers what those files use: block mappings and sequences by indentation, "- key: value"
// items, plain / quoted scalars, flow lists and maps, comments, block scalars (| and >) and the
// first document of a multi-document file. Anchors and tags are dropped, aliases stay as text.
// parse(text) → value; anything it cannot read throws Error("YAML line N: …").

function fail(line, msg) {
	return new Error(`YAML line ${line}: ${msg}`);
}

// Removes a trailing comment ("# …" at the start or after whitespace, not inside quotes).
function stripComment(s) {
	let q = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			if (q === '"' && c === "\\") i++;
			else if (c === q) {
				if (q === "'" && s[i + 1] === "'") i++;
				else q = null;
			}
			continue;
		}
		if ((c === '"' || c === "'") && (i === 0 || /[\s,[{]/.test(s[i - 1]))) q = c;
		else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
	}
	return s;
}

const ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: " ", P: " " };

// Reads a quoted scalar that starts at s[i]; returns { value, end } (end = index after the closing
// quote) or null when the quote is not closed on this text.
function readQuoted(s, i, line) {
	const q = s[i];
	let out = "";
	for (let j = i + 1; j < s.length; j++) {
		const c = s[j];
		if (q === "'") {
			if (c === "'") {
				if (s[j + 1] === "'") {
					out += "'";
					j++;
					continue;
				}
				return { value: out, end: j + 1 };
			}
			out += c;
			continue;
		}
		if (c === '"') return { value: out, end: j + 1 };
		if (c !== "\\") {
			out += c;
			continue;
		}
		const e = s[++j];
		if (e === undefined) return null;
		const hex = { x: 2, u: 4, U: 8 }[e];
		if (hex) {
			const h = s.slice(j + 1, j + 1 + hex);
			if (!new RegExp(`^[0-9a-fA-F]{${hex}}$`).test(h)) throw fail(line, `invalid escape \\${e}${h}`);
			out += String.fromCodePoint(parseInt(h, 16));
			j += hex;
		} else if (e in ESCAPES) out += ESCAPES[e];
		else throw fail(line, `invalid escape \\${e}`);
	}
	return null;
}

// Plain scalar → null, boolean, number or string (YAML 1.2 core schema).
function resolvePlain(t) {
	if (/^(?:~|null|Null|NULL)$/.test(t)) return null;
	if (/^(?:true|True|TRUE)$/.test(t)) return true;
	if (/^(?:false|False|FALSE)$/.test(t)) return false;
	if (/^[-+]?(?:0|[1-9][0-9]*)$/.test(t)) {
		const n = Number(t);
		return Number.isSafeInteger(n) ? n : t;
	}
	if (/^0x[0-9a-fA-F]+$/.test(t)) return parseInt(t.slice(2), 16);
	if (/^0o[0-7]+$/.test(t)) return parseInt(t.slice(2), 8);
	if (/^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][-+]?[0-9]+)?$/.test(t) || /^[-+]?[0-9]+[eE][-+]?[0-9]+$/.test(t)) return Number(t);
	if (/^[-+]?\.(?:inf|Inf|INF)$/.test(t)) return t[0] === "-" ? -Infinity : Infinity;
	if (/^\.(?:nan|NaN|NAN)$/.test(t)) return NaN;
	return t;
}

// Flow collections: [a, b], {a: 1, b: [c]}.
function parseFlow(s, line) {
	let i = 0;
	const ws = () => {
		while (i < s.length && /\s/.test(s[i])) i++;
	};
	function scalar(isKey) {
		if (s[i] === '"' || s[i] === "'") {
			const r = readQuoted(s, i, line);
			if (!r) throw fail(line, "unclosed quote");
			i = r.end;
			return r.value;
		}
		const start = i;
		while (i < s.length && !",[]{}".includes(s[i])) {
			if (isKey && s[i] === ":" && (i + 1 >= s.length || /[\s,\]}]/.test(s[i + 1]))) break;
			i++;
		}
		const raw = s.slice(start, i).trim();
		if (isKey) return raw;
		return raw === "" ? null : raw[0] === "*" ? raw : resolvePlain(stripProps(raw).text);
	}
	function value() {
		ws();
		if (s[i] === "[") {
			i++;
			const arr = [];
			for (;;) {
				ws();
				if (s[i] === "]") {
					i++;
					return arr;
				}
				arr.push(value());
				ws();
				if (s[i] === ",") i++;
				else if (s[i] !== "]") throw fail(line, 'expected "," or "]" in a flow list');
			}
		}
		if (s[i] === "{") {
			i++;
			const obj = {};
			for (;;) {
				ws();
				if (s[i] === "}") {
					i++;
					return obj;
				}
				const key = String(scalar(true));
				ws();
				let v = null;
				if (s[i] === ":") {
					i++;
					v = value();
				}
				obj[key] = v;
				ws();
				if (s[i] === ",") i++;
				else if (s[i] !== "}") throw fail(line, 'expected "," or "}" in a flow map');
			}
		}
		if (i >= s.length) throw fail(line, "unclosed flow collection");
		return scalar(false);
	}
	const v = value();
	ws();
	if (i < s.length) throw fail(line, `unexpected "${s.slice(i, i + 10)}" after a flow collection`);
	return v;
}

// true while brackets of a flow collection are still open
function flowOpen(s) {
	let depth = 0;
	let q = null;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) {
			if (q === '"' && c === "\\") i++;
			else if (c === q) q = null;
		} else if (c === '"' || c === "'") q = c;
		else if (c === "[" || c === "{") depth++;
		else if (c === "]" || c === "}") depth--;
	}
	return depth > 0;
}

// Drops leading anchors (&name) and tags (!tag, !!str); reports whether the value was tagged as string.
function stripProps(t) {
	let str = false;
	for (;;) {
		const m = /^([&!]\S*)(?:\s+|$)/.exec(t);
		if (!m) return { text: t, str };
		if (m[1] === "!!str") str = true;
		t = t.slice(m[0].length);
	}
}

const isItem = (t) => t === "-" || t.startsWith("- ") || t.startsWith("-\t");

// Index of the ":" that separates key and value on a block line, or -1.
function findSep(t) {
	let i = 0;
	if (t[0] === "[" || t[0] === "{") return -1;
	if (t[0] === '"' || t[0] === "'") {
		let r;
		try {
			r = readQuoted(t, 0, 0);
		} catch {
			return -1;
		}
		if (!r) return -1;
		i = r.end;
		while (t[i] === " " || t[i] === "\t") i++;
		return t[i] === ":" && (i + 1 === t.length || /\s/.test(t[i + 1])) ? i : -1;
	}
	for (; i < t.length; i++) if (t[i] === ":" && (i + 1 === t.length || /\s/.test(t[i + 1]))) return i;
	return -1;
}

class Parser {
	constructor(text) {
		const raw = String(text).replace(/^﻿/, "").split(/\r\n|\r|\n/);
		let lines = raw.map((r, i) => {
			const indent = /^ */.exec(r)[0].length;
			return { no: i + 1, raw: r, indent, text: stripComment(r.slice(indent)).trim() };
		});
		// first document only: skip directives and a leading "---", stop at the next "---" or "..."
		let start = 0;
		while (start < lines.length && (lines[start].text === "" || (lines[start].indent === 0 && lines[start].text.startsWith("%")))) start++;
		if (start < lines.length && lines[start].indent === 0 && /^---(?:\s|$)/.test(lines[start].raw)) {
			const rest = lines[start].text.slice(3).trim();
			if (rest) lines[start] = { ...lines[start], text: rest };
			else start++;
		}
		let end = start + 1;
		while (end < lines.length && !/^(?:---|\.\.\.)(?:\s|$)/.test(lines[end].raw)) end++;
		this.lines = lines.slice(start, end);
		this.pos = 0;
	}

	// next line with content (blank and comment lines are skipped)
	peek() {
		while (this.pos < this.lines.length && this.lines[this.pos].text === "") this.pos++;
		const l = this.lines[this.pos];
		if (l && l.raw[l.indent] === "\t") throw fail(l.no, "tabs are not allowed for indentation");
		return l || null;
	}

	document() {
		const l = this.peek();
		if (!l) return null;
		const v = this.node(l.indent - 1);
		const rest = this.peek();
		if (rest) throw fail(rest.no, "bad indentation");
		return v;
	}

	// A block node whose first line is the next line (deeper than parent).
	node(parent) {
		const l = this.peek();
		if (!l || l.indent <= parent) return null;
		if (l.text.startsWith("? ")) throw fail(l.no, "complex keys are not supported");
		if (isItem(l.text)) return this.seq(l.indent);
		if (findSep(l.text) >= 0) return this.map(l.indent);
		this.pos++;
		return this.inline(l.text, l, parent);
	}

	seq(indent) {
		const out = [];
		for (;;) {
			const l = this.peek();
			if (!l || l.indent < indent) break;
			if (l.indent > indent) throw fail(l.no, "bad indentation");
			if (!isItem(l.text)) break;
			const after = l.text.slice(1);
			const body = after.trim();
			if (!body) {
				this.pos++;
				out.push(this.node(indent));
				continue;
			}
			const col = indent + 1 + (after.length - after.trimStart().length);
			const props = stripProps(body);
			if (props.text && (isItem(props.text) || findSep(props.text) >= 0)) {
				// "- key: value" / "- - x": the rest of the line starts a nested node at its own column
				this.lines[this.pos] = { ...l, indent: col, text: props.text };
				out.push(this.node(indent));
			} else {
				this.pos++;
				out.push(this.value(body, l, indent));
			}
		}
		return out;
	}

	map(indent) {
		const out = {};
		for (;;) {
			const l = this.peek();
			if (!l || l.indent < indent) break;
			if (l.indent > indent) throw fail(l.no, "bad indentation");
			if (isItem(l.text)) throw fail(l.no, 'a list item is not allowed here (expected "key: value")');
			const sep = findSep(l.text);
			if (sep < 0) throw fail(l.no, `expected "key: value", found "${l.text.slice(0, 40)}"`);
			let key = l.text.slice(0, sep).trim();
			if (key[0] === '"' || key[0] === "'") key = readQuoted(key, 0, l.no).value;
			this.pos++;
			out[key] = this.value(l.text.slice(sep + 1).trim(), l, indent);
		}
		return out;
	}

	// The value after "key:" or "- " (may be empty: then the value is the following block).
	value(text, l, indent) {
		const props = stripProps(text);
		if (props.text === "") {
			const n = this.peek();
			if (n && n.indent > indent) return this.node(indent);
			if (n && n.indent === indent && isItem(n.text)) return this.seq(indent);
			return props.str ? "" : null;
		}
		const v = this.inline(props.text, l, indent);
		return props.str && v !== null && typeof v !== "object" ? String(v) : v;
	}

	// A scalar or flow value that starts on line l; may continue on following lines.
	inline(text, l, parent) {
		const c = text[0];
		if (c === "|" || c === ">") return this.block(text, l, parent);
		if (c === "*") return text;
		if (c === "[" || c === "{") {
			let s = text;
			while (flowOpen(s)) {
				const n = this.lines[this.pos];
				if (!n) throw fail(l.no, "unclosed flow collection");
				s += " " + n.text;
				this.pos++;
			}
			return parseFlow(s, l.no);
		}
		if (c === '"' || c === "'") {
			let s = text;
			let r = readQuoted(s, 0, l.no);
			// a quoted string may go on over several lines (line breaks become spaces)
			while (!r) {
				const n = this.lines[this.pos];
				if (!n) throw fail(l.no, "unclosed quote");
				s = s.replace(/[ \t]+$/, "") + " " + n.raw.trim();
				this.pos++;
				r = readQuoted(s, 0, l.no);
			}
			if (stripComment(s.slice(r.end)).trim()) throw fail(l.no, "unexpected text after a quoted string");
			return r.value;
		}
		// plain scalar, possibly continued on more indented lines
		let s = text;
		for (;;) {
			const n = this.peek();
			if (!n || n.indent <= parent) break;
			if (isItem(n.text) || findSep(n.text) >= 0) throw fail(n.no, "bad indentation");
			s += " " + n.text;
			this.pos++;
		}
		return resolvePlain(s);
	}

	// Block scalars: | keeps line breaks, > folds them; "-" strips and "+" keeps the final ones.
	block(header, l, parent) {
		const m = /^([|>])(?:([+-])([1-9])?|([1-9])([+-])?)?$/.exec(header);
		if (!m) throw fail(l.no, `invalid block scalar header "${header}"`);
		const folded = m[1] === ">";
		const chomp = m[2] || m[5] || "";
		const digit = m[3] || m[4];
		let indent = digit ? Math.max(parent, 0) + Number(digit) : 0;
		const lines = [];
		while (this.pos < this.lines.length) {
			const raw = this.lines[this.pos].raw;
			if (raw.trim() === "") {
				lines.push("");
				this.pos++;
				continue;
			}
			const ind = /^ */.exec(raw)[0].length;
			if (!indent) {
				if (ind <= parent) break;
				indent = ind;
			}
			if (ind < indent) break;
			lines.push(raw.slice(indent));
			this.pos++;
		}
		let trailing = 0;
		while (lines.length && lines[lines.length - 1] === "") {
			lines.pop();
			trailing++;
		}
		let out;
		if (!folded) out = lines.join("\n");
		else {
			out = "";
			let breaks = 0;
			let prevNormal = false;
			let first = true;
			for (const line of lines) {
				if (line === "") {
					breaks++;
					continue;
				}
				const normal = !/^[ \t]/.test(line);
				if (first) out += "\n".repeat(breaks);
				else if (breaks === 0) out += prevNormal && normal ? " " : "\n";
				else out += "\n".repeat(prevNormal && normal ? breaks : breaks + 1);
				out += line;
				prevNormal = normal;
				breaks = 0;
				first = false;
			}
		}
		if (chomp === "-") return out;
		if (chomp === "+") return lines.length ? out + "\n".repeat(trailing + 1) : "\n".repeat(trailing);
		return lines.length ? out + "\n" : "";
	}
}

function parse(text) {
	return new Parser(text).document();
}

module.exports = { parse };
