"use strict";
// Gitea and Forgejo (same API): repositories, unread notifications and open pull requests.
// Token: Settings → Applications → Generate token (read access to repository, issue, notification).
const L = (de, en) => ({ de, en });

module.exports = {
	kind: "gitea",
	label: "Gitea / Forgejo",
	match: /^(?!.*(postgres|mariadb|mysql|redis|valkey|[-_ ]db\b|runner|act_runner)).*(gitea|forgejo)/,
	repo: "go-gitea/gitea",
	ttl: 60000,
	fields: [{ key: "token", label: L("Zugriffstoken", "Access token"), help: L("Einstellungen → Anwendungen → Token generieren", "Settings → Applications → Generate token"), secret: true }],
	async fetch({ url, secrets, request, json }) {
		if (!secrets.token) throw new Error("Token missing");
		const headers = { Authorization: `token ${secrets.token}`, Accept: "application/json" };
		// JSON plus the x-total-count header
		const get = async (path) => {
			const r = await request(`${url}${path}`, { headers });
			if (!r.status) throw new Error(r.error);
			if (r.status === 401 || r.status === 403) throw new Error("Access denied (check the token)");
			if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
			let body;
			try {
				body = JSON.parse(r.body.toString("utf8"));
			} catch {
				throw new Error("Unexpected answer (not JSON)");
			}
			const total = r.headers["x-total-count"];
			return { body, total: total !== undefined ? Number(total) : null };
		};
		const [ver, notes, repos, pulls] = await Promise.all([
			json(`${url}/api/v1/version`, { headers }),
			get("/api/v1/notifications?status-types=unread&limit=50"),
			get("/api/v1/repos/search?limit=1"),
			get("/api/v1/repos/issues/search?state=open&type=pulls&limit=10")
		]);
		const count = (x, arr) => (x.total !== null ? x.total : arr.length);
		const notifications = Array.isArray(notes.body) ? notes.body : [];
		const prs = Array.isArray(pulls.body) ? pulls.body : [];
		const unread = count(notes, notifications);
		return {
			metrics: [
				{ value: count(repos, (repos.body && repos.body.data) || []), label: L("Repositories", "Repositories") },
				{ value: unread, label: L("ungelesen", "unread"), warn: unread > 0 },
				{ value: count(pulls, prs), label: "Pull Requests" }
			],
			items: prs.map((p) => ({ title: p.title, sub: `${(p.repository && p.repository.full_name) || ""} #${p.number}`, status: "ok" })),
			summary: ver && ver.version ? `v${ver.version}` : null
		};
	}
};
