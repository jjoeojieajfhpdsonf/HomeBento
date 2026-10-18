"use strict";
// Tandoor Recipes: number of recipes and keywords and today's meal plan. Needs an API token
// with the scope "read" (Tandoor → Settings → API).
const L = (de, en) => ({ de, en });

const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const list = (r) => (Array.isArray(r) ? r : r && Array.isArray(r.results) ? r.results : null);

module.exports = {
	kind: "tandoor",
	label: "Tandoor Recipes",
	match: /^(?!.*(postgres|mariadb|[-_ ]db\b|db[-_]|nginx)).*(tandoor|vabene1111\/recipes)/,
	repo: "TandoorRecipes/recipes",
	ttl: 300000,
	fields: [{ key: "token", label: L("API-Token", "API token"), help: L("Tandoor → Einstellungen → API → Token erstellen (Scope «read»)", "Tandoor → Settings → API → create a token (scope “read”)"), secret: true }],
	async fetch({ url, secrets, json }) {
		if (!secrets.token) throw new Error("API token missing");
		const headers = { Authorization: `Bearer ${secrets.token}` };
		const today = isoDay(new Date());
		const [recipes, keywords, plan] = await Promise.all([
			json(`${url}/api/recipe/?page_size=1`, { headers }),
			json(`${url}/api/keyword/?page_size=1`, { headers }),
			json(`${url}/api/meal-plan/?from_date=${today}&to_date=${today}`, { headers }).catch(() => null)
		]);
		if (!recipes || typeof recipes.count !== "number") throw new Error("Unexpected answer from Tandoor");
		const entries = list(plan);
		const meals = (entries || []).map((m) => ({
			title: (m.recipe && m.recipe.name) || m.title || "?",
			type: (m.meal_type && m.meal_type.name) || m.meal_type_name || "",
			order: (m.meal_type && m.meal_type.order) || 0
		}));
		meals.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
		return {
			metrics: [
				{ value: recipes.count, label: L("Rezepte", "Recipes") },
				{ value: keywords && typeof keywords.count === "number" ? keywords.count : null, label: L("Stichwörter", "Keywords") },
				{ value: entries ? meals.length : null, label: L("heute geplant", "planned today") }
			],
			items: meals.map((m) => ({ title: m.title, sub: m.type, status: "ok" })),
			summary: meals.length ? `Today: ${meals.map((m) => m.title).join(", ")}` : null
		};
	}
};
