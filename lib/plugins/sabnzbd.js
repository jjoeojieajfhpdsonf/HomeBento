"use strict";
// SABnzbd: speed, queue and recently failed downloads (mode=queue / mode=history).
// API key: Config → General → Security → API Key.
const L = (de, en) => ({ de, en });

const speed = (bps) => (bps >= 1e6 || !bps ? `${(bps / 1e6).toFixed(1)} MB/s` : `${Math.round(bps / 1e3)} kB/s`);

async function call(json, url, apiKey, query) {
	const r = await json(`${url}/api?${query}&output=json&apikey=${encodeURIComponent(apiKey)}`);
	// a wrong key is answered with HTTP 200 and { status: false, error: "API Key Incorrect" }
	if (r && r.status === false) throw new Error(/key/i.test(r.error || "") ? "Access denied (check the API key)" : `SABnzbd: ${r.error || "error"}`);
	return r;
}

module.exports = {
	kind: "sabnzbd",
	label: "SABnzbd",
	match: /sabnzbd/,
	repo: "sabnzbd/sabnzbd",
	ttl: 5000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Config → General → Security → API Key", "Config → General → Security → API Key"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const [q, h] = await Promise.all([call(json, url, secrets.apiKey, "mode=queue"), call(json, url, secrets.apiKey, "mode=history&limit=5").catch(() => null)]);
		const queue = (q && q.queue) || {};
		const slots = queue.slots || [];
		const failed = ((h && h.history && h.history.slots) || []).filter((x) => x.status === "Failed");
		// kbpersec is KiB/s
		const bps = (Number(queue.kbpersec) || 0) * 1024;
		const paused = queue.paused === true || queue.paused === "True" || queue.status === "Paused";
		return {
			metrics: [
				{ value: speed(bps), label: L("↓ Download", "↓ Download") },
				{ value: Number(queue.noofslots ?? slots.length) || 0, label: L("Warteschlange", "Queue") },
				{ value: queue.sizeleft || "0 B", label: L("verbleibend", "Left") },
				{ value: paused ? L("Pausiert", "Paused") : L("Läuft", "Running"), label: L("Status", "State"), warn: paused }
			],
			items: slots.map((s) => ({ title: s.filename, sub: [`${s.percentage ?? 0} %`, s.timeleft && s.timeleft !== "0:00:00" ? s.timeleft : "", s.status].filter(Boolean).join(" · "), status: s.status === "Paused" ? "warn" : "ok" })),
			warnings: failed.map((x) => `${x.name} failed${x.fail_message ? `: ${x.fail_message}` : ""}`),
			summary: paused ? "Paused" : slots.length ? `${slots[0].filename} · ${slots[0].percentage ?? 0} %` : null
		};
	}
};
