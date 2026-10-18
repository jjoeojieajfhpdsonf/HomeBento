"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const yaml = require("../lib/yaml");
const { detect, importConfig } = require("../lib/importers");

// ---------- YAML ----------

test("yaml: mappings, sequences and lists of maps", () => {
	const doc = yaml.parse(`
# a comment
title: Home   # trailing comment
items:
  - name: one
    tags: [a, b]
  - name: two
    nested:
      - x
      - y
list:
- 1
- - inner
  - list
`);
	assert.deepEqual(doc, {
		title: "Home",
		items: [{ name: "one", tags: ["a", "b"] }, { name: "two", nested: ["x", "y"] }],
		list: [1, ["inner", "list"]]
	});
});

test("yaml: scalars, quotes and escapes", () => {
	const doc = yaml.parse(
		[
			"int: 42",
			"neg: -7",
			"float: 1.5",
			"exp: 1e3",
			"hex: 0x1F",
			"zero_lead: 0123",
			"version: 1.2.3",
			"yes: true",
			"no: False",
			"nothing: null",
			"tilde: ~",
			"empty:",
			"empty_quoted: ''",
			"single: 'it''s # not a comment'",
			'double: "tab\\there \\"q\\" \\u00e9 \\x41 # kept"',
			"url: http://host:8080/path#anchor",
			"time: 08:30",
			"colon_in_value: 'a: b'",
			'"quoted key": v',
			"alias: *base",
			"anchored: &a value",
			"tagged: !!str 123",
			"plain with spaces: some words here"
		].join("\n")
	);
	assert.equal(doc.int, 42);
	assert.equal(doc.neg, -7);
	assert.equal(doc.float, 1.5);
	assert.equal(doc.exp, 1000);
	assert.equal(doc.hex, 31);
	assert.equal(doc.zero_lead, "0123");
	assert.equal(doc.version, "1.2.3");
	assert.equal(doc.yes, true);
	assert.equal(doc.no, false);
	assert.equal(doc.nothing, null);
	assert.equal(doc.tilde, null);
	assert.equal(doc.empty, null);
	assert.equal(doc.empty_quoted, "");
	assert.equal(doc.single, "it's # not a comment");
	assert.equal(doc.double, 'tab\there "q" é A # kept');
	assert.equal(doc.url, "http://host:8080/path#anchor");
	assert.equal(doc.time, "08:30");
	assert.equal(doc.colon_in_value, "a: b");
	assert.equal(doc["quoted key"], "v");
	assert.equal(doc.alias, "*base");
	assert.equal(doc.anchored, "value");
	assert.equal(doc.tagged, "123");
	assert.equal(doc["plain with spaces"], "some words here");
});

test("yaml: flow lists and maps, also over several lines", () => {
	const doc = yaml.parse(`
a: [1, "two, three", {k: v, n: 2}, [x, y], ]
b: {name: Sonarr, url: "http://sonarr:8989", tags: [tv]}
c: []
d: {}
e: [
  one,   # comment
  two
]
`);
	assert.deepEqual(doc.a, [1, "two, three", { k: "v", n: 2 }, ["x", "y"]]);
	assert.deepEqual(doc.b, { name: "Sonarr", url: "http://sonarr:8989", tags: ["tv"] });
	assert.deepEqual(doc.c, []);
	assert.deepEqual(doc.d, {});
	assert.deepEqual(doc.e, ["one", "two"]);
});

test("yaml: block scalars and plain multi-line scalars", () => {
	const doc = yaml.parse(`
literal: |
  line one
    indented # not a comment

  line three
folded: >
  folded
  text

  new paragraph
stripped: |-
  no newline
kept: |+
  keep

items:
  - text: >-
      in a list
      item
next: plain
  continued here
`);
	assert.equal(doc.literal, "line one\n  indented # not a comment\n\nline three\n");
	assert.equal(doc.folded, "folded text\nnew paragraph\n");
	assert.equal(doc.stripped, "no newline");
	assert.equal(doc.kept, "keep\n\n");
	assert.deepEqual(doc.items, [{ text: "in a list item" }]);
	assert.equal(doc.next, "plain continued here");
});

test("yaml: only the first document, empty input", () => {
	assert.deepEqual(yaml.parse("---\na: 1\n---\na: 2\n"), { a: 1 });
	assert.deepEqual(yaml.parse("%YAML 1.2\n---\n- x\n...\n"), ["x"]);
	assert.equal(yaml.parse(""), null);
	assert.equal(yaml.parse("# only a comment\n"), null);
	assert.equal(yaml.parse("just text"), "just text");
});

test("yaml: errors name the line", () => {
	assert.throws(() => yaml.parse("a:\n  b: 1\n   c: 2\n"), /^Error: YAML line 3: bad indentation/);
	assert.throws(() => yaml.parse("a:\n    b: 1\n  c: 2\n"), /YAML line 3: bad indentation/);
	assert.throws(() => yaml.parse("a: 1\n- b\n"), /YAML line 2: a list item is not allowed here/);
	assert.throws(() => yaml.parse("a: 1\nnot a mapping\n"), /YAML line 2: expected "key: value"/);
	assert.throws(() => yaml.parse('a: "open\n'), /YAML line 1: unclosed quote/);
	assert.throws(() => yaml.parse("a: [1, 2\n"), /YAML line 1: unclosed flow collection/);
	assert.throws(() => yaml.parse("a:\n\tb: 1\n"), /YAML line 2: tabs are not allowed/);
	assert.throws(() => yaml.parse('a: "x\\q"\n'), /YAML line 1: invalid escape/);
});

// ---------- Homepage ----------

const HOMEPAGE = `---
# For configuration options and examples, please see:
# https://gethomepage.dev/configs/services

- Media:
    - Jellyfin:
        icon: jellyfin.png
        href: http://jellyfin.home:8096
        description: Movies and shows
        server: my-docker
        container: jellyfin
        widget:
          type: jellyfin
          url: http://jellyfin:8096
          key: 0123456789abcdef
          enableBlocks: true
    - Sonarr:
        icon: sonarr.png
        href: http://sonarr.home:8989/
        description: Series management
        widget:
          type: sonarr
          url: http://sonarr:8989
          key: "{{HOMEPAGE_VAR_SONARR_KEY}}"
    - Requests:
        icon: mdi-movie-search
        widget:
          type: jellyseerr
          url: http://jellyseerr:5055
          key: seerrkey
    - Downloads:
        icon: https://example.com/qbit.svg
        href: http://qbit.home
        widget:
          type: qbittorrent
          url: http://qbit:8080
          username: admin
          password: adminadmin

- Infrastructure:
    - Proxmox:
        icon: proxmox.svg
        href: https://pve.home:8006
        widget:
          type: proxmox
          url: https://pve.home:8006
          username: api@pam!homepage
          password: 11111111-2222-3333-4444-555555555555
          node: pve
    - Pi-hole:
        href: http://pihole.home/admin
        icon: si-pihole
        widget:
          type: pihole
          url: http://pihole.home
          version: 6
          key: pihole-app-password
    - Network:
        - Nginx Proxy Manager:
            href: http://npm.home:81
            icon: nginx-proxy-manager.png
            widget:
              type: npm
              url: http://npm.home:81
              username: admin@example.com
              password: changeme
        - UniFi:
            href: https://unifi.home
            widget:
              type: unifi
              url: https://unifi.home
              key: unifikey
              site: Home
    - Grafana:
        href: http://grafana.home:3000
        icon: grafana.png
        widget:
          type: grafana
          url: http://grafana.home:3000
          username: admin
          password: admin
    - Uptime Kuma:
        href: http://kuma.home:3001
        container: uptime-kuma
    - Weather thing:
        href: http://weather.home
        widget:
          type: customapi
          url: http://weather.home/api
    - Paperless:
        href: http://paperless.home
        widget:
          type: paperlessngx
          url: http://paperless.home
          key: paperlesstoken
`;

test("homepage services.yaml: groups, nested groups, kinds and logins", () => {
	assert.equal(detect(HOMEPAGE, "services.yaml"), "homepage");
	const r = importConfig(HOMEPAGE, "services.yaml");
	assert.equal(r.source, "homepage");
	assert.deepEqual(
		r.groups.map((g) => [g.name, g.services.map((s) => s.name)]),
		[
			["Media", ["Jellyfin", "Sonarr", "Requests", "Downloads"]],
			["Infrastructure", ["Proxmox", "Pi-hole", "Grafana", "Uptime Kuma", "Weather thing", "Paperless"]],
			["Infrastructure / Network", ["Nginx Proxy Manager", "UniFi"]]
		]
	);
	const svc = Object.fromEntries(r.groups.flatMap((g) => g.services).map((s) => [s.name, s]));

	assert.deepEqual(svc.Jellyfin, {
		name: "Jellyfin",
		url: "http://jellyfin.home:8096",
		icon: "jellyfin",
		description: "Movies and shows",
		kind: "jellyfin",
		secrets: { apiKey: "0123456789abcdef" },
		container: "jellyfin"
	});
	// template variables are not taken over
	assert.equal(svc.Sonarr.kind, "sonarr");
	assert.deepEqual(svc.Sonarr.secrets, {});
	assert.ok(r.warnings.some((w) => w.startsWith("Sonarr:") && w.includes("variable")));
	// no href: the widget address is used; mdi icons are dropped
	assert.equal(svc.Requests.url, "http://jellyseerr:5055");
	assert.equal(svc.Requests.kind, "overseerr");
	assert.deepEqual(svc.Requests.secrets, { apiKey: "seerrkey" });
	assert.equal(svc.Requests.icon, "");
	assert.ok(r.warnings.some((w) => w.includes("mdi-movie-search")));
	// href wins over the widget address, image addresses stay
	assert.equal(svc.Downloads.url, "http://qbit.home");
	assert.equal(svc.Downloads.icon, "https://example.com/qbit.svg");
	assert.deepEqual(svc.Downloads.secrets, { username: "admin", password: "adminadmin" });

	assert.equal(svc.Proxmox.kind, "proxmox");
	assert.deepEqual(svc.Proxmox.secrets, { tokenId: "api@pam!homepage", tokenSecret: "11111111-2222-3333-4444-555555555555" });
	assert.equal(svc["Pi-hole"].kind, "pihole");
	assert.deepEqual(svc["Pi-hole"].secrets, { password: "pihole-app-password" });
	assert.equal(svc["Pi-hole"].icon, "");
	assert.equal(svc["Nginx Proxy Manager"].kind, "nginxproxymanager");
	assert.equal(svc["Nginx Proxy Manager"].icon, "nginx-proxy-manager");
	assert.deepEqual(svc["Nginx Proxy Manager"].secrets, { username: "admin@example.com", password: "changeme" });
	assert.deepEqual(svc.UniFi.secrets, { apiKey: "unifikey", site: "Home" });
	// Grafana takes a token, not user/password: skipped with a warning
	assert.equal(svc.Grafana.kind, "grafana");
	assert.deepEqual(svc.Grafana.secrets, {});
	assert.ok(r.warnings.some((w) => w.startsWith("Grafana:") && w.includes('"username"')));
	// no widget: kind guessed from the name or container, never secrets
	assert.equal(svc["Uptime Kuma"].kind, "uptimekuma");
	assert.equal(svc["Uptime Kuma"].container, "uptime-kuma");
	assert.deepEqual(svc["Uptime Kuma"].secrets, {});
	assert.equal(svc["Weather thing"].kind, null);
	assert.ok(r.warnings.some((w) => w.includes('"customapi"')));
	assert.equal(svc.Paperless.kind, "paperless");
	assert.deepEqual(svc.Paperless.secrets, { token: "paperlesstoken" });
	assert.deepEqual(r.links, []);
});

test("homepage bookmarks.yaml → links", () => {
	const text = `
- Developer:
    - Github:
        - abbr: GH
          href: https://github.com/
    - Docs:
        - abbr: DO
          href: https://gethomepage.dev/
- Social:
    - Reddit:
        - icon: reddit.png
          href: https://reddit.com/
          description: The front page of the internet
`;
	assert.equal(detect(text, "bookmarks.yaml"), "homepage");
	const r = importConfig(text, "bookmarks.yaml");
	assert.deepEqual(r.groups, []);
	assert.deepEqual(r.links, [
		{ name: "Github", url: "https://github.com/", group: "Developer" },
		{ name: "Docs", url: "https://gethomepage.dev/", group: "Developer" },
		{ name: "Reddit", url: "https://reddit.com/", group: "Social" }
	]);
});

// ---------- Dashy ----------

const DASHY = `
pageInfo:
  title: Home Lab
  description: Welcome to your Home Lab!
appConfig:
  theme: colorful
  layout: auto
pages:
  - name: Networking
    path: 'networking.yml'
sections:
  - name: Media
    icon: fas fa-film
    items:
      - title: Jellyfin
        description: Media server
        url: https://jellyfin.home
        icon: hl-jellyfin
      - title: Radarr
        url: http://radarr.home:7878
        icon: favicon
        statusCheck: true
  - name: Tools
    displayData:
      collapsed: true
    widgets:
      - type: clock
    items:
      - title: Code
        description: >-
          Self-hosted
          VS Code
        url: http://code.home
        icon: fas fa-code
      - title: Router
        url: 192.168.1.1
`;

test("dashy conf.yml", () => {
	assert.equal(detect(DASHY, "conf.yml"), "dashy");
	const r = importConfig(DASHY, "conf.yml");
	assert.equal(r.source, "dashy");
	assert.deepEqual(
		r.groups.map((g) => g.name),
		["Media", "Tools"]
	);
	const [jelly, radarr] = r.groups[0].services;
	assert.deepEqual(jelly, { name: "Jellyfin", url: "https://jellyfin.home", icon: "jellyfin", description: "Media server", kind: "jellyfin", secrets: {}, container: null });
	assert.equal(radarr.kind, "radarr");
	assert.equal(radarr.icon, "");
	const [code, router] = r.groups[1].services;
	assert.equal(code.description, "Self-hosted VS Code");
	assert.equal(code.icon, "");
	assert.equal(router.url, "");
	assert.ok(r.warnings.some((w) => w.includes("pages")));
	assert.ok(r.warnings.some((w) => w.includes("widgets")));
	assert.ok(r.warnings.some((w) => w.includes('"192.168.1.1"')));
});

// ---------- Homer ----------

const HOMER = `---
# Homepage configuration
title: "Demo dashboard"
subtitle: "Homer"
logo: "logo.png"

header: true
footer: '<p>Created with <span class="has-text-danger">❤️</span></p>'

links:
  - name: "Contribute"
    icon: "fab fa-github"
    url: "https://github.com/bastienwirtz/homer"

services:
  - name: "Applications"
    icon: "fas fa-cloud"
    items:
      - name: "Pi-hole"
        logo: "assets/tools/sample.png"
        subtitle: "Network-wide Ad Blocking"
        tag: "other"
        url: "http://192.168.0.151/admin"
        type: "PiHole"
        apikey: "pihole-token"
        target: "_blank"
      - name: "Sonarr"
        logo: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/sonarr.png"
        url: "http://sonarr.home:8989"
        type: "Sonarr"
        apikey: "sonarrkey"
      - name: "PVE"
        icon: "fas fa-server"
        url: "https://pve.home:8006"
        type: "Proxmox"
        node: "pve"
        api_token: "PVEAPIToken=root@pam!homer=abcd-ef"
  - name: "Other"
    items:
      - name: "Jellyfin"
        subtitle: "Movies"
        url: "https://jelly.home"
`;

test("homer config.yml", () => {
	assert.equal(detect(HOMER, "config.yml"), "homer");
	const r = importConfig(HOMER, "config.yml");
	assert.equal(r.source, "homer");
	assert.deepEqual(
		r.groups.map((g) => [g.name, g.services.length]),
		[
			["Applications", 3],
			["Other", 1]
		]
	);
	const [pihole, sonarr, pve] = r.groups[0].services;
	assert.equal(pihole.kind, "pihole");
	assert.deepEqual(pihole.secrets, { password: "pihole-token" });
	assert.equal(pihole.icon, "");
	assert.equal(pihole.description, "Network-wide Ad Blocking");
	assert.ok(r.warnings.some((w) => w.includes("assets/tools/sample.png")));
	assert.equal(sonarr.icon, "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/sonarr.png");
	assert.deepEqual(sonarr.secrets, { apiKey: "sonarrkey" });
	assert.equal(pve.kind, "proxmox");
	assert.deepEqual(pve.secrets, { tokenId: "root@pam!homer", tokenSecret: "abcd-ef" });
	const jelly = r.groups[1].services[0];
	assert.equal(jelly.kind, "jellyfin");
	assert.deepEqual(jelly.secrets, {});
});

// ---------- Heimdall ----------

test("heimdall JSON export (best effort)", () => {
	const text = JSON.stringify([
		{ title: "Sonarr", colour: "#161b1f", icon: "icons/sonarr.png", url: "http://sonarr.home:8989", class: "App\\SupportedApps\\Sonarr\\Sonarr", type: 0 },
		{ title: "Media", type: 1, url: "media" },
		{ title: "NAS", url: "https://nas.home", description: "Storage" }
	]);
	assert.equal(detect(text, "heimdall.json"), "heimdall");
	const r = importConfig(text, "heimdall.json");
	assert.equal(r.source, "heimdall");
	assert.equal(r.groups.length, 1);
	assert.deepEqual(r.groups[0].services, [
		{ name: "Sonarr", url: "http://sonarr.home:8989", icon: "", description: "", kind: "sonarr", secrets: {}, container: null },
		{ name: "NAS", url: "https://nas.home", icon: "", description: "Storage", kind: null, secrets: {}, container: null }
	]);
});

// ---------- browser bookmarks ----------

const BOOKMARKS = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- This is an automatically generated file. -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1700000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://github.com/" ADD_DATE="1700000001">GitHub</A>
        <DT><H3>Home &amp; Lab</H3>
        <DL><p>
            <DT><A HREF="http://router.home/" ICON="data:image/png;base64,AAA">Router</A>
            <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://news.ycombinator.com/">Hacker News</A>
</DL><p>
`;

test("browser bookmarks HTML → links by folder", () => {
	assert.equal(detect(BOOKMARKS, "bookmarks.html"), "bookmarks");
	const r = importConfig(BOOKMARKS, "bookmarks.html");
	assert.equal(r.source, "bookmarks");
	assert.deepEqual(r.groups, []);
	assert.deepEqual(r.links, [
		{ name: "GitHub", url: "https://github.com/", group: "Bookmarks bar" },
		{ name: "Router", url: "http://router.home/", group: "Bookmarks bar / Home & Lab" },
		{ name: "Hacker News", url: "https://news.ycombinator.com/", group: "Bookmarks" }
	]);
	assert.ok(r.warnings.some((w) => w.startsWith("1 bookmark ")));
});

// ---------- detection ----------

test("detect: unknown and broken files", () => {
	assert.equal(detect("", "x.yml"), null);
	assert.equal(detect("foo: bar\n", "x.yml"), null);
	assert.equal(detect("a:\n  b: 1\n   c: 2\n", "x.yml"), null);
	assert.throws(() => importConfig("foo: bar\n", "x.yml"), /Unknown file/);
	assert.throws(() => importConfig("sections:\n  - name: a\n   items: []\n", "conf.yml"), /YAML line 3/);
	assert.throws(() => importConfig("  ", "x.yml"), /empty/);
});
