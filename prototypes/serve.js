// Tiny static server for the prototypes: node serve.js [port]
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const PORT = Number(process.env.PORT || process.argv[2]) || 8100;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
http
	.createServer((req, res) => {
		const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
		const file = path.join(__dirname, path.normalize(rel));
		if (!file.startsWith(__dirname)) return res.writeHead(403).end();
		fs.readFile(file, (err, data) => {
			if (err) return res.writeHead(404).end("not found");
			res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
			res.end(data);
		});
	})
	.listen(PORT, "127.0.0.1", () => console.log(`Prototypes on http://localhost:${PORT}`));
