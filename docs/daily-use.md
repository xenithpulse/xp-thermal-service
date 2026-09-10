# Day-to-Day Operation

Audience: on-site IT installer and whoever supports the site afterwards. Covers the dashboard, routine tasks, and the operational rules that are not obvious.

See [install.md](install.md) to deploy, [troubleshooting.md](troubleshooting.md) when something breaks.

---

## Reaching the dashboard

```
http://127.0.0.1:<active-port>/dashboard
```

Resolve `<active-port>` from `%ProgramData%\XPThermalService\active_port.txt` — it is **not** reliably 9100. See [install.md](install.md#read-this-first-the-dashboard-is-not-always-on-port-9100).

`http://127.0.0.1:<port>/` redirects to `/dashboard`. Note that the redirect **drops any query string**, which is a useful diagnostic: if a query parameter you did not type survives into the address bar, it was added by the browser or an extension, not by this service.

The dashboard is loopback-only and exempt from API-key checks. The service injects the API key into the page at serve time, so it authenticates its own API calls with no configuration.

---

## The seven pages

| Page | What it is for |
|---|---|
| **Overview** | Health status, printer roles at a glance, recent activity. Start here. |
| **Printers** | Discovery, role assignment, diagnosis, repair, cash drawer, test prints. |
| **Jobs** | Individual print jobs — inspect, retry, cancel, clear failed. |
| **Queue** | Depth, pause/resume, throughput. |
| **Backup** | Database backup status, run a backup, restore from one. |
| **System** | Host info, connections, metrics, service restart. |
| **Settings** | Server config, API key, allowed origins, printer editing. |

---

## Printer roles

Printer ids are **roles**, not devices. `receipt` and `kitchen` are what the POS addresses. Which physical unit fills a role is configuration.

Consequences worth internalising:

- Swapping a failed printer for a new one is a role reassignment. **The POS needs no change.**
- Moving a printer to a different USB socket changes its Windows port. The service detects this and **Fix this** repoints the role.
- Deleting a role breaks every POS call that names it. Reassign rather than delete.

### Adding or replacing a printer

**Printers** → **Find Printers** → **Use as Receipt** / **Use as Kitchen**. A test receipt prints automatically.

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

## Restarting — read this carefully

**`Restart-Service` does not cycle the Node child process.** The wrapper restarts; the process doing the work does not. A new build or a config change that requires a restart will appear not to take effect.

Correct methods:

1. **System** page → restart button, or
2. ```powershell
   $port = (type "$env:ProgramData\XPThermalService\active_port.txt").Trim()
   Invoke-RestMethod -Method Post "http://127.0.0.1:$port/api/service/restart"
   ```
   (loopback-only), or
3. `powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -Restart`

---

## Configuration changes

Most changes belong in the dashboard's **Settings** page, which applies them live.

Editing `%ProgramData%\XPThermalService\config.json` by hand is supported — UTF-8 BOMs from Notepad are handled and rewritten out — but:

- A config that fails to parse is **backed up as `config.corrupt.*.json` and never overwritten.** If printers "vanish", restore from that file.
- The `metadata` block under each printer is written by the service. Do not hand-edit it; it records last-known-good USB port, driver, and hardware id.

### Allowing a POS origin

Browser-based POS clients need their origin in `security.allowedOrigins`. A rejected origin returns a **403 that names the origin and how to allow it** — read the response body, it tells you exactly what to add.

Loopback is always allowed on any port and never needs listing.

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

```
%ProgramData%\XPThermalService\logs\          service log
%ProgramData%\XPThermalService\daemon\*.log   wrapper stdout/stderr
%TEMP%\XPThermalInstall_*.log                 installer transcript
```

Read the service log first. Go to the daemon log only when the process is failing to start at all — that is where a crash before logging initialises will surface.

---

## Weekly sanity check

```powershell
$port = (type "$env:ProgramData\XPThermalService\active_port.txt").Trim()
$h = Invoke-RestMethod "http://127.0.0.1:$port/health"
"status : $($h.status)"
"reasons: $($h.reasons -join '; ')"
"queue  : pending=$($h.queue.pending) failed=$($h.queue.failed) dead=$($h.queue.deadLetter)"
"port   : $($h.port) (configured $($h.configuredPort))"
```

A `port` that differs from `configuredPort` is fine — but confirm it has not *changed* since handover, because the POS may be pinned to the old one.
