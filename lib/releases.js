"use strict";
// GitHub releases of subscribed repositories, cached for a few hours (GitHub allows 60 requests
// an hour without a token; GITHUB_TOKEN raises that). Repositories of services are found from the
// Docker image label org.opencontainers.image.source, or from a list of well-known projects.
const path = require("node:path");
const { request, readJSON, writeJSON } = require("./util");

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
for (const p of Object.values(require("./plugins"))) if (p.repo) KIND_REPO[p.kind] = p.repo;

const validRepo = (r) => typeof r === "string" && /^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(r);

// "https://github.com/owner/repo(.git)", "github.com/owner/repo/releases" or "owner/repo" → "owner/repo"
function parseRepo(input) {
	const m = /^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i.exec(String(input || "").trim());
	return m && validRepo(`${m[1]}/${m[2]}`) ? `${m[1]}/${m[2]}` : null;
}

class Releases {
	constructor(dataDir) {
		// kept on disk: a restart must not spend the GitHub limit again
		this.file = dataDir ? path.join(dataDir, "releases-cache.json") : null;
		this.cache = new Map(Object.entries((this.file && readJSON(this.file, {})) || {}));
	}

	persist() {
		if (!this.file) return;
		const out = {};
		for (const [k, v] of this.cache) if (v.data) out[k] = { at: v.at, data: v.data, etag: v.etag || null };
		writeJSON(this.file, out);
	}

	// GET with ETag: "not modified" answers don't count against GitHub's limit
	async gh(url, etag) {
		const r = await request(url, { headers: { ...this.headers(), ...(etag ? { "If-None-Match": etag } : {}) }, timeout: 15000, maxBytes: 5_000_000 });
		if (!r.status) throw new Error(r.error);
		if (r.status === 304) return { notModified: true };
		if (r.status === 404) throw new Error("Repository not found");
		if (r.status === 403 || r.status === 429) throw new Error("limit");
		if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
		return { json: JSON.parse(r.body.toString("utf8")), etag: r.headers.etag || null };
	}

	headers() {
		const h = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
		if (process.env.GITHUB_TOKEN) h.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
		return h;
	}

	// { repo, latest: { tag, name, date, url, prerelease }, recent: [...] } or { repo, error }
	async get(repo) {
		const c = this.cache.get(repo);
		if (c && c.pending) return c.data || c.error ? { repo, ...c.data, error: c.data ? undefined : c.error } : c.pending;
		if (c && Date.now() - c.at < (c.error && !c.data ? 15 * 60000 : TTL)) return { repo, ...c.data, error: c.data ? undefined : c.error };
		const pending = this.fetch(repo, c).then((r) => {
			// on errors (limit, network) the last known versions stay
			const next = r.error && c && c.data ? { at: Date.now() - TTL + 30 * 60000, data: c.data, etag: c.etag, error: r.error } : { at: Date.now(), ...r };
			this.cache.set(repo, next);
			if (!r.error) this.persist();
			return { repo, ...next.data, error: next.data ? undefined : next.error };
		});
		this.cache.set(repo, { ...(c || { at: 0 }), pending });
		return c && (c.data || c.error) ? { repo, ...c.data, error: c.error } : pending;
	}

	async fetch(repo, cached) {
		try {
			const res = await this.gh(`https://api.github.com/repos/${repo}/releases?per_page=6`, cached && cached.data && cached.etag);
			if (res.notModified) return { data: cached.data, etag: cached.etag };
			const list = res.json;
			let recent = list.filter((r) => !r.draft).map((r) => ({ tag: r.tag_name, name: r.name || r.tag_name, date: Date.parse(r.published_at || r.created_at), url: r.html_url, prerelease: !!r.prerelease }));
			if (!recent.length) {
				// projects that only tag (no GitHub releases)
				const tags = (await this.gh(`https://api.github.com/repos/${repo}/tags?per_page=3`)).json;
				recent = tags.map((x) => ({ tag: x.name, name: x.name, date: null, url: `https://github.com/${repo}/releases/tag/${encodeURIComponent(x.name)}`, prerelease: false }));
			}
			const stable = recent.filter((r) => !r.prerelease);
			return { data: { latest: stable[0] || recent[0] || null, recent }, etag: res.etag };
		} catch (err) {
			return { error: err.message === "limit" ? "GitHub limit reached – try later or set GITHUB_TOKEN" : err.message };
		}
	}

	// Release notes of one tag (Markdown from GitHub).
	async notes(repo, tag) {
		const r = (await this.gh(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`).catch((err) => {
			throw new Error(err.message === "limit" ? "GitHub limit reached – try later or set GITHUB_TOKEN" : err.message);
		})).json;
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
	// the image's own labels first: a container's copy can be stale after it was recreated
	const l = { ...c.labels, ...(c.imageLabels || {}) };
	const v = l["org.opencontainers.image.version"] || l["org.label-schema.version"] || (/version:-\s*(\S+)/.exec(l.build_version || "") || [])[1];
	if (v && v !== "latest") return String(v);
	// else the image's tag, when it names a full version ("grafana/grafana:13.2.4", not ":latest" or ":2")
	const tag = (/:([^:/@]+)(@|$)/.exec(c.image || "") || [])[1];
	return tag && /^v?\d+\.\d+/.test(tag) ? tag : null;
}

// Apps that tell their version without a login: where to ask, and where it is in the answer.
const VERSION_PROBES = {
	grafana: ["/api/health", (j) => j.version],
	prometheus: ["/api/v1/status/buildinfo", (j) => j.data && j.data.version],
	portainer: ["/api/status", (j) => j.Version],
	jellyfin: ["/System/Info/Public", (j) => j.Version],
	emby: ["/System/Info/Public", (j) => j.Version],
	gitea: ["/api/v1/version", (j) => j.version],
	immich: ["/api/server/version", (j) => (j && j.major !== undefined ? `${j.major}.${j.minor}.${j.patch}` : null)],
	navidrome: ["/rest/ping?f=json&v=1.16.1&c=homebento", (j) => j["subsonic-response"] && j["subsonic-response"].serverVersion],
	nextcloud: ["/status.php", (j) => j.versionstring]
};
// …and those that only tell it with their API key: Uptime Kuma in its /metrics
const KEYED_PROBES = {
	async uptimekuma({ url, secrets, request }) {
		if (!secrets.apiKey) return null;
		const r = await request(`${url}/metrics`, { headers: { Authorization: `Basic ${Buffer.from(`:${secrets.apiKey}`).toString("base64")}` }, timeout: 5000 });
		return r.status === 200 ? (/app_version\{[^}]*version="([^"]+)"/.exec(r.body.toString("utf8")) || [])[1] || null : null;
	}
};
// a service without a type set: which app it is, from its repository
const REPO_KIND = { "grafana/grafana": "grafana", "prometheus/prometheus": "prometheus", "portainer/portainer": "portainer", "jellyfin/jellyfin-packaging": "jellyfin", "go-gitea/gitea": "gitea", "immich-app/immich": "immich", "navidrome/navidrome": "navidrome", "nextcloud/server": "nextcloud", "louislam/uptime-kuma": "uptimekuma" };
const probed = new Map(); // service id → { at, v }

// The version a service says it runs (asked at most every 30 minutes), when its image doesn't say.
async function askedVersion(s, ctx, repo) {
	const kind = s && (s.kind || REPO_KIND[repo]);
	const probe = VERSION_PROBES[kind];
	const keyed = KEYED_PROBES[kind];
	if ((!probe && !keyed) || !s.url) return null;
	const c = probed.get(s.id);
	if (c && Date.now() - c.at < 30 * 60 * 1000) return c.v;
	let v = null;
	try {
		v = keyed ? await keyed(ctx) : probe[1](await ctx.json(`${ctx.url}${probe[0]}`, { timeout: 5000 })) || null;
	} catch {
		// no answer: unknown
	}
	probed.set(s.id, { at: Date.now(), v: v ? String(v) : null });
	return v ? String(v) : null;
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

// An image fixed to a version ("louislam/uptime-kuma:2.0.2") can't be updated by pulling its tag:
// the new version has to go into the compose file. Then: the line to write there.
function pinnedImage(image, latest) {
	const m = /^(.*):([^:/@]+)$/.exec(image || "");
	if (!m || !/^v?\d+\.\d+/.test(m[2]) || !latest) return null;
	let tag = String(latest).replace(/^release-/i, "");
	if (/^v/i.test(m[2]) && !/^v/i.test(tag)) tag = `v${tag}`;
	if (!/^v/i.test(m[2]) && /^v\d/i.test(tag)) tag = tag.slice(1);
	return `${m[1]}:${tag}`;
}

module.exports = { Releases, parseRepo, validRepo, KNOWN, runningVersion, askedVersion, sameVersion, pinnedImage };
