"use strict";
// Gluetun: whether the VPN runs, the public IP and its country, and the forwarded port, from the
// control server (port 8000): /v1/vpn/status (older: /v1/openvpn/status), /v1/publicip/ip and
// /v1/portforward (older: /v1/openvpn/portforwarded). Since v3.40 the routes need a login set up in
// /gluetun/auth/config.toml: an API key (X-API-Key header) or basic auth.
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "gluetun",
	label: "Gluetun",
	match: /gluetun/,
	repo: "qdm12/gluetun",
	ttl: 30000,
	fields: [
		{ key: "apiKey", label: L("API-Schlüssel", "API key"), help: L("Aus /gluetun/auth/config.toml (auth = \"apikey\"); erstellen mit docker run --rm qmcgaw/gluetun genkey", "From /gluetun/auth/config.toml (auth = \"apikey\"); create one with docker run --rm qmcgaw/gluetun genkey"), secret: true },
		{ key: "username", label: L("Benutzer", "User"), help: L("Nur bei auth = \"basic\" statt API-Schlüssel", "Only for auth = \"basic\" instead of an API key") },
		{ key: "password", label: L("Passwort", "Password"), secret: true }
	],
	async fetch({ url, secrets, json }) {
		const headers = {};
		if (secrets.apiKey) headers["X-API-Key"] = secrets.apiKey;
		else if (secrets.username || secrets.password) headers.Authorization = `Basic ${Buffer.from(`${secrets.username || ""}:${secrets.password || ""}`).toString("base64")}`;
		const login = Object.keys(headers).length > 0;
		// newer route first, the OpenVPN-only route of older versions on 404
		const get = (path, old) => json(`${url}${path}`, { headers }).catch((err) => (err.message === "HTTP 404" && old ? json(`${url}${old}`, { headers }) : Promise.reject(err)));
		let status;
		try {
			status = await get("/v1/vpn/status", "/v1/openvpn/status");
		} catch (err) {
			if (!login && /Access denied/.test(err.message)) throw new Error("API key missing");
			throw err;
		}
		if (!status || typeof status.status !== "string") throw new Error("Unexpected answer from Gluetun");
		const [ip, pf] = await Promise.all([json(`${url}/v1/publicip/ip`, { headers }).catch(() => null), get("/v1/portforward", "/v1/openvpn/portforwarded").catch(() => null)]);
		const running = status.status === "running";
		const where = ip ? [ip.city, ip.country].filter(Boolean).join(", ") : "";
		const port = pf && Number(pf.port) > 0 ? Number(pf.port) : null;
		return {
			metrics: [
				{ value: running ? L("Verbunden", "Running") : status.status === "stopped" ? L("Gestoppt", "Stopped") : status.status, label: "VPN", warn: !running },
				{ value: (ip && ip.public_ip) || null, label: L("Öffentliche IP", "Public IP") },
				{ value: (ip && ip.country) || null, label: L("Land", "Country") },
				...(port ? [{ value: port, label: L("Weitergeleiteter Port", "Forwarded port") }] : [])
			],
			warnings: running ? [] : [`Gluetun VPN is ${status.status}`],
			summary: where && ip.organization ? `${where} · ${ip.organization}` : where || null
		};
	}
};
