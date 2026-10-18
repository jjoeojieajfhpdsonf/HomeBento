"use strict";
// Parsers with fixed sample answers of each API, plus fx()/crypto()/quotes() against a local fake server.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const markets = require("../lib/markets");
const { parseChart, parseFx, parseCrypto, validSymbol, marketState } = markets;

// Shape of https://query1.finance.yahoo.com/v8/finance/chart/NESN.SW?range=1d&interval=30m (shortened)
const T0 = 1760598000; // 2025-10-16 07:00 UTC
const period = { pre: { start: T0 - 3600, end: T0 }, regular: { start: T0, end: T0 + 30600 }, post: { start: T0 + 30600, end: T0 + 34200 } };
const CHART = {
	chart: {
		result: [
			{
				meta: { currency: "CHF", symbol: "NESN.SW", exchangeName: "EBS", instrumentType: "EQUITY", shortName: "NESTLE N", longName: "Nestlé S.A.", regularMarketPrice: 80.5, chartPreviousClose: 79.8, previousClose: 80, currentTradingPeriod: period },
				timestamp: [T0, T0 + 1800, T0 + 3600, T0 + 5400],
				indicators: { quote: [{ open: [80, 80.1, 80.3, 80.4], close: [80.1, null, 80.4, 80.5], high: [], low: [], volume: [] }] }
			}
		],
		error: null
	}
};
const CHART_404 = { chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } };

test("validSymbol", () => {
	for (const s of ["NESN.SW", "^SSMI", "CHFEUR=X", "BTC-USD", "AAPL"]) assert.ok(validSymbol(s), s);
	for (const s of ["nesn.sw", "A B", "X/Y", "", "A;rm", "ABCDEFGHIJKLMNOPQRSTU", 5]) assert.equal(validSymbol(s), false, String(s));
});

test("parseChart", () => {
	const q = parseChart(CHART, "NESN.SW", (T0 + 100) * 1000);
	assert.deepEqual(q, { symbol: "NESN.SW", name: "NESTLE N", price: 80.5, currency: "CHF", change: 0.5, changePct: 0.63, spark: [80.1, 80.4, 80.5], marketState: "REGULAR" });
	assert.equal(parseChart(CHART, "NESN.SW", (T0 - 100) * 1000).marketState, "PRE");
	assert.equal(parseChart(CHART, "NESN.SW", (T0 + 32000) * 1000).marketState, "POST");
	assert.equal(parseChart(CHART, "NESN.SW", (T0 + 90000) * 1000).marketState, "CLOSED");
	assert.equal(marketState(undefined), null);
	// without previousClose: chartPreviousClose
	const noPrev = structuredClone(CHART);
	delete noPrev.chart.result[0].meta.previousClose;
	assert.equal(parseChart(noPrev, "NESN.SW").change, 0.7);
	assert.throws(() => parseChart(CHART_404, "XX"), /No data found/);
	assert.throws(() => parseChart({}, "XX"), /Unexpected/);
});

// Shapes of https://api.frankfurter.dev/v1/latest?from=CHF&to=EUR,USD and /v1/2026-10-15?...
const FX_LATEST = { amount: 1.0, base: "CHF", date: "2026-10-16", rates: { EUR: 1.0785, USD: 1.2137 } };
const FX_PREV = { amount: 1.0, base: "CHF", date: "2026-10-15", rates: { EUR: 1.08, USD: 1.2 } };

test("parseFx", () => {
	assert.deepEqual(parseFx(FX_LATEST, FX_PREV, "CHF", ["EUR", "USD", "GBP"]), [
		{ pair: "CHF/EUR", rate: 1.0785, changePct: -0.14, date: "2026-10-16" },
		{ pair: "CHF/USD", rate: 1.2137, changePct: 1.14, date: "2026-10-16" },
		{ pair: "CHF/GBP", error: "Unknown currency" }
	]);
	assert.equal(parseFx(FX_LATEST, null, "CHF", ["EUR"])[0].changePct, null);
});

// Shape of https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=chf&include_24hr_change=true
const COINS = { bitcoin: { chf: 67672, chf_24h_change: 0.8308409778799023 }, ethereum: { chf: 1993.72, chf_24h_change: -0.34085809101644804 } };

test("parseCrypto", () => {
	assert.deepEqual(parseCrypto(COINS, ["bitcoin", "ethereum", "nope"], "chf"), [
		{ id: "bitcoin", price: 67672, changePct: 0.83 },
		{ id: "ethereum", price: 1993.72, changePct: -0.34 },
		{ id: "nope", error: "Unknown coin" }
	]);
});

test("fx(), crypto() and quotes() against a fake server", async (t) => {
	const seen = [];
	const server = http.createServer((req, res) => {
		seen.push(req.url);
		const send = (status, body) => (res.writeHead(status, { "Content-Type": "application/json" }), res.end(JSON.stringify(body)));
		if (req.url === "/fx/latest?from=CHF&to=EUR,USD") return send(200, FX_LATEST);
		if (req.url === "/fx/2026-10-15?from=CHF&to=EUR,USD") return send(200, FX_PREV);
		if (req.url.startsWith("/cg/simple/price?ids=bitcoin,ethereum&vs_currencies=chf")) return send(200, COINS);
		if (req.url.startsWith("/y/NESN.SW?")) return send(200, CHART);
		if (req.url.startsWith("/y/NOPE?")) return send(404, CHART_404);
		if (req.url.startsWith("/y/BUSY?")) return (res.writeHead(429), res.end("Too Many Requests"));
		send(404, {});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	t.after(() => server.close());
	const base = `http://127.0.0.1:${server.address().port}`;
	const saved = { ...markets.api };
	Object.assign(markets.api, { yahoo: `${base}/y/`, frankfurter: `${base}/fx/`, coingecko: `${base}/cg/` });
	t.after(() => (Object.assign(markets.api, saved), markets.clearCache()));
	markets.clearCache();

	const rates = await markets.fx("chf", ["EUR", "USD"]);
	assert.deepEqual(rates.map((r) => [r.pair, r.rate, r.changePct]), [["CHF/EUR", 1.0785, -0.14], ["CHF/USD", 1.2137, 1.14]]);
	await assert.rejects(markets.fx("CHF", ["EU R"]), /Invalid currency/);

	const coins = await markets.crypto(["bitcoin", "ethereum"]);
	assert.deepEqual(coins[0], { id: "bitcoin", price: 67672, changePct: 0.83 });
	await assert.rejects(markets.crypto(["bit coin"]), /Invalid/);

	const q = await markets.quotes(["nesn.sw", "NOPE", "BUSY", "A;B"]);
	assert.equal(q[0].symbol, "NESN.SW");
	assert.equal(q[0].price, 80.5);
	assert.deepEqual(q.slice(1), [
		{ symbol: "NOPE", error: "No data found, symbol may be delisted" },
		{ symbol: "BUSY", error: "Rate limited by Yahoo" },
		{ symbol: "A;B", error: "Invalid symbol" }
	]);

	// second call within 5 minutes comes from the cache
	const before = seen.length;
	await markets.quotes(["NESN.SW"]);
	await markets.fx("CHF", ["EUR", "USD"]);
	assert.equal(seen.length, before);
});
