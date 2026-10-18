"use strict";
// Market data for the tiles without an API key: stocks/ETFs/indices (Yahoo Finance chart endpoint),
// exchange rates (Frankfurter, ECB reference rates) and crypto (CoinGecko).
// Every value is cached; when a source fails the last good value is kept.
//
// Fallback if Yahoo blocks (HTTP 429 or a consent/crumb wall): stooq.com serves a CSV quote without a key,
// https://stooq.com/q/l/?s=<sym>&f=sd2t2ohlcv&h&e=csv → "Symbol,Date,Time,Open,High,Low,Close,Volume".
// It has no previous close and no intraday series and uses its own symbol suffixes, so it would only give
// price and day change (close - open), no sparkline.
const { request, json } = require("./util");

// Base URLs, replaceable (e.g. in tests or behind a proxy).
const api = {
	yahoo: "https://query1.finance.yahoo.com/v8/finance/chart/",
	frankfurter: "https://api.frankfurter.dev/v1/",
	coingecko: "https://api.coingecko.com/api/v3/"
};

// A plain browser User-Agent: Yahoo answers 429 to unknown agents (and, in tests, more often to long ones).
const UA = "Mozilla/5.0";

// Cache per key; on an error the last good value is kept, otherwise { error }.
class Cache {
	constructor(ttl) {
		this.ttl = ttl;
		this.map = new Map();
	}
	async get(key, load) {
		const c = this.map.get(key);
		if (c && Date.now() - c.at < this.ttl) return c.value;
		if (c && c.pending) return c.value !== undefined ? c.value : c.pending;
		const pending = load().then(
			(value) => (this.map.set(key, { at: Date.now(), value }), value),
			(err) => {
				const value = c && c.value && !c.value.error ? c.value : { error: err.message };
				this.map.set(key, { at: Date.now() - this.ttl + 60000, value }); // retry after a minute
				return value;
			}
		);
		this.map.set(key, { ...(c || {}), pending });
		return c && c.value !== undefined ? c.value : pending;
	}
	clear() {
		this.map.clear();
	}
}

const quoteCache = new Cache(5 * 60000);
const fxCache = new Cache(60 * 60000);
const cryptoCache = new Cache(5 * 60000);

const round = (v, digits = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** digits) / 10 ** digits : null);

// Yahoo-style symbols: NESN.SW, ^SSMI, CHFEUR=X, BTC-USD
const validSymbol = (s) => typeof s === "string" && /^[A-Z0-9.^=-]{1,20}$/.test(s);
const validCurrency = (s) => typeof s === "string" && /^[A-Z]{3}$/.test(s);
const validCoin = (s) => typeof s === "string" && /^[a-z0-9-]{1,60}$/.test(s);

// ---------- stocks / ETFs / indices ----------

// Pre/regular/post from the trading periods of the answer (the chart endpoint has no marketState).
function marketState(period, now = Date.now()) {
	if (!period) return null;
	const s = now / 1000;
	const inside = (p) => p && s >= p.start && s < p.end;
	if (inside(period.regular)) return "REGULAR";
	if (inside(period.pre)) return "PRE";
	if (inside(period.post)) return "POST";
	return "CLOSED";
}

// Answer of /v8/finance/chart/<symbol> → quote
function parseChart(body, symbol, now = Date.now()) {
	const chart = body && body.chart;
	if (!chart) throw new Error("Unexpected answer");
	if (chart.error) throw new Error(chart.error.description || chart.error.code || "Unknown symbol");
	const r = chart.result && chart.result[0];
	if (!r || !r.meta) throw new Error("No data");
	const m = r.meta;
	const closes = (((r.indicators || {}).quote || [])[0] || {}).close || [];
	const spark = closes.filter((v) => Number.isFinite(v));
	const price = Number.isFinite(m.regularMarketPrice) ? m.regularMarketPrice : spark[spark.length - 1];
	if (!Number.isFinite(price)) throw new Error("No price");
	const prev = Number.isFinite(m.previousClose) ? m.previousClose : m.chartPreviousClose;
	const change = Number.isFinite(prev) ? price - prev : null;
	return {
		symbol: m.symbol || symbol,
		name: m.shortName || m.longName || m.symbol || symbol,
		price,
		currency: m.currency || null,
		change: round(change, 4),
		changePct: change !== null && prev ? round((change / prev) * 100) : null,
		spark,
		marketState: marketState(m.currentTradingPeriod, now)
	};
}

async function quote(symbol) {
	const r = await request(`${api.yahoo}${encodeURIComponent(symbol)}?range=1d&interval=30m`, { headers: { "User-Agent": UA, Accept: "application/json" }, timeout: 10000 });
	if (!r.status) throw new Error(r.error);
	if (r.status === 429) throw new Error("Rate limited by Yahoo");
	let body;
	try {
		body = JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error(r.status >= 400 ? `HTTP ${r.status}` : "Unexpected answer (not JSON)");
	}
	return parseChart(body, symbol); // 404 carries { chart: { error } } with a description
}

// [symbol] → [{ symbol, name, price, currency, change, changePct, spark, marketState, error? }]
async function quotes(symbols) {
	return Promise.all(
		(symbols || []).map(async (raw) => {
			const symbol = String(raw).trim().toUpperCase();
			if (!validSymbol(symbol)) return { symbol, error: "Invalid symbol" };
			const v = await quoteCache.get(symbol, () => quote(symbol));
			return v.error ? { symbol, error: v.error } : v;
		})
	);
}

// ---------- exchange rates ----------

// latest + previous business day (Frankfurter answers) → [{ pair, rate, changePct, date }]
function parseFx(latest, previous, base, targets) {
	if (!latest || !latest.rates) throw new Error("Unexpected answer");
	const prev = (previous && previous.rates) || {};
	return targets.map((t) => {
		const rate = latest.rates[t];
		if (!Number.isFinite(rate)) return { pair: `${base}/${t}`, error: "Unknown currency" };
		const p = prev[t];
		return { pair: `${base}/${t}`, rate, changePct: Number.isFinite(p) && p ? round(((rate - p) / p) * 100) : null, date: latest.date || null };
	});
}

async function fx(base = "CHF", targets = ["EUR", "USD"]) {
	base = String(base).toUpperCase();
	targets = [].concat(targets).map((t) => String(t).trim().toUpperCase()).filter((t) => t && t !== base);
	if (!validCurrency(base) || !targets.length || !targets.every(validCurrency)) throw new Error("Invalid currency");
	const v = await fxCache.get(`${base}:${targets.join(",")}`, async () => {
		const q = `from=${base}&to=${targets.join(",")}`;
		const latest = await json(`${api.frankfurter}latest?${q}`, { timeout: 10000, redirects: 2 });
		// the day before the latest date; Frankfurter answers with the last business day on or before it
		const before = new Date(Date.parse(latest.date) - 86400000).toISOString().slice(0, 10);
		const previous = await json(`${api.frankfurter}${before}?${q}`, { timeout: 10000, redirects: 2 }).catch(() => null);
		return parseFx(latest, previous, base, targets);
	});
	if (v.error) throw new Error(v.error);
	return v;
}

// ---------- crypto ----------

// CoinGecko /simple/price answer → [{ id, price, changePct }]
function parseCrypto(body, ids, vs = "chf") {
	if (!body || typeof body !== "object") throw new Error("Unexpected answer");
	return ids.map((id) => {
		const c = body[id];
		if (!c || !Number.isFinite(c[vs])) return { id, error: "Unknown coin" };
		return { id, price: c[vs], changePct: round(c[`${vs}_24h_change`]) };
	});
}

async function crypto(ids, vs = "chf") {
	ids = [].concat(ids || []).map((id) => String(id).trim().toLowerCase()).filter(Boolean);
	vs = String(vs).toLowerCase();
	if (!ids.length || !ids.every(validCoin) || !/^[a-z]{3,5}$/.test(vs)) throw new Error("Invalid coin or currency");
	const v = await cryptoCache.get(`${vs}:${ids.join(",")}`, async () => {
		const body = await json(`${api.coingecko}simple/price?ids=${ids.join(",")}&vs_currencies=${vs}&include_24hr_change=true`, { timeout: 10000, headers: { "User-Agent": UA } });
		return parseCrypto(body, ids, vs);
	});
	if (v.error) throw new Error(v.error);
	return v;
}

// Empties all caches (tests, settings changes).
const clearCache = () => [quoteCache, fxCache, cryptoCache].forEach((c) => c.clear());

module.exports = { quotes, fx, crypto, validSymbol, validCurrency, validCoin, parseChart, parseFx, parseCrypto, marketState, clearCache, api };
