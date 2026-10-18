"use strict";
// Checks every service regularly over HTTP (and its container, if linked) and keeps
// - the current state (up / slow / down) with the last 60 response times,
// - hourly buckets for 30 days (uptime, heat map, response time),
// - a list of status changes (events).
const path = require("node:path");
const { request, readJSON, writeJSON, sleep } = require("./util");

const HOUR = 3600 * 1000;
const KEEP_HOURS = 30 * 24;
const SLOW_MS = 2000;

class Monitor {
	constructor({ store, docker, dataDir, interval = 60, onChange }) {
		this.store = store;
		this.docker = docker;
		this.interval = interval * 1000;
		this.onChange = onChange || (() => {});
		this.historyFile = path.join(dataDir, "history.json");
		this.eventsFile = path.join(dataDir, "events.json");
		this.history = readJSON(this.historyFile, {}); // sid -> [[hour, checks, ok, sumMs, maxMs]]
		this.events = readJSON(this.eventsFile, []);
		this.state = new Map(); // sid -> { status, ms, code, error, since, checked, recent }
		this.running = new Set();
		this.containers = null;
		this.stats = new Map(); // container name -> { cpu, memory }
	}

	start() {
		this.tick();
		this.timer = setInterval(() => this.tick(), 10 * 1000);
		this.statsTimer = setInterval(() => this.sampleStats(), 30 * 1000);
		this.statsTimer.unref();
		setTimeout(() => this.sampleStats(), 3000).unref();
		this.saver = setInterval(() => this.persist(), 5 * 60 * 1000);
		this.timer.unref();
		this.saver.unref();
	}

	persist() {
		const cutoff = hourOf(Date.now()) - KEEP_HOURS * HOUR;
		const known = new Set(this.store.config.services.map((s) => s.id));
		for (const sid of Object.keys(this.history)) {
			if (!known.has(sid)) delete this.history[sid];
			else this.history[sid] = this.history[sid].filter((b) => b[0] >= cutoff);
		}
		writeJSON(this.historyFile, this.history);
		writeJSON(this.eventsFile, this.events.slice(-300));
	}

	async tick() {
		const now = Date.now();
		const due = this.store.config.services.filter((s) => !this.running.has(s.id) && now - ((this.state.get(s.id) || {}).checked || 0) >= this.interval);
		if (!due.length) return;
		await this.loadContainers();
		// a few at a time, so a slow network doesn't pile up requests
		for (let i = 0; i < due.length; i += 6) await Promise.all(due.slice(i, i + 6).map((s) => this.check(s)));
	}

	// Checks one service now. Returns its new state.
	async loadContainers() {
		if (!this.docker || this.docker.available === false) return;
		this.containers = await this.docker.list().catch(() => null);
		this.containersAt = Date.now();
	}

	async check(s) {
		this.running.add(s.id);
		try {
			// container state changes fast (start/stop from the dashboard): don't trust an old list
			if (s.container && Date.now() - (this.containersAt || 0) > 3000) await this.loadContainers();
			let r = await this.probe(s);
			const prev = this.state.get(s.id);
			// one failure after "up" may be a hiccup: try again once before calling it down
			if (r.status === "down" && prev && prev.status !== "down" && !r.container) {
				await sleep(5000);
				r = await this.probe(s);
			}
			return this.record(s, r);
		} finally {
			this.running.delete(s.id);
		}
	}

	async probe(s) {
		const c = s.container && this.containers ? this.containers.find((x) => x.name === s.container) : null;
		if (c && c.state !== "running") return { status: "down", ms: null, container: true, error: containerText(c) };
		if (!s.url || s.check === false) return { status: c ? "up" : "unknown", ms: null };
		const res = await request(s.url, { insecure: true, timeout: 10000, maxBytes: 200000 });
		if (!res.status) return { status: "down", ms: null, error: res.error };
		if (res.status >= 500) return { status: "down", ms: res.ms, code: res.status, error: `HTTP ${res.status}` };
		return { status: res.ms > SLOW_MS ? "slow" : "up", ms: res.ms, code: res.status };
	}

	record(s, r) {
		const now = Date.now();
		const prev = this.state.get(s.id);
		const recent = prev ? prev.recent.slice(-59) : [];
		recent.push(r.ms);
		const st = { status: r.status, ms: r.ms, code: r.code || null, error: r.error || null, checked: now, since: prev && prev.status === r.status ? prev.since : now, recent };
		this.state.set(s.id, st);
		if (r.status !== "unknown") this.bucket(s.id, now, r);
		if (prev && prev.status !== r.status && r.status !== "unknown") {
			const ev = { t: now, sid: s.id, name: s.name, from: prev.status, to: r.status, detail: r.error || null };
			this.events.push(ev);
			if (this.events.length > 400) this.events = this.events.slice(-300);
			this.onChange(ev, s);
		}
		return st;
	}

	bucket(sid, now, r) {
		const list = (this.history[sid] = this.history[sid] || []);
		const h = hourOf(now);
		let b = list[list.length - 1];
		if (!b || b[0] !== h) list.push((b = [h, 0, 0, 0, 0]));
		b[1]++;
		if (r.status !== "down") {
			b[2]++;
			if (r.ms !== null && r.ms !== undefined) {
				b[3] += r.ms;
				b[4] = Math.max(b[4], r.ms);
			}
		}
	}

	// The last n hours, oldest first: { ok: 0…1 or null (no data), ms: average }
	hours(sid, n = 24) {
		const list = this.history[sid] || [];
		const byHour = new Map(list.map((b) => [b[0], b]));
		const h0 = hourOf(Date.now());
		return Array.from({ length: n }, (_, i) => {
			const b = byHour.get(h0 - (n - 1 - i) * HOUR);
			return b && b[1] ? { ok: b[2] / b[1], ms: b[2] ? Math.round(b[3] / b[2]) : null } : { ok: null, ms: null };
		});
	}

	// Share of successful checks in the last `days` days (null without data).
	uptime(sid, days = 30) {
		const from = Date.now() - days * 24 * HOUR;
		let checks = 0;
		let ok = 0;
		for (const b of this.history[sid] || []) {
			if (b[0] + HOUR < from) continue;
			checks += b[1];
			ok += b[2];
		}
		return checks ? Math.round((ok / checks) * 10000) / 100 : null;
	}

	// CPU and memory of the linked, running containers (Docker needs about a second per container).
	async sampleStats() {
		if (!this.docker || this.docker.available === false) return;
		const names = [...new Set(this.store.config.services.map((s) => s.container).filter(Boolean))];
		const running = new Set((this.containers || []).filter((c) => c.state === "running").map((c) => c.name));
		const todo = names.filter((n) => running.has(n));
		for (let i = 0; i < todo.length; i += 4) {
			await Promise.all(
				todo.slice(i, i + 4).map(async (n) => {
					const s = await this.docker.stats(n).catch(() => null);
					if (s && s.cpu !== undefined) this.stats.set(n, { cpu: s.cpu, memory: s.memory });
				})
			);
		}
		for (const n of this.stats.keys()) if (!running.has(n)) this.stats.delete(n);
	}

	// Compact state for the web app.
	summary(sid) {
		const st = this.state.get(sid);
		const s = this.store.config.services.find((x) => x.id === sid);
		let container = null;
		if (s && s.container && this.containers) {
			const c = this.containers.find((x) => x.name === s.container);
			if (c) container = { state: c.state, status: c.status, ...(this.stats.get(c.name) || {}) };
		}
		if (!st) return { status: "pending", container };
		return { status: st.status, ms: st.ms, error: st.error, since: st.since, checked: st.checked, recent: st.recent.slice(-30), uptime: this.uptime(sid, 1), container };
	}

	// something done through HomeBento (restart, Tailscale …), shown with the status changes
	note(s, kind, detail) {
		this.events.push({ t: Date.now(), sid: s.id, name: s.name, to: kind, detail });
		if (this.events.length > 400) this.events = this.events.slice(-300);
	}

	eventsOf(sid, n = 10) {
		return this.events.filter((e) => e.sid === sid).slice(-n).reverse();
	}

	forget(sid) {
		this.state.delete(sid);
		delete this.history[sid];
	}
}

function hourOf(t) {
	return Math.floor(t / HOUR) * HOUR;
}

function containerText(c) {
	const exit = /Exited \((\d+)\)/.exec(c.status || "");
	if (c.state === "exited") return exit ? `Container stopped (exit code ${exit[1]}${exit[1] === "137" ? ", killed – often out of memory" : ""})` : "Container stopped";
	if (c.state === "restarting") return "Container keeps restarting";
	if (c.state === "paused") return "Container paused";
	return `Container ${c.state}`;
}

module.exports = { Monitor, hourOf, SLOW_MS };
