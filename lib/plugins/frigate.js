"use strict";
// Frigate NVR: cameras, detection and the latest events from /api/stats and /api/events.
// No login on the internal port (5000); behind a proxy with basic auth or a JWT (port 8971).
const L = (de, en) => ({ de, en });

const pad = (n) => String(n).padStart(2, "0");

function fmtTime(sec) {
	const d = new Date(sec * 1000);
	const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return d.toDateString() === new Date().toDateString() ? hm : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${hm}`;
}

// Frigate 0.14+ has the cameras under "cameras", older versions as top-level keys.
function camerasOf(stats) {
	const src = stats.cameras && typeof stats.cameras === "object" ? stats.cameras : stats;
	return Object.entries(src)
		.filter(([, v]) => v && typeof v === "object" && "camera_fps" in v)
		.map(([name, v]) => ({ name, fps: Number(v.camera_fps) || 0, detectionFps: Number(v.detection_fps) || 0 }));
}

module.exports = {
	kind: "frigate",
	label: "Frigate",
	match: /frigate/,
	repo: "blakeblackshear/frigate",
	ttl: 15000,
	fields: [
		{ key: "token", label: "Token", help: L("Optional: JWT (Port 8971) oder Proxy-Token", "Optional: JWT (port 8971) or proxy token"), secret: true },
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur bei Basic Auth", "Only with basic auth") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	camerasOf,
	async fetch({ url, secrets, json }) {
		const headers = {};
		if (secrets.token) headers.Authorization = `Bearer ${secrets.token}`;
		else if (secrets.username) headers.Authorization = `Basic ${Buffer.from(`${secrets.username}:${secrets.password || ""}`).toString("base64")}`;
		const midnight = new Date();
		midnight.setHours(0, 0, 0, 0);
		const after = Math.floor(midnight.getTime() / 1000);
		const [stats, latest, today] = await Promise.all([
			json(`${url}/api/stats`, { headers }),
			json(`${url}/api/events?limit=10`, { headers }),
			json(`${url}/api/events?after=${after}&limit=500`, { headers })
		]);
		const cameras = camerasOf(stats);
		const detectionFps = typeof stats.detection_fps === "number" ? stats.detection_fps : cameras.reduce((s, c) => s + c.detectionFps, 0);
		const speeds = Object.values(stats.detectors || {})
			.map((d) => Number(d.inference_speed))
			.filter((x) => x > 0);
		const inference = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null;
		const offline = cameras.filter((c) => c.fps === 0);
		const events = Array.isArray(latest) ? latest : [];
		const todayCount = Array.isArray(today) ? today.length : 0;
		const version = stats.service && stats.service.version;
		return {
			metrics: [
				{ value: cameras.length, label: L("Kameras", "Cameras"), warn: offline.length > 0 },
				{ value: Math.round(detectionFps * 10) / 10, label: L("Erkennung fps", "Detection fps") },
				{ value: inference !== null ? `${Math.round(inference * 10) / 10} ms` : "–", label: L("Inferenz", "Inference") },
				{ value: todayCount >= 500 ? "500+" : todayCount, label: L("Ereignisse heute", "Events today") }
			],
			items: events.map((e) => ({ title: `${e.label} · ${e.camera}`, sub: e.start_time ? fmtTime(e.start_time) : "", status: "ok" })),
			warnings: offline.map((c) => `Camera ${c.name} delivers no frames`),
			summary: version ? `v${String(version).split("-")[0]}` : null
		};
	}
};
