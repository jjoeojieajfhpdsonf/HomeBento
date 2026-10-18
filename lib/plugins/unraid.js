"use strict";
// Unraid: array state, disks, Docker containers and VMs through the Unraid API (GraphQL at
// /graphql) with an API key in the x-api-key header. Unraid 7.2 and newer have the API built in;
// Unraid 6.12 – 7.1 need the "Unraid Connect" plugin (Apps); older versions have no API at all.
const L = (de, en) => ({ de, en });

const DISK = "name status temp numErrors fsSize fsUsed type warning critical";
const ARRAY_Q = `{ array { state capacity { kilobytes { free used total } } parities { ${DISK} } disks { ${DISK} } caches { ${DISK} } } }`;
const DOCKER_Q = "{ docker { containers { names state autoStart } } }";
const VMS_Q = "{ vms { domains { name state } } }";

const BAD = new Set(["DISK_INVALID", "DISK_WRONG", "DISK_DSBL", "DISK_NP_DSBL", "DISK_NP_MISSING"]);
const STATUS = { DISK_OK: "OK", DISK_INVALID: "invalid", DISK_WRONG: "wrong disk", DISK_DSBL: "disabled", DISK_NP_DSBL: "disabled", DISK_NP_MISSING: "missing", DISK_NEW: "new", DISK_DSBL_NEW: "new (disabled)" };
const TYPE = { PARITY: "Parity", DATA: "Data", CACHE: "Pool", FLASH: "Flash", BOOT: "Boot" };
const NO_API = "No Unraid API found: Unraid 7.2+ has it built in, Unraid 6.12 – 7.1 need the Unraid Connect plugin";

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);

async function gql(url, key, query, request) {
	const r = await request(`${url}/graphql`, { method: "POST", body: { query }, headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": key }, timeout: 10000 });
	if (!r.status) throw new Error(r.error);
	if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the API key)");
	// without the API, the web interface answers with a redirect to its login page or a 404
	if (r.status === 404 || (r.status >= 300 && r.status < 400)) throw new Error(NO_API);
	let body;
	try {
		body = JSON.parse(r.body.toString("utf8"));
	} catch {
		throw new Error(r.status === 200 ? NO_API : `HTTP ${r.status}`);
	}
	const errors = Array.isArray(body.errors) ? body.errors : [];
	if (errors.some((e) => /unauthori[sz]ed|unauthenticated|forbidden|api key/i.test(`${e.message} ${e.extensions && e.extensions.code}`))) throw new Error("Access denied (check the API key and its role)");
	if (!body.data) throw new Error(errors.length ? `Unraid API: ${String(errors[0].message).slice(0, 120)}` : "Unexpected answer from Unraid");
	return body.data;
}

function disk(d) {
	const used = pct(Number(d.fsUsed), Number(d.fsSize));
	const hot = d.temp !== null && d.temp !== undefined && d.critical ? d.temp >= d.critical : false;
	const warm = d.temp !== null && d.temp !== undefined && d.warning ? d.temp >= d.warning : false;
	const status = BAD.has(d.status) || hot ? "bad" : d.status !== "DISK_OK" || warm || Number(d.numErrors) > 0 || used >= 95 ? "warn" : "ok";
	return {
		name: d.name || "disk",
		status,
		problem: BAD.has(d.status) ? `Disk ${d.name} is ${STATUS[d.status] || d.status}` : hot ? `Disk ${d.name} is too hot (${d.temp} °C)` : Number(d.numErrors) > 0 ? `Disk ${d.name} has ${d.numErrors} errors` : null,
		sub: [TYPE[d.type] || d.type, STATUS[d.status] || d.status, used !== null ? `${used} %` : "", typeof d.temp === "number" ? `${d.temp} °C` : ""].filter(Boolean).join(" · ")
	};
}

module.exports = {
	kind: "unraid",
	label: "Unraid",
	match: /unraid/,
	ttl: 30000,
	fields: [
		{
			key: "apiKey",
			label: L("API-Schlüssel", "API key"),
			help: L(
				"Einstellungen → Management Access → API Keys (Rolle «viewer» genügt). Ab Unraid 7.2 eingebaut, Unraid 6.12 – 7.1 brauchen das Plugin «Unraid Connect».",
				"Settings → Management Access → API Keys (the “viewer” role is enough). Built in from Unraid 7.2; Unraid 6.12 – 7.1 need the “Unraid Connect” plugin."
			),
			secret: true
		}
	],
	async fetch({ url, secrets, request }) {
		if (!secrets.apiKey) throw new Error("API key missing");
		// Docker and VMs are optional: when the service is off, Unraid answers with an error
		const [a, d, v] = await Promise.all([
			gql(url, secrets.apiKey, ARRAY_Q, request),
			gql(url, secrets.apiKey, DOCKER_Q, request).catch(() => null),
			gql(url, secrets.apiKey, VMS_Q, request).catch(() => null)
		]);
		const array = a && a.array;
		if (!array || !array.state) throw new Error("Unexpected answer from Unraid");
		const kb = (array.capacity && array.capacity.kilobytes) || {};
		const used = pct(Number(kb.used), Number(kb.total));
		const disks = [...(array.parities || []), ...(array.disks || []), ...(array.caches || [])].filter((x) => x && x.status !== "DISK_NP").map(disk);
		const containers = d && d.docker && Array.isArray(d.docker.containers) ? d.docker.containers : null;
		const domains = v && v.vms && Array.isArray(v.vms.domains) ? v.vms.domains : null;
		const started = array.state === "STARTED";
		const stopped = (containers || []).filter((c) => c.autoStart && c.state !== "RUNNING").map((c) => String((c.names || [])[0] || "container").replace(/^\//, ""));
		const metrics = [
			{ value: started ? L("Gestartet", "Started") : array.state === "STOPPED" ? L("Gestoppt", "Stopped") : array.state, label: "Array", warn: !started },
			{ value: used !== null ? `${used} %` : null, label: L("Array belegt", "Array used"), warn: used >= 90 },
			containers ? { value: `${containers.filter((c) => c.state === "RUNNING").length}/${containers.length}`, label: L("Container aktiv", "Containers running") } : null,
			domains && domains.length ? { value: `${domains.filter((x) => x.state === "RUNNING").length}/${domains.length}`, label: L("VMs aktiv", "VMs running") } : null
		].filter((m) => m && m.value !== null);
		const rank = { bad: 0, warn: 1, ok: 2 };
		return {
			metrics,
			items: disks.sort((x, y) => rank[x.status] - rank[y.status]).map((x) => ({ title: x.name, sub: x.sub, status: x.status })),
			warnings: [...(started ? [] : [`Array is ${String(array.state).toLowerCase().replace(/_/g, " ")}`]), ...disks.map((x) => x.problem).filter(Boolean), ...stopped.map((n) => `${n} is not running`)],
			summary: !started ? `Array ${String(array.state).toLowerCase().replace(/_/g, " ")}` : disks.some((x) => x.status === "bad") ? "Disk problem" : null
		};
	}
};
