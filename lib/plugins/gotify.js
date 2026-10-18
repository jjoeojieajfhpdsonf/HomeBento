"use strict";
// Gotify: messages, applications and clients from /message, /application and /client with a
// client token in the X-Gotify-Key header (Gotify → Clients → Create client; an application token
// cannot read). The latest messages are listed.
const L = (de, en) => ({ de, en });

function age(iso) {
	const t = Date.parse(iso);
	if (!iso || isNaN(t)) return "";
	const min = Math.max(0, Math.round((Date.now() - t) / 60000));
	if (min < 60) return `${min} min`;
	if (min < 48 * 60) return `${Math.round(min / 60)} h`;
	return `${Math.round(min / 1440)} d`;
}

const LIMIT = 200; // the most Gotify returns at once

module.exports = {
	kind: "gotify",
	label: "Gotify",
	match: /^(?!.*(postgres|mariadb|mysql|[-_ ]db\b)).*gotify/,
	repo: "gotify/server",
	ttl: 60000,
	fields: [{ key: "token", label: L("Client-Token", "Client token"), help: L("Gotify → Clients → Client erstellen (ein App-Token kann nicht lesen)", "Gotify → Clients → Create client (an app token cannot read)"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Client token missing");
		const headers = { "X-Gotify-Key": secrets.token };
		const [msgs, apps, clients] = await Promise.all([json(`${url}/message?limit=${LIMIT}`, { headers }), json(`${url}/application`, { headers }), json(`${url}/client`, { headers })]);
		if (!msgs || !Array.isArray(msgs.messages) || !Array.isArray(apps) || !Array.isArray(clients)) throw new Error("Unexpected answer from Gotify");
		const appName = new Map(apps.map((a) => [a.id, a.name]));
		const more = msgs.paging && msgs.paging.next;
		return {
			metrics: [
				{ value: `${msgs.messages.length}${more ? "+" : ""}`, label: L("Nachrichten", "Messages") },
				{ value: apps.length, label: L("Apps", "Apps") },
				{ value: clients.length, label: L("Clients", "Clients") }
			],
			items: msgs.messages.slice(0, 20).map((m) => ({
				title: m.title || String(m.message || "").split("\n")[0].slice(0, 80) || "?",
				sub: [appName.get(m.appid) || "", age(m.date)].filter(Boolean).join(" · "),
				status: m.priority >= 8 ? "warn" : "ok"
			}))
		};
	}
};
