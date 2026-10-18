"use strict";
// Content of services for their tiles: what Jellyfin plays, what Sonarr/Radarr bring next,
// what qBittorrent downloads, what the solar plant produces, how MagicMirror is doing.
// Results are cached briefly so the dashboard never floods a service.
const { request, json } = require("./util");
const { UserError } = require("./errors");

const TTL = { jellyfin: 10000, sonarr: 5 * 60000, radarr: 5 * 60000, prowlarr: 5 * 60000, qbittorrent: 4000, solar: 15000, mmmanager: 20000 };
const DAY = 24 * 3600 * 1000;

class Integrations {
	constructor(store) {
		this.store = store;
		this.cache = new Map(); // sid -> { at, data, error, pending }
		this.cookies = new Map(); // sid -> cookie for services with a login
	}

	// Cached data of a service: { data } or { error }.
	async data(s) {
		if (!s.kind || !FETCH[s.kind] || !s.url) return null;
		const c = this.cache.get(s.id);
		const ttl = TTL[s.kind] || 30000;
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
			return { data: await FETCH[s.kind].call(this, base(s.url), secrets || this.store.secretsOf(s.id), s) };
		} catch (err) {
			return { error: err.message };
		}
	}

	forget(sid) {
		this.cache.delete(sid);
		this.cookies.delete(sid);
	}

	// "Test connection" in the service form, with the logins just typed in (not saved yet).
	async test(s, secrets) {
		if (!s.kind || !FETCH[s.kind]) {
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
		if (s.kind !== "jellyfin" || !/^[a-f0-9]{32}$/i.test(itemId)) throw new UserError("Not found");
		const r = await request(`${base(s.url)}/Items/${itemId}/Images/Primary?fillHeight=360&quality=85`, { headers: jfHeaders(this.store.secretsOf(s.id)), insecure: s.insecure, maxBytes: 3_000_000 });
		if (r.status !== 200) throw new UserError("Not found");
		return { type: r.headers["content-type"] || "image/jpeg", body: r.body };
	}

	// Actions offered by an integration (MagicMirror: restart through its manager).
	async action(s, what) {
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
	const [health, queue, lib] = await Promise.all([
		json(`${url}/api/${v}/health`, h).catch(() => []),
		json(`${url}/api/${v}/queue/status`, h).catch(() => null),
		json(`${url}/api/${v}/${what}`, h).catch(() => null)
	]);
	return {
		warnings: health.filter((x) => x.type === "warning" || x.type === "error").map((x) => x.message),
		queue: queue ? queue.totalCount ?? queue.count ?? 0 : null,
		library: Array.isArray(lib) ? lib.length : null
	};
}
const need = (v, what) => {
	if (!v) throw new Error(`${what} missing`);
	return v;
};
const jfHeaders = (sec) => ({ "X-Emby-Token": need(sec.apiKey, "API key") });

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
			const items = await json(`${url}/Users/${admin.Id}/Items/Latest?Limit=12&GroupItems=true&IncludeItemTypes=Movie,Episode,Series`, h).catch(() => []);
			recent = items.map((it) => ({ id: it.SeriesId || it.Id, title: it.SeriesName || it.Name, type: it.Type === "Movie" ? "movie" : "series", year: it.ProductionYear || null }));
			recent = recent.filter((r, i) => recent.findIndex((x) => x.id === r.id) === i);
		}
		return { now, recent, counts: counts ? { movies: counts.MovieCount, series: counts.SeriesCount, episodes: counts.EpisodeCount } : null };
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
				.map((e) => ({ at: Date.parse(e.airDateUtc), title: (e.series && e.series.title) || e.title, sub: { season: e.seasonNumber, number: e.episodeNumber, name: e.title }, has: !!e.hasFile, src: "sonarr" }))
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
			if (rel) items.push({ at: rel[1], title: m.title, sub: { release: rel[0], year: m.year }, has: !!m.hasFile, src: "radarr" });
		}
		return { ...extra, items: items.sort((a, b) => a.at - b.at) };
	},

	async prowlarr(url, sec, s) {
		const h = { headers: { "X-Api-Key": need(sec.apiKey, "API key") }, insecure: s.insecure };
		const [indexers, health] = await Promise.all([json(`${url}/api/v1/indexer`, h), json(`${url}/api/v1/health`, h).catch(() => [])]);
		return { indexers: indexers.length, enabled: indexers.filter((i) => i.enable).length, warnings: health.filter((x) => x.type === "warning" || x.type === "error").map((x) => x.message) };
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
			if (r.status === 403) throw new Error("qBittorrent blocks this address after too many failed logins – wait a while");
			if (r.status !== 200 || !cookie) throw new Error("Login failed (check user and password)");
			this.cookies.set(s.id, cookie);
			transfer = await get("/api/v2/transfer/info");
		}
		const torrents = await get("/api/v2/torrents/info?filter=downloading&sort=progress&reverse=true");
		return {
			down: transfer.dl_info_speed,
			up: transfer.up_info_speed,
			torrents: torrents.slice(0, 8).map((t) => ({ name: t.name, progress: t.progress, speed: t.dlspeed, eta: t.eta >= 8640000 ? null : t.eta, state: t.state }))
		};
	},

	// Joël's solar dashboard (github: solar-dashboard): /api/state and the day curve.
	async solar(url, sec, s) {
		const st = await json(`${url}/api/state`, { insecure: s.insecure });
		const d = new Date();
		const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const curve = await json(`${url}/api/day?date=${day}`, { insecure: s.insecure }).catch(() => null);
		const live = st.live || {};
		// one point every 15 minutes is plenty for a tile
		const points = curve && Array.isArray(curve.points) ? curve.points.filter((p) => p.m % 15 === 0).map((p) => [p.m, p.pv || 0]) : [];
		return {
			pv: live.pv ?? null,
			use: live.cons ?? null,
			battery: live.bat && live.bat.soc !== undefined ? live.bat.soc : null,
			kwp: st.kwp || live.kwp || null,
			todayWh: st.today ? st.today.yieldWh : null,
			points,
			error: st.error || null
		};
	},

	async mmmanager(url, sec, s) {
		const st = await this.mm(s, "GET", "/api/status");
		return { process: st.process ? st.process.status : null, restarts: st.process ? st.process.restarts : null, up: !!(st.http && st.http.up), version: st.version || null };
	}
};

module.exports = { Integrations };
