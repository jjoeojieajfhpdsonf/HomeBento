# Changelog

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
