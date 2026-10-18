"use strict";
// Portainer: environments and their containers with an access token (My account → Access tokens).
// Containers are counted live for the first few Docker environments, the rest from Portainer's snapshot.
const L = (de, en) => ({ de, en });

const LIVE = 5; // environments asked live (one request each)
const DOCKER = new Set([1, 2, 4]); // Docker, Agent, Edge Agent (the others are Kubernetes / Azure)

function fromSnapshot(e) {
	const s = Array.isArray(e.Snapshots) && e.Snapshots[0];
	if (!s) return null;
	const running = Number(s.RunningContainerCount) || 0;
	return { running, total: running + (Number(s.StoppedContainerCount) || 0), unhealthy: Number(s.UnhealthyContainerCount) || 0 };
}

module.exports = {
	kind: "portainer",
	label: "Portainer",
	match: /portainer/,
	repo: "portainer/portainer",
	ttl: 30000,
	fields: [
		{
			key: "apiKey",
			label: L("Zugriffstoken", "Access token"),
			help: L("Portainer → Mein Konto → Zugriffstokens → Token hinzufügen", "Portainer → My account → Access tokens → Add access token"),
			secret: true
		}
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.apiKey) throw new Error("Access token missing");
		const headers = { "X-API-Key": secrets.apiKey };
		const list = await json(`${url}/api/endpoints`, { headers });
		if (!Array.isArray(list)) throw new Error("Unexpected answer from Portainer");
		let asked = 0;
		const envs = await Promise.all(
			list.map(async (e) => {
				const up = e.Status === 1;
				let counts = null;
				if (up && DOCKER.has(e.Type) && asked++ < LIVE) {
					try {
						const cs = await json(`${url}/api/endpoints/${encodeURIComponent(e.Id)}/docker/containers/json?all=1`, { headers });
						if (Array.isArray(cs)) counts = { running: cs.filter((c) => c.State === "running").length, total: cs.length, unhealthy: cs.filter((c) => /\(unhealthy\)/.test(c.Status || "")).length };
					} catch {
						// edge agents in async mode and unreachable hosts: use the snapshot below
					}
				}
				if (!counts && up) counts = fromSnapshot(e);
				return { name: e.Name || String(e.Id), up, counts };
			})
		);
		const sum = (k) => envs.reduce((a, e) => a + (e.counts ? e.counts[k] : 0), 0);
		const running = sum("running");
		const total = sum("total");
		const unhealthy = sum("unhealthy");
		const down = envs.filter((e) => !e.up);
		return {
			metrics: [
				{ value: `${envs.length - down.length}/${envs.length}`, label: L("Umgebungen", "Environments"), warn: down.length > 0 },
				{ value: `${running}/${total}`, label: L("Container aktiv", "Containers running") },
				{ value: total - running, label: L("gestoppt", "stopped") },
				{ value: unhealthy, label: L("ungesund", "unhealthy"), warn: unhealthy > 0 }
			],
			items: envs
				.sort((a, b) => a.up - b.up || a.name.localeCompare(b.name))
				.map((e) => ({ title: e.name, sub: !e.up ? "offline" : e.counts ? `${e.counts.running}/${e.counts.total}${e.counts.unhealthy ? ` · ${e.counts.unhealthy} unhealthy` : ""}` : "", status: !e.up ? "bad" : e.counts && e.counts.unhealthy ? "warn" : "ok" })),
			warnings: down.map((e) => `Environment ${e.name} is down`),
			summary: down.length ? `${down.map((e) => e.name).join(", ")} down` : null
		};
	}
};
