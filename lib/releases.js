"use strict";
// GitHub releases of subscribed repositories, cached for a few hours (GitHub allows 60 requests
// an hour without a token; GITHUB_TOKEN raises that). Repositories of services are found from the
// Docker image label org.opencontainers.image.source, or from a list of well-known projects.
const { json } = require("./util");

const TTL = 3 * 3600 * 1000;
const KNOWN = {
	jellyfin: "jellyfin/jellyfin",
	sonarr: "Sonarr/Sonarr",
	radarr: "Radarr/Radarr",
	prowlarr: "Prowlarr/Prowlarr",
	lidarr: "Lidarr/Lidarr",
	bazarr: "morpheus65535/bazarr",
	qbittorrent: "qbittorrent/qBittorrent",
	flaresolverr: "FlareSolverr/FlareSolverr",
	portainer: "portainer/portainer",
	grafana: "grafana/grafana",
	prometheus: "prometheus/prometheus",
	"uptime-kuma": "louislam/uptime-kuma",
	dozzle: "amir20/dozzle",
	homarr: "homarr-labs/homarr",
	"home-assistant": "home-assistant/core",
	immich: "immich-app/immich",
	nextcloud: "nextcloud/server",
	vaultwarden: "dani-garcia/vaultwarden",
	"adguard-home": "AdguardTeam/AdGuardHome",
	adguardhome: "AdguardTeam/AdGuardHome",
	pihole: "pi-hole/pi-hole",
	traefik: "traefik/traefik",
	"nginx-proxy-manager": "NginxProxyManager/nginx-proxy-manager",
	watchtower: "containrrr/watchtower",
	magicmirror: "MagicMirrorOrg/MagicMirror",
	homebento: "jjoeojieajfhpdsonf/HomeBento"
};
const KIND_REPO = { mmmanager: "jjoeojieajfhpdsonf/magicMirrorManager" };

const validRepo = (r) => typeof r === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(r);

// "https://github.com/owner/repo(.git)", "github.com/owner/repo/releases" or "owner/repo" → "owner/repo"
function parseRepo(input) {
	const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i.exec(String(input || "").trim());
	return m && validRepo(`${m[1]}/${m[2]}`) ? `${m[1]}/${m[2]}` : null;
}

class Releases {
	constructor() {
		this.cache = new Map(); // repo -> { at, data, error, pending }
	}

	headers() {
		const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
		if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		return h;
	}

	// { repo, latest: { tag, name, date, url, prerelease }, recent: [...] } or { repo, error }
	async get(repo) {
		const c = this.cache.get(repo);
		if (c && c.pending) return c.data || c.error ? { repo, ...c.data, error: c.error } : c.pending;
		if (c && Date.now() - c.at < (c.error ? 15 * 60000 : TTL)) return { repo, ...c.data, error: c.error };
		const pending = this.fetch(repo).then((r) => {
			this.cache.set(repo, { at: Date.now(), ...r });
			return { repo, ...r.data, error: r.error };
		});
		this.cache.set(repo, { ...(c || { at: 0 }), pending });
		return c && (c.data || c.error) ? { repo, ...c.data, error: c.error } : pending;
	}

	async fetch(repo) {
		try {
			const list = await json(`https://api.github.com/repos/${repo}/releases?per_page=6`, { headers: this.headers(), timeout: 15000 });
			let recent = list.filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, date: Date.parse(r.published_at || r.created_at), url: r.html_url, prerelease: !!r.prerelease }));
			if (!recent.length) {
				// projects that only tag (no GitHub releases)
				const tags = await json(`https://api.github.com/repos/${repo}/tags?per_page=3`, { headers: this.headers(), timeout: 15000 });
				recent = tags.map((x) => ({ tag: x.name, name: x.name, date: null, url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(x.name)}`, prerelease: false }));
			}
			const stable = recent.filter((r) => !r.prerelease);
			return { data: { latest: stable[0] || recent[0] || null, recent } };
		} catch (err) {
			return { error: /404|HTTP 404/.test(err.message) ? "Repository not found" : /denied|403|429/.test(err.message) ? "GitHub limit reached – try later or set GITHUB_TOKEN" : err.message };
		}
	}

	// Release notes of one tag (Markdown from GitHub).
	async notes(repo, tag) {
		const r = await json(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: this.headers(), timeout: 15000 });
		return { repo, tag: r.tag_name, name: r.name || r.tag_name, date: Date.parse(r.published_at || r.created_at), url: r.html_url, body: String(r.body || "").slice(0, 60000) };
	}

	// Repository suggestions for the services: image label first, then the list of known projects.
	suggest(services, containers) {
		const out = [];
		for (const s of services) {
			let repo = null;
			const c = s.container && containers ? containers.find((x) => x.name === s.container) : null;
			const label = c && c.labels && (c.labels["org.opencontainers.image.source"] || c.labels["org.opencontainers.image.url"]);
			if (label && /github\.com/i.test(label)) repo = parseRepo(label);
			if (!repo && s.kind && KIND_REPO[s.kind]) repo = KIND_REPO[s.kind];
			const slug = String(s.icon || s.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
			if (!repo && KNOWN[slug]) repo = KNOWN[slug];
			if (!repo && c) {
				const img = c.image.split("@")[0].split(":")[0].split("/").pop().replace(/-(ce|ee)$/, "");
				if (KNOWN[img]) repo = KNOWN[img];
			}
			if (repo) out.push({ service: s.id, repo });
		}
		return out;
	}
}

// The version a container runs, from its image labels (linuxserver: "4.0.20.3014-ls329").
function runningVersion(c) {
	if (!c || !c.labels) return null;
	const l = c.labels;
	const v = l["org.opencontainers.image.version"] || l["org.label-schema.version"] || (/version:-\s*(\S+)/.exec(l.build_version || "") || [])[1];
	return v && v !== "latest" ? String(v) : null;
}

// Is `running` the same release as `latest`? Leading "v" and trailing zeros don't matter;
// linuxserver builds ("-ls329") count, other suffixes (dates of packaging builds) don't.
function sameVersion(running, latest) {
	if (!running || !latest) return null;
	const norm = (v) => String(v).trim().replace(/^v/i, "").toLowerCase();
	if (norm(running) === norm(latest)) return true;
	const core = (v) => ((/\d+(?:\.\d+)+/.exec(norm(v)) || [""])[0] || "").split(".").map(Number);
	const a = core(running);
	const b = core(latest);
	if (!a.length || !b.length || !a[0] && a[0] !== 0) return null;
	const n = Math.max(a.length, b.length);
	for (let i = 0; i < n; i++) if ((a[i] || 0) !== (b[i] || 0)) return false;
	const ls = (v) => (/-ls(\d+)/.exec(norm(v)) || [])[1];
	if (ls(running) && ls(latest)) return ls(running) === ls(latest);
	return true;
}

module.exports = { Releases, parseRepo, validRepo, KNOWN, runningVersion, sameVersion };
