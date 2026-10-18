"use strict";
// Kubernetes: nodes and pods straight from the API server (/api/v1/nodes, /api/v1/pods) with a
// bearer token, e.g. of a service account that may list nodes and pods. The API server usually
// has its own certificate (https://…:6443), so "Allow own certificate" is normally needed.
const L = (de, en) => ({ de, en });

const BAD_REASONS = /CrashLoopBackOff|ImagePullBackOff|ErrImagePull|CreateContainerConfigError|CreateContainerError|InvalidImageName|RunContainerError|OOMKilled|Error/;

function nodeOf(n) {
	const conds = (n.status && n.status.conditions) || [];
	const ready = conds.find((c) => c.type === "Ready");
	const pressure = conds.filter((c) => c.type !== "Ready" && c.status === "True").map((c) => c.type);
	return {
		name: (n.metadata && n.metadata.name) || "node",
		ready: !!ready && ready.status === "True",
		cordoned: !!(n.spec && n.spec.unschedulable),
		pressure,
		version: n.status && n.status.nodeInfo && n.status.nodeInfo.kubeletVersion
	};
}

function podOf(p) {
	const meta = p.metadata || {};
	const st = p.status || {};
	const cs = [...(st.initContainerStatuses || []).filter((c) => !c.ready && c.state && c.state.waiting), ...(st.containerStatuses || [])];
	const waiting = cs.map((c) => c.state && c.state.waiting && c.state.waiting.reason).find(Boolean);
	const terminated = cs.map((c) => c.state && c.state.terminated && c.state.terminated.reason).find(Boolean);
	const restarts = (st.containerStatuses || []).reduce((a, c) => a + (Number(c.restartCount) || 0), 0);
	const allReady = (st.containerStatuses || []).length > 0 && st.containerStatuses.every((c) => c.ready);
	const phase = st.phase || "Unknown";
	const reason = meta.deletionTimestamp ? "Terminating" : waiting || terminated || st.reason || (phase === "Running" && !allReady ? "NotReady" : phase);
	const ok = phase === "Running" && allReady && !meta.deletionTimestamp;
	const bad = phase === "Failed" || phase === "Unknown" || BAD_REASONS.test(reason || "");
	return { ns: meta.namespace || "default", name: meta.name || "pod", node: p.spec && p.spec.nodeName, phase, reason, restarts, ok, bad, running: phase === "Running" };
}

module.exports = {
	kind: "kubernetes",
	label: "Kubernetes",
	match: /kube-?apiserver|\bk3s\b|\bk0s\b|microk8s/,
	ttl: 30000,
	fields: [
		{
			key: "token",
			label: L("Token", "Token"),
			help: L(
				"Token eines Service-Accounts, der Nodes und Pods lesen darf (z. B. kubectl create token …). Adresse ist der API-Server, z. B. https://k8s:6443 – bei eigenem Zertifikat «Eigenes Zertifikat erlauben» einschalten.",
				"Token of a service account that may list nodes and pods (e.g. kubectl create token …). The address is the API server, e.g. https://k8s:6443 – with a self-signed certificate turn on “Allow own certificate”."
			),
			secret: true
		}
	],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("Token missing");
		const headers = { Authorization: `Bearer ${secrets.token}` };
		const get = (path, opts = {}) =>
			json(`${url}${path}`, { headers, ...opts }).catch((err) => {
				if (/Access denied/.test(err.message)) throw new Error("Access denied (check the token and that it may list nodes and pods)");
				throw err;
			});
		// finished job pods (Succeeded) are left out: they are not running on purpose
		const [nodes, pods, version] = await Promise.all([get("/api/v1/nodes"), get("/api/v1/pods?fieldSelector=status.phase%21%3DSucceeded", { maxBytes: 50_000_000, timeout: 20000 }), get("/version").catch(() => null)]);
		if (!nodes || !Array.isArray(nodes.items) || !pods || !Array.isArray(pods.items)) throw new Error("Unexpected answer from the Kubernetes API");

		const ns = nodes.items.map(nodeOf);
		const ps = pods.items.map(podOf).filter((p) => p.phase !== "Succeeded");
		const readyNodes = ns.filter((n) => n.ready);
		const notReady = ps.filter((p) => !p.ok);
		const failing = notReady.filter((p) => p.bad);
		const ver = (version && version.gitVersion) || (ns[0] && ns[0].version) || null;
		const rank = (p) => (p.bad ? 0 : 1);

		return {
			metrics: [
				{ value: `${readyNodes.length}/${ns.length}`, label: L("Nodes bereit", "Nodes ready"), warn: readyNodes.length < ns.length },
				{ value: `${ps.filter((p) => p.running).length}/${ps.length}`, label: L("Pods aktiv", "Pods running") },
				{ value: notReady.length, label: L("Pods nicht bereit", "Pods not ready"), warn: failing.length > 0 },
				{ value: ver ? String(ver).replace(/\+.*$/, "") : null, label: "Version" }
			].filter((m) => m.value !== null),
			items: [
				...ns.filter((n) => !n.ready || n.cordoned || n.pressure.length).map((n) => ({ title: `Node ${n.name}`, sub: [!n.ready ? "not ready" : "", n.cordoned ? "cordoned" : "", ...n.pressure].filter(Boolean).join(" · "), status: n.ready ? "warn" : "bad" })),
				...notReady
					.sort((a, b) => rank(a) - rank(b) || a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name))
					.map((p) => ({ title: `${p.ns}/${p.name}`, sub: [p.reason, p.restarts ? `${p.restarts} restarts` : "", p.node || ""].filter(Boolean).join(" · "), status: p.bad ? "bad" : "warn" }))
			],
			warnings: [
				...ns.filter((n) => !n.ready).map((n) => `Node ${n.name} is not ready`),
				...(failing.length ? [`${failing.length} pod${failing.length === 1 ? "" : "s"} failing: ${failing.slice(0, 3).map((p) => p.name).join(", ")}${failing.length > 3 ? " …" : ""}`] : [])
			],
			summary: notReady.length ? `${notReady.length} pod${notReady.length === 1 ? "" : "s"} not ready` : null
		};
	}
};
