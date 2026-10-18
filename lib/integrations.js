"use strict";
// Content of services for their tiles: what Jellyfin plays, what Sonarr/Radarr bring next,
// what qBittorrent downloads, how MagicMirror is doing – and everything the plugins bring.
// Results are cached briefly so the dashboard never floods a service.
const { request, json } = require("./util");
const { UserError } = require("./errors");
const PLUGINS = require("./plugins");

const TTL = { magicmirror: 60000, jellyfin: 10000, sonarr: 5 * 60000, radarr: 5 * 60000, prowlarr: 5 * 60000, qbittorrent: 4000, mmmanager: 20000 };
const DAY = 24 * 3600 * 1000;

class Integrations {
	constructor(store) {
		this.store = store;
		this.cache = new Map(); // sid -> { at, data, error, pending }
		this.cookies = new Map(); // sid -> cookie for services with a login
	}

	// Cached data of a service: { data } or { error }.
	async data(s) {
		if (!s.kind || !(FETCH[s.kind] || PLUGINS[s.kind]) || !s.url) return null;
		const c = this.cache.get(s.id);
		const ttl = TTL[s.kind] || (PLUGINS[s.kind] && PLUGINS[s.kind].ttl) || 30000;
		if (c && Date.now() - c.at < ttl && !c.pending) return { data: c.data, error: c.error };
		if (c && c.pending) return c.pending;
		const pending = this.fetch(s).then((r) => {
			this.cache.set(s.id, { at: Date.now(), ...r });
			return r;
		});
		this.cache.set(s.id, { ...(c || { at: 0 }), pending });
		// show the last known data while the new one is loading
		return c && (c.data || c.error) ? { data: c.data, error: c.error } : pending;
	}

	async fetch(s, secrets) {
		try {
			if (!FETCH[s.kind] && PLUGINS[s.kind]) return { data: await PLUGINS[s.kind].fetch(this.ctx(s, secrets)) };
			return { data: await FETCH[s.kind].call(this, base(s.url), secrets || this.store.secretsOf(s.id), s) };
		} catch (err) {
			return { error: err.message };
		}
	}

	// What a plugin gets: the address, the logins, and request/json that honour "allow own certificate".
	ctx(s, secrets) {
		return { url: base(s.url), secrets: secrets || this.store.secretsOf(s.id), service: s, request: (u, o = {}) => request(u, { insecure: s.insecure, ...o }), json: (u, o = {}) => json(u, { insecure: s.insecure, ...o }) };
	}

	forget(sid) {
		this.cache.delete(sid);
		this.cookies.delete(sid);
	}

	// "Test connection" in the service form, with the logins just typed in (not saved yet).
	async test(s, secrets) {
		if (!s.kind || !(FETCH[s.kind] || PLUGINS[s.kind])) {
			const r = await request(s.url, { insecure: true, timeout: 8000, maxBytes: 100000 });
			if (!r.status) throw new UserError(r.error);
			return { ok: true, detail: `HTTP ${r.status} · ${r.ms} ms` };
		}
		this.cookies.delete(s.id);
		const r = await this.fetch(s, secrets);
		if (r.error) throw new UserError(r.error);
		return { ok: true };
	}

	// Poster or cover from Jellyfin, through the server (the API key stays here).
	async image(s, itemId) {
		let r;
		const arr = /^(movie|series)-(\d+)$/.exec(itemId);
		if (s.kind === "jellyfin" && /^[a-f0-9]{32}$/i.test(itemId)) r = await request(`${base(s.url)}/Items/${itemId}/Images/Primary?fillHeight=360&quality=85`, { headers: jfHeaders(this.store.secretsOf(s.id)), insecure: s.insecure, maxBytes: 3_000_000 });
		else if ((s.kind === "radarr" || s.kind === "sonarr") && arr) r = await request(`${base(s.url)}/api/v3/mediacover/${arr[2]}/poster-500.jpg`, { headers: { "X-Api-Key": need(this.store.secretsOf(s.id).apiKey, "API key") }, insecure: s.insecure, maxBytes: 3_000_000 });
		else throw new UserError("Not found");
		if (r.status !== 200) throw new UserError("Not found");
		return { type: r.headers["content-type"] || "image/jpeg", body: r.body };
	}

	// Everything about one movie or show, for the info card: Jellyfin item, Radarr movie, Sonarr series.
	async media(s, ref, jellyfin) {
		const url = base(s.url);
		const sec = this.store.secretsOf(s.id);
		let info;
		if (s.kind === "jellyfin" && /^[a-f0-9]{32}$/i.test(ref)) {
			const r = await json(`${url}/Items?ids=${ref}&Recursive=true&Fields=Overview,Genres,CommunityRating,OfficialRating,ProductionYear,RunTimeTicks,ChildCount,Studios`, { headers: jfHeaders(sec), insecure: s.insecure });
			const it = r.Items && r.Items[0];
			if (!it) throw new UserError("Not found");
			info = { title: it.Name, year: it.ProductionYear || null, overview: it.Overview || "", genres: it.Genres || [], rating: it.CommunityRating ? Math.round(it.CommunityRating * 10) / 10 : null, certification: it.OfficialRating || null, runtime: it.RunTimeTicks ? Math.round(it.RunTimeTicks / 600000000) : null, type: it.Type === "Movie" ? "movie" : "series", seasons: it.Type === "Series" ? it.ChildCount || null : null, links: [{ kind: "jellyfin", name: s.name, url: `${url}/web/#/details?id=${it.Id}` }] };
		} else {
			const m = /^(movie|series)-(\d+)$/.exec(ref);
			if (!m || (m[1] === "movie" && s.kind !== "radarr") || (m[1] === "series" && s.kind !== "sonarr")) throw new UserError("Not found");
			const h = { headers: { "X-Api-Key": need(sec.apiKey, "API key") }, insecure: s.insecure };
			const x = await json(`${url}/api/v3/${m[1]}/${m[2]}`, h);
			const ratings = x.ratings || {};
			const rating = ratings.value ?? (ratings.imdb && ratings.imdb.value) ?? (ratings.tmdb && ratings.tmdb.value) ?? null;
			const st = x.statistics || {};
			info = {
				title: x.title,
				year: x.year || null,
				overview: x.overview || "",
				genres: x.genres || [],
				rating: rating ? Math.round(rating * 10) / 10 : null,
				certification: x.certification || null,
				runtime: x.runtime || null,
				type: m[1],
				network: x.network || x.studio || null,
				status: x.status || null,
				downloaded: m[1] === "movie" ? !!x.hasFile : null,
				size: x.sizeOnDisk || st.sizeOnDisk || null,
				episodes: m[1] === "series" ? { have: st.episodeFileCount ?? null, total: st.episodeCount ?? st.totalEpisodeCount ?? null, seasons: st.seasonCount ?? null } : null,
				links: [{ kind: s.kind, name: s.name, url: `${url}/${m[1] === "movie" ? "movie" : "series"}/${x.titleSlug || x.tmdbId || m[2]}` }]
			};
		}
		// the same title in Jellyfin, to watch it right away
		if (jellyfin && s.kind !== "jellyfin" && info.title) {
			const jsec = this.store.secretsOf(jellyfin.id);
			const r = await json(`${base(jellyfin.url)}/Items?searchTerm=${encodeURIComponent(info.title)}&IncludeItemTypes=${info.type === "movie" ? "Movie" : "Series"}&Recursive=true&Limit=5&Fields=ProductionYear`, { headers: jfHeaders(jsec), insecure: jellyfin.insecure }).catch(() => null);
			const hit = r && (r.Items || []).find((it) => it.Name.toLowerCase() === info.title.toLowerCase() && (!info.year || !it.ProductionYear || Math.abs(it.ProductionYear - info.year) <= 1));
			if (hit) info.links.unshift({ kind: "jellyfin", name: jellyfin.name, url: `${base(jellyfin.url)}/web/#/details?id=${hit.Id}` });
		}
		return info;
	}

	// Actions offered by an integration (MagicMirror: restart through its manager).
	async action(s, what, body = {}) {
		// a plugin's own actions (e.g. switching a plug)
		const p = PLUGINS[s.kind];
		if (p && typeof p.action === "function" && what !== "restart") {
			try {
				const r = await p.action({ ...this.ctx(s), what, body });
				this.cache.delete(s.id);
				return r || { ok: true };
			} catch (err) {
				throw new UserError(err.message);
			}
		}
		if (s.kind === "mmmanager" && what === "restart") {
			await this.mm(s, "POST", "/api/restart");
			this.cache.delete(s.id);
			return { ok: true };
		}
		throw new UserError("Unknown action");
	}

	async mm(s, method, apiPath) {
		const url = base(s.url);
		const send = () => json(url + apiPath, { method, insecure: s.insecure, headers: this.cookies.get(s.id) ? { Cookie: this.cookies.get(s.id) } : {}, body: method === "POST" ? {} : undefined });
		try {
			return await send();
		} catch (err) {
			const pw = this.store.secretsOf(s.id).password;
			if (!/denied/i.test(err.message) || !pw) throw err;
			const r = await request(`${url}/api/login`, { method: "POST", body: { password: pw }, headers: { "Content-Type": "application/json" }, insecure: s.insecure });
			const cookie = String((r.headers && r.headers["set-cookie"]) || "").split(";")[0];
			if (r.status !== 200 || !cookie) throw new Error("Login at the manager failed (check the password)");
			this.cookies.set(s.id, cookie);
			return send();
		}
	}
}

const base = (url) => url.replace(/\/+$/, "");

// Health warnings, download queue and library size of Sonarr/Radarr.
async function arrExtras(url, v, h, what) {
	const include = what === "series" ? "includeSeries=true&includeEpisode=true" : "includeMovie=true";
	const [health, queue, lib, wanted, history, queued] = await Promise.all([
		json(`${url}/api/${v}/health`, h).catch(() => []),
		json(`${url}/api/${v}/queue/status`, h).catch(() => null),
		json(`${url}/api/${v}/${what}`, h).catch(() => null),
		json(`${url}/api/${v}/wanted/missing?page=1&pageSize=6&monitored=true&${include}`, h).catch(() => null),
		// eventType 3 = imported after download
		json(`${url}/api/${v}/history?page=1&pageSize=8&sortKey=date&sortDirection=descending&eventType=3&${include}`, h).catch(() => null),
		// what's downloading right now, with progress
		json(`${url}/api/${v}/queue?page=1&pageSize=6&${include}`, h).catch(() => null)
	]);
	const sub = (r) => (what === "series" ? (r.episode ? { season: r.episode.seasonNumber, number: r.episode.episodeNumber, name: r.episode.title } : null) : r.movie ? { year: r.movie.year } : null);
	const titleOf = (r) => (what === "series" ? (r.series && r.series.title) || r.title : (r.movie && r.movie.title) || r.title);
	const queueItems = ((queued && queued.records) || []).map((r) => ({
		title: titleOf(r),
		sub: sub(r),
		progress: r.size ? Math.max(0, Math.min(1, 1 - (r.sizeleft || 0) / r.size)) : null,
		state: r.trackedDownloadState || r.status || null,
		problem: r.trackedDownloadStatus && r.trackedDownloadStatus !== "ok" ? ((r.statusMessages || [])[0] || {}).title || r.errorMessage || r.trackedDownloadStatus : null,
		left: r.timeleft || null
	}));
	// missing: episodes (with the series) or movies
	const missing = ((wanted && wanted.records) || []).map((r) => (what === "series" ? { title: (r.series && r.series.title) || r.title, sub: { season: r.seasonNumber, number: r.episodeNumber, name: r.title }, at: r.airDateUtc ? Date.parse(r.airDateUtc) : null } : { title: r.title, sub: { year: r.year }, at: null }));
	const imported = ((history && history.records) || []).map((r) =>
		what === "series"
			? { at: Date.parse(r.date), title: (r.series && r.series.title) || r.sourceTitle, sub: r.episode ? { season: r.episode.seasonNumber, number: r.episode.episodeNumber, name: r.episode.title } : null, ref: r.seriesId ? `series-${r.seriesId}` : null }
			: { at: Date.parse(r.date), title: (r.movie && r.movie.title) || r.sourceTitle, sub: r.movie ? { year: r.movie.year } : null, ref: r.movieId ? `movie-${r.movieId}` : null }
	);
	return {
		warnings: health.filter((x) => x.type === "warning" || x.type === "error").map((x) => x.message),
		queue: queue ? queue.totalCount ?? queue.count ?? 0 : null,
		library: Array.isArray(lib) ? lib.length : null,
		wanted: wanted && typeof wanted.totalRecords === "number" ? wanted.totalRecords : null,
		imported,
		queueItems,
		missing
	};
}
const need = (v, what) => {
	if (!v) throw new Error(`${what} missing`);
	return v;
};
// Newer Jellyfin versions only accept the key in the Authorization header (not X-Emby-Token).
const jfHeaders = (sec) => ({ Authorization: `MediaBrowser Client="HomeBento", Device="HomeBento", DeviceId="homebento", Version="1", Token="${need(sec.apiKey, "API key")}"` });

const FETCH = {
	async jellyfin(url, sec, s) {
		const h = { headers: jfHeaders(sec), insecure: s.insecure };
		const [sessions, users, counts] = await Promise.all([json(`${url}/Sessions?ActiveWithinSeconds=900`, h), json(`${url}/Users`, h), json(`${url}/Items/Counts`, h).catch(() => null)]);
		const now = sessions
			.filter((x) => x.NowPlayingItem)
			.map((x) => {
				const it = x.NowPlayingItem;
				const ps = x.PlayState || {};
				return {
					user: x.UserName,
					device: x.DeviceName || x.Client,
					title: it.SeriesName || it.Name,
					episode: it.Type === "Episode" ? { season: it.ParentIndexNumber, number: it.IndexNumber, name: it.Name } : null,
					year: it.ProductionYear || null,
					progress: it.RunTimeTicks ? Math.min(1, (ps.PositionTicks || 0) / it.RunTimeTicks) : null,
					paused: !!ps.IsPaused,
					image: it.SeriesId || it.Id
				};
			});
		const admin = users.find((u) => u.Policy && u.Policy.IsAdministrator) || users[0];
		let recent = [];
		if (admin) {
			// /Items/Latest?userId= in newer versions, /Users/{id}/Items/Latest before
			const q = "Limit=12&GroupItems=true&IncludeItemTypes=Movie,Episode,Series";
			const items = await json(`${url}/Items/Latest?userId=${admin.Id}&${q}`, h).catch(() => json(`${url}/Users/${admin.Id}/Items/Latest?${q}`, h).catch(() => []));
			recent = items.map((it) => ({ id: it.SeriesId || it.Id, title: it.SeriesName || it.Name, type: it.Type === "Movie" ? "movie" : "series", year: it.ProductionYear || null }));
			recent = recent.filter((r, i) => recent.findIndex((x) => x.id === r.id) === i);
		}
		return { now, sessions: sessions.length, recent, counts: counts ? { movies: counts.MovieCount, series: counts.SeriesCount, episodes: counts.EpisodeCount } : null };
	},

	async sonarr(url, sec, s) {
		const start = new Date(Date.now() - DAY / 2).toISOString();
		const end = new Date(Date.now() + 14 * DAY).toISOString();
		const h = { headers: { "X-Api-Key": need(sec.apiKey, "API key") }, insecure: s.insecure };
		const [list, extra] = await Promise.all([json(`${url}/api/v3/calendar?start=${start}&end=${end}&includeSeries=true`, h), arrExtras(url, "v3", h, "series")]);
		return {
			...extra,
			items: list
				.filter((e) => e.airDateUtc)
				.map((e) => ({ at: Date.parse(e.airDateUtc), title: (e.series && e.series.title) || e.title, sub: { season: e.seasonNumber, number: e.episodeNumber, name: e.title }, has: !!e.hasFile, src: "sonarr", ref: e.seriesId ? `series-${e.seriesId}` : null }))
				.sort((a, b) => a.at - b.at)
		};
	},

	async radarr(url, sec, s) {
		const from = Date.now() - DAY / 2;
		const start = new Date(from).toISOString();
		const end = new Date(Date.now() + 45 * DAY).toISOString();
		const h = { headers: { "X-Api-Key": need(sec.apiKey, "API key") }, insecure: s.insecure };
		const [list, extra] = await Promise.all([json(`${url}/api/v3/calendar?start=${start}&end=${end}`, h), arrExtras(url, "v3", h, "movie")]);
		const items = [];
		for (const m of list) {
			// the next release of the movie inside the window
			const rel = [["digital", m.digitalRelease], ["physical", m.physicalRelease], ["cinema", m.inCinemas]]
				.map(([k, d]) => [k, Date.parse(d)])
				.filter(([, t]) => t >= from)
				.sort((a, b) => a[1] - b[1])[0];
			if (rel) items.push({ at: rel[1], title: m.title, sub: { release: rel[0], year: m.year }, has: !!m.hasFile, src: "radarr", ref: m.id ? `movie-${m.id}` : null });
		}
		return { ...extra, items: items.sort((a, b) => a.at - b.at) };
	},

	async prowlarr(url, sec, s) {
		const h = { headers: { "X-Api-Key": need(sec.apiKey, "API key") }, insecure: s.insecure };
		const [indexers, health, status] = await Promise.all([json(`${url}/api/v1/indexer`, h), json(`${url}/api/v1/health`, h).catch(() => []), json(`${url}/api/v1/indexerstatus`, h).catch(() => [])]);
		const down = new Map(status.filter((x) => x.disabledTill && Date.parse(x.disabledTill) > Date.now()).map((x) => [x.indexerId, Date.parse(x.disabledTill)]));
		// every indexer with its state: on, off, or failing (until when)
		const list = indexers.map((i) => ({ name: i.name, enabled: !!i.enable, failingUntil: down.get(i.id) || null, protocol: i.protocol || null })).sort((a, b) => !!b.failingUntil - !!a.failingUntil || b.enabled - a.enabled || a.name.localeCompare(b.name));
		return { indexers: indexers.length, enabled: indexers.filter((i) => i.enable).length, failing: down.size, warnings: health.filter((x) => x.type === "warning" || x.type === "error").map((x) => x.message), list };
	},

	async qbittorrent(url, sec, s) {
		const get = async (p) => {
			const headers = { Referer: url, ...(this.cookies.get(s.id) ? { Cookie: this.cookies.get(s.id) } : {}) };
			return json(url + p, { headers, insecure: s.insecure });
		};
		let transfer;
		try {
			transfer = await get("/api/v2/transfer/info");
		} catch (err) {
			if (!/denied/i.test(err.message)) throw err;
			if (!sec.username) throw new Error("Login needed (user and password)");
			const body = `username=${encodeURIComponent(sec.username)}&password=${encodeURIComponent(sec.password || "")}`;
			const r = await request(`${url}/api/v2/auth/login`, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: url, Origin: url }, insecure: s.insecure });
			// the session cookie is "SID" up to qBittorrent 4, "QBT_SID_<port>" from version 5
			const cookie = [].concat((r.headers && r.headers["set-cookie"]) || []).map((c) => c.split(";")[0]).find((c) => /^(QBT_)?SID[^=]*=/.test(c));
			// success: 200 "Ok." (older) or 204 (newer), always with the session cookie;
			// wrong login: 200 "Fails." (older) or 401 (newer)
			if (r.status === 403) throw new Error("qBittorrent blocks this address after too many failed logins – wait a while");
			if (r.status === 401 || /Fails/i.test(r.body.toString("utf8"))) throw new Error("Login failed (check user and password)");
			if (r.status < 200 || r.status >= 300 || !cookie) throw new Error(`Login failed (HTTP ${r.status}${cookie ? "" : ", no session cookie"})`);
			this.cookies.set(s.id, cookie);
			transfer = await get("/api/v2/transfer/info");
		}
		const [torrents, seeding] = await Promise.all([get("/api/v2/torrents/info?filter=downloading&sort=progress&reverse=true"), get("/api/v2/torrents/info?filter=seeding").catch(() => [])]);
		return {
			downloading: torrents.length,
			seeding: seeding.length,
			down: transfer.dl_info_speed,
			up: transfer.up_info_speed,
			torrents: torrents.slice(0, 8).map((t) => ({ name: t.name, progress: t.progress, speed: t.dlspeed, eta: t.eta >= 8640000 ? null : t.eta, state: t.state }))
		};
	},

	// MagicMirror itself: /version, /startup and its configuration (the modules) at /config/
	async magicmirror(url, sec, s) {
		const text = async (p) => {
			const r = await request(url + p, { insecure: s.insecure, timeout: 8000 });
			if (r.status !== 200) throw new Error(`HTTP ${r.status || r.error}`);
			return r.body.toString("utf8").trim();
		};
		const [version, startup, config] = await Promise.all([text("/version").catch(() => null), text("/startup").catch(() => null), json(`${url}/config/`, { insecure: s.insecure }).catch(() => null)]);
		if (!version && !config) throw new Error("No answer from MagicMirror");
		const mods = config && Array.isArray(config.modules) ? config.modules : [];
		const started = startup ? Date.parse(startup.replace(/^"|"$/g, "")) : null;
		return {
			version: version && /^[\d.]+/.test(version) ? version : null,
			started: started || null,
			modules: mods.filter((m) => !m.disabled).length,
			total: mods.length,
			active: mods.filter((m) => !m.disabled).map((m) => ({ name: m.module, position: m.position || null })),
			language: config ? config.language || null : null
		};
	},

	async mmmanager(url, sec, s) {
		const st = await this.mm(s, "GET", "/api/status");
		return { process: st.process ? st.process.status : null, restarts: st.process ? st.process.restarts : null, up: !!(st.http && st.http.up), version: st.version || null };
	}
};

module.exports = { Integrations };
