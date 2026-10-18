"use strict";
// Maintainerr: rule collections and the media they will remove, from /api/collections, plus the
// reclaimable space from /api/storage-metrics (newer versions). Maintainerr has no login of its
// own, so no key is needed (protect it with a reverse proxy if it is reachable from outside).
const L = (de, en) => ({ de, en });

function fmtBytes(b) {
	const u = ["B", "KB", "MB", "GB", "TB", "PB"];
	let i = 0;
	b = Number(b) || 0;
	while (b >= 1000 && i < u.length - 1) (b /= 1000), i++;
	return `${b < 10 && i > 1 ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

module.exports = {
	kind: "maintainerr",
	label: "Maintainerr",
	match: /maintainerr/,
	repo: "Maintainerr/Maintainerr",
	ttl: 300000,
	fields: [],
	async fetch({ url, request, json }) {
		const [r, metrics] = await Promise.all([request(`${url}/api/collections`, { headers: { Accept: "application/json" } }), json(`${url}/api/storage-metrics`).catch(() => null)]);
		if (!r.status) throw new Error(r.error);
		if (r.status === 401 || r.status === 403) throw new Error("Access denied (Maintainerr is behind a login, e.g. of a reverse proxy)");
		if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
		let collections;
		try {
			collections = JSON.parse(r.body.toString("utf8"));
		} catch {
			// Maintainerr answers with an empty body when it cannot read its collections
			throw new Error("Unexpected answer from Maintainerr");
		}
		if (!Array.isArray(collections)) throw new Error("Unexpected answer from Maintainerr");
		const active = collections.filter((c) => c.isActive);
		// like Maintainerr itself: active collections with a delete rule remove their media
		const removing = active.filter((c) => Number(c.deleteAfterDays) > 0);
		const scheduled = removing.reduce((a, c) => a + (Number(c.mediaCount) || 0), 0);
		const summary = metrics && metrics.collectionSummary;
		const reclaim = summary && summary.activeSizeBytes !== undefined ? Number(summary.activeSizeBytes) : removing.some((c) => c.totalSizeBytes != null) ? removing.reduce((a, c) => a + (Number(c.totalSizeBytes) || 0), 0) : null;
		const handled = metrics && metrics.cleanupTotals ? Number(metrics.cleanupTotals.itemsHandled) || 0 : collections.reduce((a, c) => a + (Number(c.handledMediaAmount) || 0), 0);
		const broken = metrics && Array.isArray(metrics.instances) ? metrics.instances.filter((i) => i.ok === false) : [];
		return {
			metrics: [
				{ value: `${active.length}/${collections.length}`, label: L("Regeln aktiv", "Rules active") },
				{ value: scheduled, label: L("zum Löschen vorgemerkt", "Scheduled for removal") },
				reclaim !== null ? { value: fmtBytes(reclaim), label: L("freiwerdend", "Reclaimable") } : null,
				{ value: handled, label: L("bereits erledigt", "Handled so far") }
			].filter(Boolean),
			items: collections
				.slice()
				.sort((a, b) => (b.isActive ? 1 : 0) - (a.isActive ? 1 : 0) || (Number(b.mediaCount) || 0) - (Number(a.mediaCount) || 0))
				.map((c) => ({
					title: c.title || `Collection ${c.id}`,
					sub: [
						`${Number(c.mediaCount) || 0} ${Number(c.mediaCount) === 1 ? "item" : "items"}`,
						!c.isActive ? "inactive" : Number(c.deleteAfterDays) > 0 ? `removed after ${c.deleteAfterDays} d` : "",
						c.totalSizeBytes ? fmtBytes(c.totalSizeBytes) : ""
					].filter(Boolean).join(" · "),
					status: c.isActive ? "ok" : "warn"
				})),
			warnings: broken.map((i) => `${i.name || i.type}: ${i.error || "not reachable"}`)
		};
	}
};
