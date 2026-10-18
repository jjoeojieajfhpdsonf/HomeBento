"use strict";
// Messages when something needs attention: a service goes down (and comes back), a certificate
// runs out, the server's storage, temperature or memory crosses a limit, a container keeps
// restarting. Sent to the channels in the settings (lib/notify.js), never while muted.
const notify = require("./notify");

const MIN = 60000;
const DAY = 86400000;
const DEFAULT_LIMITS = { disk: 90, temp: 80, memory: 95, certDays: 14 };

class Alerts {
	constructor({ store, monitor, host, envUrl }) {
		this.store = store;
		this.monitor = monitor;
		this.host = host;
		this.envUrl = envUrl || "";
		this.active = new Map(); // key → { kind, name, value, detail, since, sid }
		this.pending = new Map(); // sid → timer (down, waiting for the delay)
		this.sentDown = new Set(); // sids whose "down" went out (so "up" goes out too)
		this.quiet = new Map(); // sid → until (container update running)
		this.errors = {}; // channel id → { at, error }
		this.restarts = new Map(); // container → [times seen restarting]
	}

	get cfg() {
		return this.store.config.alerts || {};
	}

	limits() {
		return { ...DEFAULT_LIMITS, ...(this.cfg.limits || {}) };
	}

	// The channels with their secrets; NOTIFY_URL (environment) counts as an ntfy channel.
	channels() {
		const list = (this.cfg.channels || []).filter((c) => c.enabled !== false).map((c) => ({ ...c, send: { type: c.type, ...c.fields, ...this.store.secretsOf(`channel:${c.id}`) } }));
		if (this.envUrl) list.push({ id: "env", type: "ntfy", name: "NOTIFY_URL", events: { down: true, up: true, warn: true, resources: true }, send: { type: "ntfy", url: this.envUrl } });
		return list;
	}

	muted(s) {
		const now = Date.now();
		if (this.cfg.mutedUntil > now) return true;
		if (s && s.mutedUntil > now) return true;
		return !!(s && this.quiet.get(s.id) > now);
	}

	// While a container is being updated it's expected to be gone for a moment.
	hush(sid, ms) {
		this.quiet.set(sid, Date.now() + ms);
	}

	// ev.kind: down | up | cert | disk | temp | memory | restarts | test; category: down | up | warn | resources
	async dispatch(ev, category, only) {
		const lang = this.cfg.lang === "de" ? "de" : "en";
		const msg = notify.format(ev, lang);
		const targets = only ? [only] : this.channels().filter((c) => !c.events || c.events[category] !== false);
		const results = await Promise.all(
			targets.map(async (c) => {
				try {
					await notify.send(c.send, msg);
					delete this.errors[c.id];
					return { id: c.id, ok: true };
				} catch (err) {
					this.errors[c.id] = { at: Date.now(), error: err.message };
					console.error(`Notification to ${c.name || c.type} failed: ${err.message}`);
					return { id: c.id, error: err.message };
				}
			})
		);
		return results;
	}

	// A status change from the monitor.
	onChange(ev, s) {
		if (ev.from === "pending" || ev.to === "slow" || ev.from === "slow") return;
		if (ev.to === "down") {
			if (this.muted(s)) return;
			const delay = (this.cfg.delay || 0) * MIN;
			const go = () => {
				this.pending.delete(s.id);
				const st = this.monitor.state.get(s.id);
				if (st && st.status !== "down") return;
				this.sentDown.add(s.id);
				this.dispatch({ kind: "down", name: s.name, detail: ev.detail }, "down");
			};
			if (delay) this.pending.set(s.id, setTimeout(go, delay));
			else go();
		} else if (ev.to === "up") {
			// back before the delay ran out: nothing was sent, nothing to say
			if (this.pending.has(s.id)) {
				clearTimeout(this.pending.get(s.id));
				this.pending.delete(s.id);
				return;
			}
			if (!this.sentDown.delete(s.id)) return;
			this.dispatch({ kind: "up", name: s.name }, "up");
		}
	}

	// Looks at limits and certificates (every minute).
	check() {
		const lim = this.limits();
		const found = new Map();
		const h = this.host.stats();
		for (const d of this.host.disks()) {
			const pct = d.total ? Math.round((d.used / d.total) * 100) : 0;
			if (pct >= lim.disk) found.set(`disk:${d.mount}`, { kind: "disk", name: d.mount, value: pct, category: "resources", clear: pct < lim.disk - 2 });
		}
		if (h.temp !== null && h.temp !== undefined && h.temp >= lim.temp) found.set("temp", { kind: "temp", name: h.name, value: h.temp, category: "resources" });
		const mem = h.memTotal ? Math.round((h.memUsed / h.memTotal) * 100) : 0;
		if (mem >= lim.memory) found.set("memory", { kind: "memory", name: h.name, value: mem, category: "resources" });
		// containers that restart again and again (seen "restarting" 3 times in 15 minutes)
		const now = Date.now();
		for (const c of this.monitor.containers || []) {
			const seen = (this.restarts.get(c.name) || []).filter((t) => now - t < 15 * MIN);
			if (c.state === "restarting") seen.push(now);
			this.restarts.set(c.name, seen);
			if (seen.length >= 3) found.set(`restarts:${c.name}`, { kind: "restarts", name: c.name, value: seen.length, category: "resources" });
		}
		for (const s of this.store.config.services) {
			const cert = this.monitor.certOf(s.id);
			if (cert && s.certWarn !== false && cert.daysLeft <= lim.certDays) found.set(`cert:${s.id}`, { kind: "cert", name: s.name, value: cert.daysLeft, sid: s.id, category: "warn" });
		}
		// new ones: an event and a message; gone ones: forgotten (a little below the limit for disks)
		for (const [key, a] of found) {
			if (this.active.has(key)) {
				Object.assign(this.active.get(key), { value: a.value });
				continue;
			}
			this.active.set(key, { ...a, since: now });
			const s = a.sid ? this.store.config.services.find((x) => x.id === a.sid) : null;
			this.monitor.note({ id: a.sid || null, name: a.kind === "cert" ? a.name : a.name }, "alert", notify.format(a, this.cfg.lang === "de" ? "de" : "en").title);
			if (!this.muted(s)) this.dispatch(a, a.category);
		}
		for (const key of [...this.active.keys()]) if (!found.has(key)) this.active.delete(key);
	}

	// For the web app: what's wrong with the server right now.
	list() {
		return [...this.active.entries()].map(([key, a]) => ({ key, kind: a.kind, name: a.name, value: a.value, since: a.since, sid: a.sid || null }));
	}

	start() {
		this.timer = setInterval(() => {
			try {
				this.check();
			} catch (err) {
				console.error(`Alert check failed: ${err.message}`);
			}
		}, MIN);
		this.timer.unref();
		setTimeout(() => this.check(), 20000).unref();
	}

	// Settings for the web app: channels without their secrets (only which ones are set).
	view() {
		const cfg = this.cfg;
		return {
			channels: (cfg.channels || []).map((c) => ({ ...c, secrets: Object.fromEntries(Object.keys(this.store.secretsOf(`channel:${c.id}`)).map((k) => [k, true])), error: this.errors[c.id] || null })),
			env: !!this.envUrl,
			delay: cfg.delay || 0,
			limits: this.limits(),
			mutedUntil: cfg.mutedUntil > Date.now() ? cfg.mutedUntil : null,
			lang: cfg.lang || null,
			types: notify.CHANNELS,
			active: this.list()
		};
	}

	// A test message through one channel (saved, or as typed in the form with its secrets).
	async test(channel, secrets) {
		const saved = (this.cfg.channels || []).find((c) => c.id === channel.id);
		const send = { type: channel.type, ...(channel.fields || {}), ...(saved ? this.store.secretsOf(`channel:${saved.id}`) : {}), ...Object.fromEntries(Object.entries(secrets || {}).filter(([, v]) => v)) };
		const [r] = await this.dispatch({ kind: "test" }, "test", { id: channel.id || "test", name: channel.name, type: channel.type, send });
		if (r.error) throw new Error(r.error);
		return { ok: true };
	}
}

module.exports = { Alerts, DEFAULT_LIMITS, DAY };
