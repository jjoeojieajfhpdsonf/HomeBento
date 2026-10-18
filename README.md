# HomeBento

A dashboard for the services at home that does more than link to them: every tile shows what its service is doing, problems come with the action to fix them, and everything is set up in the browser – no YAML.

- **Tiles with content:** what's playing on Jellyfin and what was added, what Sonarr and Radarr bring next (one calendar), what qBittorrent downloads, what the solar plant produces, CPU / memory / disk of the server, uptime of every service over 24 hours.
- **Status with history:** every service is checked regularly. You see response times, uptime over 30 days and when something went down, not just a green dot.
- **Actions:** start, stop and restart Docker containers and read their logs right from the dashboard. MagicMirror can be restarted through [MagicMirror Manager](https://github.com/jjoeojieajfhpdsonf/magicMirrorManager).
- **Sets itself up:** one click turns your running containers into services with matching tiles. The web port is found by trying the container's ports, and the API keys of Sonarr, Radarr and Prowlarr are read from their containers.
- **Set up in the browser:** add services and tiles, arrange them by dragging, change sizes, several pages. Docker containers are suggested with name, address and icon (`homepage.*` labels are understood too).
- **Updates:** subscribe to the GitHub repositories of your services and see new versions with their release notes.
- **Command palette:** ⌘K (or Ctrl K, or "/") finds services, actions, pages and links – "son restart" restarts Sonarr.
- **Notifications:** optional push message when a service goes down or comes back (ntfy or any URL that takes a POST).
- **Light:** one Node.js process, **no dependencies**, phone and laptop layouts, German and English.

Icons come from [dashboard-icons](https://github.com/homarr-labs/dashboard-icons).

## Install with Docker (recommended)

```bash
git clone https://github.com/jjoeojieajfhpdsonf/HomeBento.git homebento
cd homebento
docker compose up -d --build
```

Then open `http://<server>:8095`. The compose file:

- uses the host network, so the dashboard reaches your services the same way you do,
- mounts the Docker socket (for the container list, actions and logs),
- mounts `/` read-only as `/host` for the disk usage of the host,
- keeps its data in `./data`.

> The Docker socket gives full control over Docker. Set a `PASSWORD` if others can reach the dashboard, and don't expose it to the internet without a login in front.

## Install without Docker

Node.js 20 or newer:

```bash
node server.js
```

## Settings

Environment variables:

| Variable | Default | |
|---|---|---|
| `PORT` | `8095` | Web port |
| `PASSWORD` | – | Optional login |
| `NOTIFY_URL` | – | POST target for status changes, e.g. `https://ntfy.sh/your-topic` |
| `CHECK_SECONDS` | `60` | How often services are checked (at least 15) |
| `DATA_DIR` | `./data` | Configuration, logins (`secrets.json`, mode 600) and history |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | |
| `HOST_ROOT` | `/` | Path whose disk usage is shown |
| `HOST_NAME` | hostname | Name of the server tile |
| `GITHUB_TOKEN` | – | Optional, for more GitHub requests than 60 an hour (Updates tile) |
| `TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock` | |

Everything else (services, logins, pages, tiles, title) is set in the dashboard.

## Integrations

| Service | Shows | Needs |
|---|---|---|
| Jellyfin | now playing, recently added, library size | API key (Dashboard → API Keys) |
| Sonarr, Radarr | upcoming episodes and movies in one calendar, queue, library size, health warnings | API key – read from the linked container automatically |
| Prowlarr | active indexers, health warnings | API key – read from the linked container automatically |
| qBittorrent | speed, active downloads | user and password, unless the local network may skip the login |
| Solar dashboard | power now, today's yield, day curve | – |
| MagicMirror Manager | process state, version, restart | password, if the manager has one |

Every other service gets status, response time, uptime, and – with a linked container – CPU, memory and container actions.

Logins are stored on the server only (`data/secrets.json`) and never sent to the browser. Jellyfin posters are loaded through the dashboard so the API key stays on the server.

## Tailscale

If the server runs [Tailscale](https://tailscale.com), HomeBento can make a service reachable in your tailnet with HTTPS – a switch in the service form, no `tailscale serve` commands:

- "Reachable through Tailscale" serves the service at `https://<machine>.<tailnet>.ts.net:<same port>` (tailnet only, not public).
- The settings list every Tailscale Serve entry of the machine, also those made by hand, and can remove them.
- When you open HomeBento itself through Tailscale (away from home), tiles open the services at their Tailscale address.

It needs tailscaled's socket (in the compose file: `/var/run/tailscale/tailscaled.sock`) and HTTPS certificates enabled for the tailnet. Only the entries you switch are changed; the rest of the serve configuration stays as it is.

## Docker labels

Containers are suggested with a guessed name, address and icon. Labels override the guess:

```yaml
labels:
  homebento.name: Sonarr
  homebento.href: https://sonarr.home.lan
  homebento.icon: sonarr
  homebento.ignore: "true"   # don't suggest this container
```

`homepage.name`, `homepage.href` and `homepage.icon` work as well.

## Development

```bash
npm test
```

| File | Purpose |
|---|---|
| `server.js` | HTTP server and API |
| `lib/store.js` | Configuration and logins |
| `lib/monitor.js` | Checks, hourly history, events |
| `lib/docker.js` | Docker Engine API over the socket |
| `lib/host.js` | CPU, memory, disk, temperature |
| `lib/integrations.js` | Jellyfin, Sonarr, Radarr, qBittorrent, solar, MagicMirror Manager |
| `lib/kinds.js` | Known services, icon and name guessing |
| `lib/releases.js` | GitHub releases of subscribed repositories |
| `lib/tailscale.js` | Tailscale Serve through tailscaled's local API |
| `public/` | The web app (no build step) |
| `prototypes/` | The first design studies |

## License

MIT
