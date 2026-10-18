"use strict";
// Proxmox VE: nodes, VMs and containers from /api2/json/cluster/resources with an API token
// (Datacenter → Permissions → API Tokens; the role PVEAuditor is enough).
const L = (de, en) => ({ de, en });

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

module.exports = {
	kind: "proxmox",
	label: "Proxmox VE",
	match: /proxmox/,
	ttl: 30000,
	fields: [
		{
			key: "tokenId",
			label: L("Token-ID", "Token ID"),
			help: L(
				"Rechenzentrum → Berechtigungen → API-Token, z. B. root@pam!homebento (Rolle PVEAuditor genügt). Proxmox läuft meist auf https://…:8006 mit eigenem Zertifikat – dann «Eigenes Zertifikat erlauben» einschalten.",
				"Datacenter → Permissions → API Tokens, e.g. root@pam!homebento (the role PVEAuditor is enough). Proxmox usually runs on https://…:8006 with a self-signed certificate – then turn on “Allow own certificate”."
			)
		},
		{ key: "tokenSecret", label: L("Token-Geheimnis", "Token secret"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.tokenId || !secrets.tokenSecret) throw new Error("API token missing");
		if (!/^[^@!\s]+@[^@!\s]+![^@!\s]+$/.test(secrets.tokenId)) throw new Error("Token ID must look like user@realm!name");
		const r = await json(`${url}/api2/json/cluster/resources`, { headers: { Authorization: `PVEAPIToken=${secrets.tokenId}=${secrets.tokenSecret}` } });
		if (!r || !Array.isArray(r.data)) throw new Error("Unexpected answer from Proxmox");
		const nodes = r.data.filter((x) => x.type === "node");
		if (!nodes.length) throw new Error("The token sees no nodes (give it the PVEAuditor role)");
		const online = nodes.filter((x) => x.status === "online");
		const guests = r.data
			.filter((x) => (x.type === "qemu" || x.type === "lxc") && !x.template)
			.map((x) => ({ name: x.name || String(x.vmid), vmid: x.vmid, type: x.type === "qemu" ? "VM" : "LXC", node: x.node, status: x.status || "unknown", cpu: x.cpu, mem: pct(x.mem, x.maxmem) }));
		const running = guests.filter((g) => g.status === "running");
		const cpu = pct(online.reduce((a, n) => a + (n.cpu || 0) * (n.maxcpu || 0), 0), online.reduce((a, n) => a + (n.maxcpu || 0), 0));
		const mem = pct(online.reduce((a, n) => a + (n.mem || 0), 0), online.reduce((a, n) => a + (n.maxmem || 0), 0));
		const offline = nodes.filter((x) => x.status !== "online");
		return {
			metrics: [
				{ value: `${running.length}/${guests.length}`, label: L("VMs & LXC aktiv", "VMs & LXC running") },
				{ value: `${online.length}/${nodes.length}`, label: L("Nodes online", "Nodes online"), warn: offline.length > 0 },
				{ value: cpu !== null ? `${cpu} %` : null, label: "CPU", warn: cpu > 90 },
				{ value: mem !== null ? `${mem} %` : null, label: "RAM", warn: mem > 90 }
			],
			items: guests
				.sort((a, b) => (a.status === "running") - (b.status === "running") || a.name.localeCompare(b.name))
				.map((g) => ({
					title: g.name,
					sub: [`${g.type} ${g.vmid}`, g.node, g.status === "running" ? `CPU ${Math.round((g.cpu || 0) * 100)} %` : g.status, g.status === "running" && g.mem !== null ? `RAM ${g.mem} %` : ""].filter(Boolean).join(" · "),
					status: g.status === "running" ? "ok" : "warn"
				})),
			warnings: offline.map((n) => `Node ${n.node} is ${n.status || "offline"}`),
			summary: offline.length ? `${offline.map((n) => n.node).join(", ")} offline` : null
		};
	}
};
