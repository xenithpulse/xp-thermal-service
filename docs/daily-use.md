# Day-to-Day Operation

Audience: on-site IT installer and whoever supports the site afterwards. Covers the dashboard, routine tasks, and the operational rules that are not obvious.

See [install.md](install.md) to deploy, [troubleshooting.md](troubleshooting.md) when something breaks, [web-integration.md](web-integration.md) to connect a web app.

---

## Reaching the dashboard

```
http://127.0.0.1:<active-port>/dashboard
```

The quickest way is the tray icon → **Open dashboard**. Otherwise resolve `<active-port>` from `active_port.txt` in the settings folder (`%LOCALAPPDATA%\ThermalBridge` for the app, `%ProgramData%\ThermalBridge` for a service install) — it is **not** reliably 9100. See [install.md](install.md#read-this-first-the-dashboard-is-not-always-on-port-9100).

`http://127.0.0.1:<port>/` redirects to `/dashboard`. Note that the redirect **drops any query string**, which is a useful diagnostic: if a query parameter you did not type survives into the address bar, it was added by the browser or an extension, not by this service.

The dashboard is loopback-only and exempt from API-key checks. The service injects the API key into the page at serve time, so it authenticates its own API calls with no configuration.

---

## The pages

Every page starts with the status banner ("Ready to print · 2 of 2 printers online · Web apps print to http://127.0.0.1:9100", green, amber or red) and the **Detect printers** and **Print test page** buttons. Below it, anything waiting on you: a website asking to print, printers to import from XP Thermal Service, an update. The sidebar has **Overview**, **Printers**, **Jobs**, **Websites** and **Settings**; a red count on Jobs means something failed, an amber one on Websites means a site is waiting for an answer. The dashboard follows Windows light or dark mode, or pick one under Settings → General → Appearance.

| Page | What it is for |
|---|---|
| **Overview** | Health status, printer roles at a glance, recent activity. Start here. |
| **Printers** | Discovery, role assignment, diagnosis, repair, cash drawer, test prints. |
| **Jobs** | Individual print jobs — inspect, retry, cancel, clear failed. |
| **Queue** | Depth, pause/resume, throughput. |
| **Backup** | Pulsar POS database backups. Only shown on POS service installs. |
| **System** | Host info, connections, metrics, service restart. |
| **Settings** | **App** (version, Start with Windows, updates), **Websites** (allowed and blocked), Server, Security. |

---

## Printer roles

Printer ids are **roles**, not devices. `receipt` and `kitchen` are what the POS addresses. Which physical unit fills a role is configuration.

Consequences worth internalising:

- Swapping a failed printer for a new one is a role reassignment. **The POS needs no change.**
- Moving a printer to a different USB socket changes its Windows port. The service detects this and **Fix this** repoints the role.
- Deleting a role breaks every POS call that names it. Reassign rather than delete.

### Adding or replacing a printer

**Detect printers** → type a name → under **Use as**, click **Receipt**, **Kitchen (KOT)**, **Bar** or **Labels**. A test receipt prints automatically.

**Set Up Automatically** assigns discovered printers to open roles in one action — useful on a fresh install with one or two units, less so where role assignment matters.

If discovery reports *"Printer connected but not installed"*, the device is visible on USB but has no Windows driver. Install one — `Generic / Text Only` covers most ESC/POS hardware — then **Rescan**.

### Verifying a printer

- **Test print** — end-to-end: queue, connector, device, paper.
- **Details** — the full reasoning behind a status, not just the label.
- **Diagnose** — structured check of driver, port, spooler, and device state.
- **Fix this** / **Repair automatically** — applies the repair the diagnosis identified. Safe to run; it only performs the repairs it lists.
- **Reconnect** — re-establishes the connector without touching config.

### Cash drawer

**Test drawer now** fires the pulse. If nothing happens, the drawer is almost always on the other pin — try pin 2 versus pin 5 in the printer's settings, or lengthen the pulse. This is drawer wiring, not a software fault.

---

## Health status

`/health` and the Overview page report one of three values:

| Status | Meaning | Action |
|---|---|---|
| `healthy` | Can accept and complete work | None |
| `degraded` | Accepting work it cannot currently complete | Read `reasons`; a printer is usually offline |
| `unhealthy` | Cannot accept work at all | Restart the process; the watchdog will also act |

`reasons` is a plain-language array. It is the answer, not a hint — read it before investigating anything else.

This is deliberately **not** a liveness check. A running process with no working printer reports `degraded`, not `healthy`, because it cannot do its job.

---

## Restarting

The print server restarts itself if it ever exits, after 5 s, 10 s, then 30 s. To restart it deliberately:

1. **System** page → restart button, or
2. ```powershell
   $port = (type "$env:LOCALAPPDATA\ThermalBridge\active_port.txt").Trim()
   Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/service/restart"
   ```
   (loopback-only). In-flight receipts finish first, or
3. Tray → **Quit**, then start **Thermal Bridge** from the Start Menu. For a service install, `Restart-Service ThermalBridge` restarts all three processes.

The old XP Thermal Print Service is different: there, `Restart-Service` did not cycle the Node process. Use its restart endpoint or `legacy\install.ps1 -Restart`.

---

## Configuration changes

Most changes belong in the dashboard's **Settings** page, which applies them live.

Editing `config.json` in the settings folder by hand is supported — UTF-8 BOMs from Notepad are handled and rewritten out — but:

- A config that fails to parse is **backed up as `config.corrupt.*.json` and never overwritten.** If printers "vanish", restore from that file.
- The `metadata` block under each printer is written by the service. Do not hand-edit it; it records last-known-good USB port, driver, and hardware id.

### Allowing a POS origin

The first time a website calls the service, it appears at the top of the dashboard: *"https://pos.example.com wants to print"* with **Allow** and **Block**. Allow adds it to `security.allowedOrigins`; Block adds it to `security.blockedOrigins`, and blocked always wins. The **Websites** page lists both, can undo either, and can allow a site by hand before it has tried to print.

Until it is allowed, the site gets a **403 that names the origin** and says how to allow it. Loopback is always allowed on any port, as is the local network unless `allowPrivateNetwork` is turned off.

---

## Queue and jobs

- **Queue** → pause/resume stops dispatch without dropping work. Use it while swapping hardware.
- **Jobs** → **Retry** re-queues a failed job; **Clear Failed** discards them.
- Jobs that exhaust retries land in a dead-letter state and count against health.

Persistent queue depth with an idle printer means dispatch is blocked, not slow — check printer status before clearing anything.

---

## Backup

The **Backup** page shows status, lists available backups, and runs one on demand. Policy — schedule, retention, target — is owned by the POS dashboard; this page gives on-box control and inspection.

**Restore** overwrites the live database. Confirm the target before running it, and only during a service window.

---

## Logs

Tray → **Open logs folder**, or:

```
%LOCALAPPDATA%\ThermalBridge\logs\service.log      print server (service install: %ProgramData%\ThermalBridge\logs\)
%LOCALAPPDATA%\ThermalBridge\logs\supervisor.log   starts, restarts, standing aside for another service
%LOCALAPPDATA%\ThermalBridge\logs\console.log      anything the server printed, including crashes before logging started
```

Read `service.log` first. Go to `console.log` when the server fails to start at all, and to `supervisor.log` to see how often it has been restarted.

---

## Weekly sanity check

```powershell
$port = (type "$env:LOCALAPPDATA\ThermalBridge\active_port.txt").Trim()
$h = Invoke-RestMethod "http://127.0.0.1:$port/health"
"status : $($h.status)"
"reasons: $($h.reasons -join '; ')"
"queue  : pending=$($h.queue.pending) failed=$($h.queue.failed) dead=$($h.queue.deadLetter)"
"port   : $($h.port) (configured $($h.configuredPort))"
```

A `port` that differs from `configuredPort` is fine — but confirm it has not *changed* since handover, because the POS may be pinned to the old one.
