"use strict";
// CPU, memory, disk, temperature and uptime of the machine the dashboard runs on.
// In Docker, mount the host's root read-only (HOST_ROOT=/host) for the disk of the host;
// /proc already shows the host's CPU and memory.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

class Host {
	constructor({ root = process.env.HOST_ROOT || "/", name = process.env.HOST_NAME } = {}) {
		this.root = root;
		this.name = name || os.hostname().replace(/\.local$/, "");
		this.prev = cpuTimes();
		this.cpu = 0;
		this.timer = setInterval(() => this.sample(), 5000);
		this.timer.unref();
	}

	sample() {
		const cur = cpuTimes();
		const idle = cur.idle - this.prev.idle;
		const total = cur.total - this.prev.total;
		if (total > 0) this.cpu = Math.round((1 - idle / total) * 100);
		this.prev = cur;
	}

	stats() {
		return { name: this.name, cpu: this.cpu, cores: os.cpus().length, ...memory(), ...disk(this.root), temp: temperature(), uptime: uptime(), load: os.loadavg()[0] };
	}
}

function cpuTimes() {
	try {
		// first line of /proc/stat: cpu user nice system idle iowait irq softirq steal …
		const v = fs.readFileSync("/proc/stat", "utf8").split("\n")[0].trim().split(/\s+/).slice(1).map(Number);
		const idle = v[3] + (v[4] || 0);
		return { idle, total: v.slice(0, 8).reduce((a, b) => a + b, 0) };
	} catch {
		let idle = 0;
		let total = 0;
		for (const c of os.cpus()) {
			for (const t of Object.values(c.times)) total += t;
			idle += c.times.idle;
		}
		return { idle, total };
	}
}

function memory() {
	try {
		const m = Object.fromEntries(
			fs.readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((l) => {
				const [k, v] = l.split(":");
				return [k, parseInt(v, 10) * 1024];
			})
		);
		return { memTotal: m.MemTotal, memUsed: m.MemTotal - (m.MemAvailable ?? m.MemFree) };
	} catch {
		return { memTotal: os.totalmem(), memUsed: os.totalmem() - os.freemem() };
	}
}

function disk(root) {
	try {
		const s = fs.statfsSync(root);
		const total = s.blocks * s.bsize;
		return { diskTotal: total, diskUsed: total - s.bavail * s.bsize };
	} catch {
		return { diskTotal: null, diskUsed: null };
	}
}

// Highest CPU-ish temperature in °C, or null (e.g. on a Mac).
function temperature() {
	const temps = [];
	const read = (f) => {
		try {
			const v = parseInt(fs.readFileSync(f, "utf8"), 10);
			if (v > 1000 && v < 150000) temps.push(v / 1000);
		} catch {
			// not readable
		}
	};
	try {
		for (const z of fs.readdirSync("/sys/class/thermal")) if (z.startsWith("thermal_zone")) read(path.join("/sys/class/thermal", z, "temp"));
	} catch {
		// no thermal zones
	}
	if (!temps.length) {
		try {
			for (const h of fs.readdirSync("/sys/class/hwmon")) {
				const dir = path.join("/sys/class/hwmon", h);
				for (const f of fs.readdirSync(dir)) if (/^temp\d+_input$/.test(f)) read(path.join(dir, f));
			}
		} catch {
			// no hwmon
		}
	}
	return temps.length ? Math.round(Math.max(...temps)) : null;
}

function uptime() {
	try {
		return Math.round(parseFloat(fs.readFileSync("/proc/uptime", "utf8")) * 1000);
	} catch {
		return Math.round(os.uptime() * 1000);
	}
}

module.exports = { Host };
