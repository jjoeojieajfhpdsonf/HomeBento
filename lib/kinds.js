"use strict";
// Services the dashboard knows more about than "is it up": which login they need, which tile
// shows their content, and how to recognise them from a name or a Docker image.
const L = (de, en) => ({ de, en });

const KINDS = {
	jellyfin: {
		label: "Jellyfin",
		tile: "jellyfin",
		fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Jellyfin → Dashboard → API-Schlüssel → +", "Jellyfin → Dashboard → API Keys → +"), secret: true }]
	},
	sonarr: {
		label: "Sonarr",
		tile: "calendar",
		fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Sonarr → Settings → General → API Key", "Sonarr → Settings → General → API Key"), secret: true }]
	},
	radarr: {
		label: "Radarr",
		tile: "calendar",
		fields: [{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Radarr → Settings → General → API Key", "Radarr → Settings → General → API Key"), secret: true }]
	},
	qbittorrent: {
		label: "qBittorrent",
		tile: "downloads",
		fields: [
			{ key: "username", label: L("Benutzer", "User"), help: L("Leer lassen, wenn qBittorrent im Heimnetz ohne Login erlaubt ist", "Leave empty if qBittorrent allows the local network without login") },
			{ key: "password", label: L("Passwort", "Password"), secret: true }
		]
	},
	solar: {
		label: L("Solar-Dashboard", "Solar dashboard"),
		tile: "solar",
		fields: []
	},
	mmmanager: {
		label: "MagicMirror Manager",
		tile: null,
		fields: [{ key: "password", label: L("Passwort", "Password"), help: L("Nur nötig, wenn der Manager ein Passwort hat", "Only if the manager has a password"), secret: true }]
	}
};

// Words in names and images that point to a kind.
const MATCH = [
	["jellyfin", /jellyfin/],
	["sonarr", /sonarr/],
	["radarr", /radarr/],
	["qbittorrent", /qbittorrent|qbit/],
	["mmmanager", /mirror.?manager|magicmirror-manager|mm-manager/],
	["solar", /solar/]
];

function guessKind(...texts) {
	const t = texts.filter(Boolean).join(" ").toLowerCase();
	for (const [kind, re] of MATCH) if (re.test(t)) return kind;
	return null;
}

// Icon name in https://github.com/homarr-labs/dashboard-icons, e.g. "linuxserver/sonarr:4" → "sonarr".
function guessIcon(name, image) {
	if (image) {
		const base = image.split("@")[0].split(":")[0].split("/").pop();
		return base.replace(/-(ce|ee|server|app|web)$/, "");
	}
	return String(name || "")
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "");
}

// "uptime-kuma" → "Uptime Kuma", "qbittorrent" → "qBittorrent"
const NAMES = { qbittorrent: "qBittorrent", "uptime-kuma": "Uptime Kuma", portainer: "Portainer", flaresolverr: "FlareSolverr", "home-assistant": "Home Assistant", adguardhome: "AdGuard Home", "nginx-proxy-manager": "Nginx Proxy Manager" };
function niceName(slug) {
	if (NAMES[slug]) return NAMES[slug];
	return slug.split(/[-_]/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

module.exports = { KINDS, guessKind, guessIcon, niceName };
