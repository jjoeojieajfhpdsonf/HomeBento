"use strict";
// Mealie: recipes, users and categories from the household statistics (Mealie v2) or the group
// statistics (v1), and today's meal plan. Needs an API token (Mealie → Profile → API Tokens).
const L = (de, en) => ({ de, en });

const bases = new Map(); // url -> "households" (v2) or "groups" (v1)
const ORDER = ["breakfast", "lunch", "dinner", "side", "snack", "drink", "dessert"];

// Statistics of v2, falling back to v1 when the household API does not exist.
async function statistics(url, headers, json) {
	const known = bases.get(url);
	for (const base of known ? [known] : ["households", "groups"]) {
		try {
			const s = await json(`${url}/api/${base}/statistics`, { headers });
			bases.set(url, base);
			return { base, s };
		} catch (err) {
			if (err.message !== "HTTP 404" || base === "groups") throw err;
		}
	}
	throw new Error("Unexpected answer from Mealie");
}

module.exports = {
	kind: "mealie",
	label: "Mealie",
	match: /^(?!.*(postgres|mariadb|mysql|[-_ ]db\b)).*mealie/,
	repo: "mealie-recipes/mealie",
	ttl: 300000,
	fields: [{ key: "token", label: L("API-Token", "API token"), help: L("Mealie → Profil → API-Tokens", "Mealie → Profile → API Tokens"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("API token missing");
		const headers = { Authorization: `Bearer ${secrets.token}` };
		const { base, s } = await statistics(url, headers, json);
		if (!s || typeof s.totalRecipes !== "number") throw new Error("Unexpected answer from Mealie");
		const plan = await json(`${url}/api/${base}/mealplans/today`, { headers }).catch(() => null);
		const meals = (Array.isArray(plan) ? plan : [])
			.map((m) => ({ title: (m.recipe && m.recipe.name) || m.title || "?", type: m.entryType || "" }))
			.sort((a, b) => (ORDER.indexOf(a.type) + 1 || 99) - (ORDER.indexOf(b.type) + 1 || 99));
		return {
			metrics: [
				{ value: s.totalRecipes, label: L("Rezepte", "Recipes") },
				{ value: s.totalUsers ?? null, label: L("Benutzer", "Users") },
				{ value: s.totalCategories ?? null, label: L("Kategorien", "Categories") },
				{ value: Array.isArray(plan) ? meals.length : null, label: L("heute geplant", "planned today") }
			],
			items: meals.map((m) => ({ title: m.title, sub: m.type, status: "ok" })),
			summary: meals.length ? `Today: ${meals.map((m) => m.title).join(", ")}` : null
		};
	}
};
