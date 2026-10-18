# Changelog

## 0.12.0 – 2026-10-18

- 32 integrations as plugins (`lib/plugins/`): Plex, Emby, Tautulli, Overseerr/Jellyseerr, Lidarr, Readarr, Bazarr, SABnzbd, NZBGet, Transmission, Deluge, Pi-hole, AdGuard Home, Traefik, Nginx Proxy Manager, wg-easy, UniFi, Proxmox VE, TrueNAS, Glances, Portainer, Syncthing, Scrutiny, Uptime Kuma, Prometheus, Grafana, Speedtest Tracker, Home Assistant, Immich, Nextcloud, Frigate, Paperless-ngx, Gitea/Forgejo, Vaultwarden.
- Plugin figures show in service tiles, the service list and the details (with their list: monitors, guests, pools, clients …); their warnings go to the problem strip.
- README: plugin interface, opening services away from home.

## 0.11.2 – 2026-10-18

- Edit mode keeps the combined layout: the same tiles as in the view, the service list stays (on other pages with "take off this page").
- myStrom tile: total power and today's energy on top, a bar of who draws how much, and a card per device (room, power, energy today, switch).

## 0.11.1 – 2026-10-18

- Services open without a referrer: qBittorrent (and others with CSRF protection) answered "Unauthorized" when opened from HomeBento.
- Opened away from home (Tailscale IP or name, a domain): services on the HomeBento machine open under that same address; other services can get an "address away from home".
- Service details: key figures first, warnings in their own calmer section with a count.
- Server side for the coming tiles: weather (Open-Meteo), file systems, network history, iCal calendars, RSS feeds; plugin interface (lib/plugins) with Uptime Kuma and Prometheus.

## 0.11.0 – 2026-10-18

- myStrom tile: plugs and lamps from the myStrom app with power now, a switch each, and today's energy and cost.
- Energy tile: the solar day as a balance – self-sufficiency, own use, battery, produced, used, fed in, from the grid.
- Updates tile: release data is kept on disk and asked with ETags (unchanged answers don't count against GitHub's limit); at the limit the last known versions stay.
- Details open as centred windows again.
- MagicMirror tile: active modules, version, uptime and restarts, "Restart" through MagicMirror Manager.

## 0.10.1 – 2026-10-18

- MagicMirror integration: active modules, version and uptime from MagicMirror itself (/version, /startup, /config/); the details list the active modules with their position.

## 0.10.0 – 2026-10-18

- Update containers from the Updates tile: pull the image, recreate the container with the same configuration (volumes, ports, environment, networks, labels), check that it comes up, and bring the old one back otherwise. Progress shows in a log.
- Services that only live on the first page are grouped as "More" in the list.
- API to order the pages.

## 0.9.0 – 2026-10-18

- Updates tile: subscribe to GitHub repositories (suggested from your services via the image label or a list of known projects, or any owner/repo), see the newest version of each, new ones marked until you look; click for the release notes.
- Server details: click CPU, load, memory, disk, network or temperature for a 24 h chart (one sample a minute, kept on disk).
- Events: actions through HomeBento (start, stop, restart, Tailscale) are listed too; an explanation while nothing happened yet.
- Updates tile compares with the version the container runs (image label): "✓ running" or "runs 4.0.19" with the update marked; the count shows real updates.
- Uptime tile: denser rows (all services fit), 24 h share per service, problems first, legend.
- Calendar rows show the Sonarr/Radarr logo instead of a coloured dot.
- Docker tile: labelled values (CPU % of one core, RAM) and "sorted by RAM".
- Switching pages keeps the last data on screen (no flicker of the problem strip).
- Versions are tagged on GitHub from now on.

## 0.8.0 – 2026-10-18

- Details, logs, settings and info cards open as a panel from the right on desktop; short questions stay in the middle.
- New tiles: Docker (running and stopped containers, biggest users) and Events (latest outages and recoveries).
- Service details show the warnings a service reports (Sonarr/Radarr/Prowlarr health) with a link to its status page.
- Tailscale tile: all shares of the machine at a glance (click opens them), "Manage" to share or remove; the list left the settings. Choose the port when sharing a service in its details, or move it later.
- "Check now" shows progress and the result, and refreshes the integration data too.
- Service list: container uptime ("Up 3 days") instead of "since just now" after a restart.

## 0.7.3 – 2026-10-18

- Six tile columns again on desktop (like the prototype): wide and tall tiles fit without gaps.

## 0.7.2 – 2026-10-18

- Service list: filter by area (All · one chip per page) above the list on the first page.
- Combined layout: figures for every listed service (qBittorrent speeds, Prowlarr indexers …), not only for those with a tile on the page.

## 0.7.1 – 2026-10-18

- Combined layout like the prototype: the first page lists all services grouped by the page they live on, every row with the same columns (name, short info, 24 h history, response time, uptime, actions). The history comes from the stored hourly data, so it survives restarts.
- Notes: a ticked task is struck through right away and can be archived; "[ ] task" without a dash counts as a task too.

## 0.7.0 – 2026-10-18

- New layout "Combined" (Settings → Layout): problems of the page on top with their action, the content tiles, and the services of the page as a list with key figures, history and actions on hover. "Tiles" stays the default; edit mode always shows all tiles.
- Tailscale in the settings: a clean list of all entries (service name, address, × to remove) and "Share a service" to add one.

## 0.6.1 – 2026-10-18

- Logs are readable: time, level and message in columns (the app's own time stamp and thread number left out), search with highlighting, filter for warnings and errors, repeated lines folded ("×12 · last 11:03"), stack traces kept with their error, live updates, choice of how many lines.
- The Tailscale switch moved from the edit form to the service details.

## 0.6.0 – 2026-10-18

- Notes are Markdown: headings, lists, tasks (`- [ ]`), bold, links. Click to write, click outside to save, tick tasks in the view. Done tasks go to an archive (restore or delete).
- Info card for movies and shows: click a poster or an entry in "Coming up" / "Recently downloaded" for poster, year, rating, runtime, genres, overview and buttons to open it in Jellyfin, Radarr or Sonarr.
- Radarr/Sonarr covers through HomeBento (the API key stays on the server).
- Swiss date and number format when the browser is in Switzerland (time zone), also with English texts.
- Tailscale: share a service right from the settings.
- Wider layout on big screens (up to 1480 px, as many tile columns as fit).
- Fixed: "null" shown in the command palette and the settings.

## 0.5.2 – 2026-10-18

- Wide service tiles (2×1) show the key figures under the name, with room for all values.
- The Jellyfin tile leaves out "recently added" when that has its own tile on the page.

## 0.5.1 – 2026-10-18

- Notes are edited right on the tile: type and press Enter to add, tick, × to remove – no edit mode needed.

## 0.5.0 – 2026-10-18

- Command palette (⌘K / Ctrl K, "/" or the search field in the bar): open services, start or restart them, logs, details, open through Tailscale, switch pages, links from link tiles, settings, web search. Typing just "restart" offers the services that have a problem.

## 0.4.0 – 2026-10-18

- Tailscale: share a service in the tailnet with one switch (Tailscale Serve, HTTPS, same port), see and remove all serve entries in the settings, and open services at their Tailscale address when HomeBento is used through Tailscale.
- "Coming up" shows the last downloads of Sonarr/Radarr when nothing is planned.
- qBittorrent: newer versions answer the login with 204/401.
- Small service tiles show two key figures (no more cut values); the response time moved under the name.
- Server details follow the live values and explain CPU and load.

## 0.3.0 – 2026-10-18

- Tapping a service tile opens the service itself; details are behind the ⓘ button (or right click). A service that is down shows its details instead.
- Service tiles show key figures with labels: Radarr/Sonarr library, queue, missing and warnings; Jellyfin streams and library; qBittorrent speeds, downloading and seeding; Prowlarr indexers and failures; solar, MagicMirror Manager; for all others response time, uptime and container CPU/memory.
- New tiles: "Recently added" (Jellyfin posters) and notes with a checklist you can tick right on the board.
- Server tile shows network traffic.
- More tile sizes (1×2, 2×3, 3×1).
- Service details open instantly (container values from the regular sampling).
- No "Home" title unless you set one.

## 0.2.1 – 2026-10-18

- Jellyfin 10.11 and newer: the API key goes in the `Authorization` header (the old `X-Emby-Token` is rejected there), and "recently added" uses the new route.
- Service tiles: uptime only shows when a service had a problem ("97 % up"); otherwise "since 3 days".

## 0.2.0 – 2026-10-18

- "Set up automatically": running containers with a web page become services with matching tiles in one click (also "Add all" in the Docker suggestions).
- The web address of a container is found by trying its ports (no more torrent or agent ports), HomeBento doesn't suggest itself, and icons that don't exist aren't used.
- API keys of Sonarr, Radarr and Prowlarr are read from their containers.
- Service tiles show more: CPU and memory of the container, uptime, library size, queue and health warnings of Sonarr/Radarr; bigger tiles show the next items.
- Prowlarr integration.
- qBittorrent 5: login works (session cookie `QBT_SID_<port>`).
- Language can be chosen in the settings (per device).

## 0.1.0 – 2026-10-18

First version.

- Bento board with tiles in five sizes, several pages, edit mode with drag and drop (mouse and touch).
- Status checks with response times, hourly history for 30 days, uptime, events, optional notifications (`NOTIFY_URL`).
- Docker: suggestions from running containers (also `homepage.*` labels), start, stop, restart, logs, CPU and memory.
- Integrations: Jellyfin, Sonarr, Radarr, qBittorrent, solar dashboard, MagicMirror Manager. Logins stay on the server.
- Server tile with CPU, memory, disk, temperature and uptime.
- German and English, phone layout, optional password, no dependencies.
