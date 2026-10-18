/* Shared demo data for the prototypes. Numbers move a little every 2 s to feel live. */
"use strict";

const ICON = (n) => `https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/${n}.svg`;

// 24 h of response times (ms), one value per hour
function history(base, spread, outages = []) {
	return Array.from({ length: 24 }, (_, i) => (outages.includes(i) ? null : Math.round(base + (Math.random() - 0.4) * spread)));
}

window.DATA = {
	hosts: [
		{ id: "homeserver", name: "Homeserver", ip: "192.168.0.32", kind: "Docker · 14 Container", cpu: 23, ram: 61, disk: 72, temp: 48, uptime: "18 Tage", diskText: "2.6 von 3.6 TB" },
		{ id: "pi", name: "MagicMirror Pi", ip: "192.168.0.209", kind: "Raspberry Pi 4 · pm2", cpu: 41, ram: 38, disk: 44, temp: 57, uptime: "3 Tage", diskText: "13 von 29 GB" }
	],
	services: [
		{ id: "jellyfin", name: "Jellyfin", icon: ICON("jellyfin"), color: "#a95ce0", url: "http://192.168.0.32:8096", host: "homeserver", group: "Medien", status: "up", ms: 34, uptime: 99.98, history: history(36, 18), stat: "1 schaut gerade", container: { cpu: 6.2, ram: 812, image: "jellyfin/jellyfin:10.10.3", update: false } },
		{ id: "sonarr", name: "Sonarr", icon: ICON("sonarr"), color: "#35c5f4", url: "http://192.168.0.32:8989", host: "homeserver", group: "Medien", status: "up", ms: 52, uptime: 99.91, history: history(55, 30), stat: "2 Folgen heute", container: { cpu: 0.8, ram: 214, image: "linuxserver/sonarr:4.0.11", update: true } },
		{ id: "radarr", name: "Radarr", icon: ICON("radarr"), color: "#ffc230", url: "http://192.168.0.32:7878", host: "homeserver", group: "Medien", status: "up", ms: 48, uptime: 99.95, history: history(50, 26), stat: "1 Film diese Woche", container: { cpu: 0.6, ram: 238, image: "linuxserver/radarr:5.14.0", update: true } },
		{ id: "prowlarr", name: "Prowlarr", icon: ICON("prowlarr"), color: "#e66001", url: "http://192.168.0.32:9696", host: "homeserver", group: "Medien", status: "warn", ms: 1840, uptime: 99.2, history: history(400, 300).map((v, i) => (i > 19 ? 1700 + Math.round(Math.random() * 300) : v)), stat: "2 Indexer gestört", note: "Antwortet langsam (1.8 s)", container: { cpu: 3.1, ram: 190, image: "linuxserver/prowlarr:1.26.1", update: false } },
		{ id: "qbittorrent", name: "qBittorrent", icon: ICON("qbittorrent"), color: "#2f67ba", url: "http://192.168.0.32:8082", host: "homeserver", group: "Medien", status: "up", ms: 21, uptime: 99.99, history: history(22, 10), stat: "↓ 12.4 MB/s", container: { cpu: 11.4, ram: 420, image: "linuxserver/qbittorrent:5.0.1", update: true } },
		{ id: "flaresolverr", name: "FlareSolverr", icon: ICON("flaresolverr"), color: "#f38020", url: "http://192.168.0.32:8191", host: "homeserver", group: "Medien", status: "down", ms: null, uptime: 96.4, history: history(120, 40, [21, 22, 23]), stat: "gestoppt", note: "Container beendet vor 2 h (Exit 137, zu wenig Speicher)", container: { cpu: 0, ram: 0, image: "flaresolverr/flaresolverr:3.3.21", update: false } },
		{ id: "solar", name: "Solar", icon: null, glyph: "sun", color: "#f5b83d", url: "http://192.168.0.32:8082", host: "homeserver", group: "Zuhause", status: "up", ms: 64, uptime: 99.97, history: history(66, 24), stat: "3.8 kW", container: { cpu: 1.2, ram: 96, image: "solar-dashboard:local", update: false } },
		{ id: "mystrom", name: "myStrom", icon: null, glyph: "plug", color: "#4cc38a", url: "http://192.168.0.32:8091", host: "homeserver", group: "Zuhause", status: "up", ms: 41, uptime: 99.9, history: history(42, 20), stat: "3 Geräte an", container: { cpu: 0.4, ram: 72, image: "mystrom-app:local", update: false } },
		{ id: "magicmirror", name: "MagicMirror", icon: null, glyph: "mirror", color: "#9aa4b2", url: "http://192.168.0.209:8080", host: "pi", group: "Zuhause", status: "up", ms: 88, uptime: 99.6, history: history(90, 40), stat: "11 Module", process: "pm2 · MagicMirror" },
		{ id: "mmmanager", name: "Mirror Manager", icon: null, glyph: "sliders", color: "#8fb4ff", url: "http://192.168.0.209:8090", host: "pi", group: "Zuhause", status: "up", ms: 30, uptime: 99.8, history: history(30, 14), stat: "aktuell", process: "pm2 · mm-manager" },
		{ id: "portainer", name: "Portainer", icon: ICON("portainer"), color: "#13bef9", url: "https://192.168.0.32:9443", host: "homeserver", group: "System", status: "up", ms: 72, uptime: 99.99, history: history(70, 25), stat: "14 Container", container: { cpu: 0.3, ram: 64, image: "portainer/portainer-ce:2.24.0", update: false } },
		{ id: "grafana", name: "Grafana", icon: ICON("grafana"), color: "#f46800", url: "http://192.168.0.32:3030", host: "homeserver", group: "System", status: "up", ms: 58, uptime: 99.96, history: history(58, 22), stat: "4 Dashboards", container: { cpu: 0.9, ram: 156, image: "grafana/grafana:11.3.0", update: true } },
		{ id: "prometheus", name: "Prometheus", icon: ICON("prometheus"), color: "#e6522c", url: "http://192.168.0.32:9090", host: "homeserver", group: "System", status: "up", ms: 18, uptime: 99.99, history: history(18, 8), stat: "9 Ziele", container: { cpu: 2.4, ram: 512, image: "prom/prometheus:v2.55.0", update: false } },
		{ id: "uptimekuma", name: "Uptime Kuma", icon: ICON("uptime-kuma"), color: "#5cdd8b", url: "http://192.168.0.32:3001", host: "homeserver", group: "System", status: "up", ms: 27, uptime: 100, history: history(27, 10), stat: "12 Monitore", container: { cpu: 0.7, ram: 118, image: "louislam/uptime-kuma:1.23.15", update: false } },
		{ id: "dozzle", name: "Dozzle", icon: ICON("dozzle"), color: "#f9c74f", url: "http://192.168.0.32:8080", host: "homeserver", group: "System", status: "up", ms: 15, uptime: 99.99, history: history(15, 6), stat: "Logs", container: { cpu: 0.1, ram: 22, image: "amir20/dozzle:8.7.5", update: false } }
	],
	bookmarks: [
		{ name: "GitHub", url: "https://github.com" },
		{ name: "Router", url: "http://192.168.0.1" },
		{ name: "Solar-Log", url: "http://192.168.0.50" },
		{ name: "Tailscale", url: "https://login.tailscale.com/admin" }
	],
	jellyfin: {
		now: { user: "Joël", title: "Severance", sub: "S2 · E4 · Woe's Hollow", progress: 0.42, device: "Apple TV" },
		recent: [
			{ title: "Dune: Part Two", kind: "Film", hue: 30 },
			{ title: "Shōgun", kind: "Serie", hue: 350 },
			{ title: "The Bear", kind: "Serie", hue: 200 },
			{ title: "Civil War", kind: "Film", hue: 15 },
			{ title: "Fallout", kind: "Serie", hue: 45 },
			{ title: "Arcane", kind: "Serie", hue: 280 }
		]
	},
	upcoming: [
		{ when: "Heute 21:00", title: "The Penguin", sub: "S1 · E6", src: "sonarr" },
		{ when: "Heute 22:00", title: "Slow Horses", sub: "S4 · E7", src: "sonarr" },
		{ when: "Mi 23.10.", title: "Agatha All Along", sub: "S1 · E8", src: "sonarr" },
		{ when: "Fr 25.10.", title: "Smile 2", sub: "Film · digital", src: "radarr" },
		{ when: "Di 29.10.", title: "Venom: The Last Dance", sub: "Film · Kino", src: "radarr" }
	],
	torrents: [
		{ name: "Arcane.S02.2160p", progress: 0.64, speed: 8.1, eta: "6 min" },
		{ name: "The.Wild.Robot.2024.1080p", progress: 0.31, speed: 4.3, eta: "14 min" },
		{ name: "Ubuntu 24.10 Desktop", progress: 1, speed: 0, eta: "fertig" }
	],
	solar: { now: 3.8, today: 14.2, use: 1.1, curve: [0, 0, 0, 0, 0, 0, 0.1, 0.5, 1.2, 2.1, 3.0, 3.6, 4.1, 3.9, 3.8] },
	weather: { temp: 9, text: "Leicht bewölkt", high: 13, low: 4 },
	events: [
		{ t: "vor 2 h", text: "FlareSolverr beendet (Exit 137)", kind: "down" },
		{ t: "vor 5 h", text: "4 neue Container-Images verfügbar", kind: "info" },
		{ t: "vor 26 min", text: "Prowlarr antwortet langsam", kind: "warn" },
		{ t: "gestern", text: "Homeserver Backup erfolgreich (412 GB)", kind: "ok" }
	]
};

// small helpers shared by the prototypes
window.UTIL = {
	byId: (id) => DATA.services.find((s) => s.id === id),
	host: (id) => DATA.hosts.find((h) => h.id === id),
	hostPort: (url) => url.replace(/^https?:\/\//, ""),
	problems: () => DATA.services.filter((s) => s.status !== "up"),
	updates: () => DATA.services.filter((s) => s.container && s.container.update),
	// "sun", "plug", … for own apps without a logo
	glyph(name) {
		const g = {
			sun: "<circle cx='12' cy='12' r='4.2'/><path d='M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6'/>",
			plug: "<path d='M9 3v5M15 3v5M6.5 8h11v3a5.5 5.5 0 01-11 0V8zM12 16.5V21'/>",
			mirror: "<rect x='6' y='2.5' width='12' height='19' rx='3'/><path d='M9.5 7.5l3-2M9.5 11l5-3.5'/>",
			sliders: "<path d='M4 7h10M18 7h2M4 17h4M12 17h8'/><circle cx='16' cy='7' r='2'/><circle cx='10' cy='17' r='2'/>"
		}[name];
		return `<svg viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'>${g || ""}</svg>`;
	},
	// logo <img> or glyph, with a coloured letter if the logo doesn't load
	logo(s, cls = "logo") {
		if (!s.icon) return `<span class="${cls} glyph" style="--c:${s.color}">${UTIL.glyph(s.glyph)}</span>`;
		return `<span class="${cls}"><img src="${s.icon}" alt="" onerror="this.parentNode.classList.add('glyph');this.parentNode.style.setProperty('--c','${s.color}');this.replaceWith('${s.name[0]}')"></span>`;
	},
	spark(values, w = 120, h = 28) {
		const v = values.filter((x) => x !== null);
		const max = Math.max(...v) * 1.15;
		const min = 0;
		const step = w / (values.length - 1);
		let d = "";
		values.forEach((x, i) => {
			if (x === null) return;
			const y = h - ((x - min) / (max - min)) * h;
			d += `${d && values[i - 1] !== null ? "L" : "M"}${(i * step).toFixed(1)},${y.toFixed(1)}`;
		});
		return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>`;
	},
	fmtMs: (ms) => (ms === null ? "–" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`),
	// fake live data: call fn every 2 s after nudging the numbers
	live(fn) {
		setInterval(() => {
			for (const s of DATA.services) {
				if (s.status === "down") continue;
				s.ms = Math.max(8, Math.round(s.ms * (0.9 + Math.random() * 0.2)));
				if (s.container) {
					s.container.cpu = Math.max(0.1, +(s.container.cpu * (0.85 + Math.random() * 0.3)).toFixed(1));
				}
			}
			for (const h of DATA.hosts) {
				h.cpu = Math.min(95, Math.max(5, Math.round(h.cpu + (Math.random() - 0.5) * 8)));
				h.ram = Math.min(95, Math.max(20, Math.round(h.ram + (Math.random() - 0.5) * 2)));
			}
			const q = UTIL.byId("qbittorrent");
			const speed = Math.max(0.5, 12.4 + (Math.random() - 0.5) * 6);
			q.stat = `↓ ${speed.toFixed(1)} MB/s`;
			for (const t of DATA.torrents) if (t.progress < 1) t.progress = Math.min(1, t.progress + 0.004);
			DATA.solar.now = Math.max(0, +(DATA.solar.now + (Math.random() - 0.5) * 0.2).toFixed(1));
			UTIL.byId("solar").stat = `${DATA.solar.now.toFixed(1)} kW`;
			DATA.jellyfin.now.progress = Math.min(1, DATA.jellyfin.now.progress + 0.002);
			fn();
		}, 2000);
	},
	// pretend to run an action on the server
	act(label, ms = 1400) {
		return new Promise((r) => setTimeout(r, ms));
	}
};
