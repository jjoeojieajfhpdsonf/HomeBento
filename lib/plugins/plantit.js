"use strict";
// Plant-it (self-hosted server, versions 0.x): plants, diary entries and which care tasks (watering,
// fertilizing, …) are due, from /api/stats and /api/reminder/occurrences. Needs an API key
// (Plant-it → Settings → API keys), sent in the header "Key". Plant-it 1.x is an Android app
// without a server and cannot be shown.
const L = (de, en) => ({ de, en });

const DAY = 86400000;
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const action = (a) => String(a || "care").toLowerCase().replace(/_/g, " ");

module.exports = {
	kind: "plantit",
	label: "Plant-it",
	match: /^(?!.*(mysql|mariadb|redis|valkey|cache|[-_ ]db\b)).*plant-?it/,
	ttl: 300000,
	fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Plant-it → Einstellungen → API-Schlüssel (Server-Port, meist 8080)", "Plant-it → Settings → API keys (server port, usually 8080)"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		const api = url.replace(/\/api$/, "");
		const headers = { Key: secrets.apiKey };
		const now = new Date();
		const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		const endOfToday = new Date(startOfToday.getTime() + DAY);
		const from = new Date(startOfToday.getTime() - 60 * DAY).toISOString();
		const to = new Date(endOfToday.getTime() + 7 * DAY).toISOString();
		const [stats, occ] = await Promise.all([
			json(`${api}/api/stats`, { headers }),
			// reminders exist since 0.6; older servers answer 404
			json(`${api}/api/reminder/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&size=500`, { headers }).catch(() => null)
		]);
		if (!stats || typeof stats.plantCount !== "number") throw new Error("Unexpected answer from Plant-it");
		const list = occ && Array.isArray(occ.content) ? occ.content : Array.isArray(occ) ? occ : null;
		// a reminder that was not done repeats in the past: keep only its first open date
		const first = new Map();
		for (const o of list || []) {
			const at = new Date(o.date).getTime();
			if (!Number.isFinite(at)) continue;
			const key = o.reminderId ?? `${o.reminderTargetId}-${o.reminderAction}`;
			if (!first.has(key) || at < first.get(key).at) first.set(key, { at, plant: o.reminderTargetInfoPersonalName || `Plant ${o.reminderTargetId ?? "?"}`, what: action(o.reminderAction) });
		}
		const tasks = [...first.values()].sort((a, b) => a.at - b.at || a.plant.localeCompare(b.plant));
		const due = tasks.filter((t) => t.at < endOfToday.getTime());
		const overdue = due.filter((t) => t.at < startOfToday.getTime());
		return {
			metrics: [
				{ value: stats.plantCount, label: L("Pflanzen", "Plants") },
				{ value: list ? due.length : null, label: L("heute fällig", "due today"), warn: overdue.length > 0 },
				{ value: list ? tasks.length - due.length : null, label: L("nächste 7 Tage", "next 7 days") },
				{ value: stats.diaryEntryCount ?? null, label: L("Tagebuch", "Diary entries") }
			],
			items: tasks.map((t) => ({ title: t.plant, sub: `${t.what} · ${t.at < startOfToday.getTime() ? `overdue since ${isoDay(new Date(t.at))}` : t.at < endOfToday.getTime() ? "today" : isoDay(new Date(t.at))}`, status: t.at < startOfToday.getTime() ? "warn" : "ok" })),
			summary: due.length ? `Due: ${due.map((t) => `${t.plant} (${t.what})`).join(", ")}` : null
		};
	}
};
