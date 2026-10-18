# Changelog

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
