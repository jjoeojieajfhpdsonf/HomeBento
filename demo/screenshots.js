"use strict";
// The pictures in the README, made from the demo with Chrome (no dependencies: Chrome is
// driven over its DevTools protocol with Node's WebSocket).
//
//   node demo/server.js            (in another terminal)
//   node demo/screenshots.js       → docs/*.webp
//
// CHROME=/path/to/chrome and DEMO=http://localhost:8122 change the defaults.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const CHROME = process.env.CHROME || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
const DEMO = process.env.DEMO || "http://localhost:8122";
const OUT = path.join(__dirname, "..", "docs");
const PORT = 9333;
const WIDTH = 1920;
// the page at 95 % of the screen: 8 columns, as the demo pages are made for
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// what to take: a page (whole height) or a window opened on it (the screen only)
const SHOTS = [
	{ name: "overview", page: "Overview" },
	{ name: "media", page: "Media" },
	{ name: "home", page: "Home" },
	{ name: "system", page: "System" },
	{ name: "details", page: "Overview", height: 1000, js: `serviceSheet(S.state.config.services.find((s) => s.name === "qBittorrent").id)` },
	{ name: "notifications", page: "Overview", height: 1000, js: `alertsSheet()` },
	{ name: "own-api", page: "Home", height: 1000, js: `(async () => { await tileOptions(tiles().find((t) => t.type === "api")); await new Promise((r) => setTimeout(r, 300)); document.querySelector(".sheet.on .acts .btn.primary").click(); })()` },
	{ name: "settings", page: "Overview", height: 1000, js: `settingsSheet()` }
];

async function main() {
	if (!CHROME) throw new Error("Chrome not found – set CHROME=/path/to/chrome");
	fs.mkdirSync(OUT, { recursive: true });
	const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hb-shots-"));
	const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--lang=en-US", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
	try {
		let target = null;
		for (let i = 0; i < 50 && !target; i++) {
			await sleep(200);
			target = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json()).then((l) => l.find((x) => x.type === "page")).catch(() => null);
		}
		if (!target) throw new Error("Chrome didn't start");
		const ws = new WebSocket(target.webSocketDebuggerUrl);
		await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
		let id = 0;
		const waiting = new Map();
		ws.onmessage = (m) => {
			const msg = JSON.parse(m.data);
			if (msg.id && waiting.has(msg.id)) {
				const { resolve, reject } = waiting.get(msg.id);
				waiting.delete(msg.id);
				msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
			}
		};
		const send = (method, params = {}) => new Promise((resolve, reject) => {
			const n = ++id;
			waiting.set(n, { resolve, reject });
			ws.send(JSON.stringify({ id: n, method, params }));
		});
		const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result.value;
		await fetch(`${DEMO}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ width: 95 }) });
		await send("Page.enable");
		await send("Runtime.enable");
		for (const shot of SHOTS) {
			await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height: shot.height || 1000, deviceScaleFactor: 1, mobile: false });
			await send("Page.navigate", { url: `${DEMO}/?page=${encodeURIComponent(shot.page)}` });
			// the live data and the weather need a moment
			await sleep(3500);
			if (shot.js) {
				await evaluate(shot.js);
				await sleep(1500);
			}
			let height = shot.height;
			if (!height) {
				height = await evaluate("Math.ceil(document.documentElement.scrollHeight)");
				await send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: 1, mobile: false });
				await sleep(600);
			}
			const { data } = await send("Page.captureScreenshot", { format: "webp", quality: 88, clip: { x: 0, y: 0, width: WIDTH, height, scale: 1 } });
			fs.writeFileSync(path.join(OUT, `${shot.name}.webp`), Buffer.from(data, "base64"));
			console.log(`docs/${shot.name}.webp  ${WIDTH}×${height}`);
		}
		ws.close();
	} finally {
		chrome.kill();
		setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 500);
	}
}

main().catch((err) => {
	console.error(err.message);
	process.exit(1);
});
