"use strict";
// Integrations as plugins: one file per service in this folder. A plugin describes the login it
// needs and fetches a few key figures; tiles, the service list and the details show them.
//
// module.exports = {
//   kind: "pihole",                        unique id (used in config)
//   label: "Pi-hole",                      name in the form ({ de, en } allowed)
//   match: /pi-?hole/,                     recognises the service from its name or Docker image
//   repo: "pi-hole/pi-hole",               optional: GitHub repository for the Updates tile
//   ttl: 30000,                            optional: how long a result is cached (ms)
//   fields: [{ key, label, help, secret }],  logins and settings (secret ones stay on the server)
//   async fetch({ url, secrets, service, request, json }) {
//     return {
//       metrics: [{ value, label, warn }], up to 4 key figures (value and label: text or { de, en })
//       items: [{ title, sub, status }],   optional list for bigger tiles and the details
//                                          (status: "ok" | "warn" | "bad")
//       warnings: ["…"],                   optional, shown on the problem strip
//       summary: "…"                       optional, one line under the name
//     };
//   }
// };
const fs = require("node:fs");
const path = require("node:path");

const plugins = {};
for (const f of fs.readdirSync(__dirname)) {
	if (f === "index.js" || !f.endsWith(".js")) continue;
	try {
		const p = require(path.join(__dirname, f));
		if (p && p.kind && typeof p.fetch === "function") plugins[p.kind] = p;
	} catch (err) {
		console.error(`Plugin ${f} could not be loaded: ${err.message}`);
	}
}

module.exports = plugins;
