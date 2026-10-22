# Service mode (Pulsar POS and fleet installs)

By default Thermal Bridge is a per-user background app that needs no admin
rights. An installer that is already elevated, such as Pulsar POS's, can
instead register it as a Windows service, which runs before anyone signs in
and serves every user on the machine.

## Commands

Run from an **elevated** prompt or installer:

```bat
ThermalBridge.exe --install-service
ThermalBridge.exe --uninstall-service
```

| Exit code | Meaning |
|---|---|
| `0` | Done |
| `5` | Not elevated. Nothing was changed, and the message explains how to run it as Administrator |
| `1` | Failed; the message says which step |

`ThermalBridge.exe` is a GUI program, so a console does not wait for it and
does not show its output unless you redirect it:

```bat
start /wait ThermalBridge.exe --install-service
ThermalBridge.exe --install-service > install.log 2>&1
```

From an installer script, wait for the process to exit and read its exit code.
From PowerShell, use `Start-Process -Wait -PassThru`. When output is not
redirected, the result is shown in a message box.

## What `--install-service` does

1. Checks the process is elevated, and stops with exit code 5 if not.
2. Copies `ThermalBridge.exe`, plus the embedded `ThermalBridgeService.exe`, to
   `%ProgramFiles%\ThermalBridge\`. A service runs as LocalSystem, and
   registering a binary under a user-writable folder such as `%LOCALAPPDATA%`
   would let that user run code as SYSTEM.
3. Creates `%ProgramData%\ThermalBridge\` with Administrators as owner, full
   control for SYSTEM and Administrators, and read-only access for Users (the
   POS reads `active_port.txt`).
4. Registers the service with `sc.exe`:
   - name `ThermalBridge`, display name **Thermal Bridge**
   - binary `"%ProgramFiles%\ThermalBridge\ThermalBridgeService.exe"` (quoted)
   - start type delayed automatic, running as LocalSystem
   - recovery: restart after 5 s, 10 s, then 30 s (the old service's settings)
5. Starts it, waits for `RUNNING`, then waits for `/health` to answer.

Running it again upgrades in place: it stops the service, replaces the files
and starts it again. `--uninstall-service` stops and deletes the service and
removes the program files. Settings and print history in `%ProgramData%\ThermalBridge`
are kept.

## How it runs

```
ThermalBridgeService.exe              the registered service; talks to the Service Control Manager
└── ThermalBridge.exe --service       supervisor (no tray: services have no desktop)
    └── ThermalBridge.exe --server    the print server, restarted after 5s / 10s / 30s
```

When Windows stops the service, the host closes the supervisor's stdin. The
supervisor asks the server to finish in-flight receipts (up to 15 s), then
exits. If the supervisor dies unexpectedly, the host exits with an error and
the service's recovery actions restart everything.

| | |
|---|---|
| Data, `config.json`, `data\jobs.db` | `%ProgramData%\ThermalBridge\` |
| Logs | `%ProgramData%\ThermalBridge\logs\` (`supervisor.log`, `service.log`, `console.log`) |
| Port files | `%ProgramData%\ThermalBridge\active_port.txt` and `data\service-endpoint.json` |
| Compatibility port files | `%ProgramData%\XPThermalService\active_port.txt` and `service-endpoint.json` |

## Same API, same discovery

Service mode serves the same HTTP API, the same port range (first free port
from 9100), and the same `/health` (`"service": "xp-thermal-service"`, plus
`"name": "Thermal Bridge"` and `"mode": "service"`).

It also writes the port files under `%ProgramData%\XPThermalService\`, which
Pulsar's `lib/print-service/client.ts` reads by literal path. **The POS adapter
needs no changes.** A site that sets `POS_THERMAL_DIR=C:\ProgramData\ThermalBridge`
reads the new location directly instead.

Pulsar's own origins (`pos.xenithpulse.local`, loopback on 8080/8090) are
merged into the allow-list on load in service mode, as before.

## Coexistence

| Already answering on 9100–9110 | Per-user app | Service |
|---|---|---|
| Old XP Thermal Print Service | Stands aside, shows "Printing is already handled by the installed service." | Stands aside |
| Thermal Bridge service | Stands aside, same notice | (the same service) |
| Nothing | Prints | Prints |

While standing aside, the app checks once a minute and takes over printing
after three misses in a row, so removing the old service hands over within
about three minutes.

`--install-service` warns when the old `xpthermalprintservice.exe` is still
registered. It does not remove it; that is the POS installer's decision:

```bat
sc stop xpthermalprintservice.exe
sc delete xpthermalprintservice.exe
```

## Pulsar POS today, and how it could switch

Nothing in the Pulsar repository was changed. Today Pulsar's `installer\build.ps1`
compiles this repository with `tsc`, and `installer\scripts\thermal.ps1`
deploys `dist/` to `C:\ProgramData\XPThermalService` and runs `node dist\index.js`
under its own WinSW wrapper (service `xpthermalprintservice.exe`). **That path
still works unchanged.** `node dist/index.js` runs the server in "legacy"
mode, with the same working-directory layout, port files and behaviour as
before the rebrand.

To move Pulsar onto the single exe instead:

1. Bundle `ThermalBridge-Portable-<version>.exe` (from the release, or
   `npm run build:exe`) in place of `thermal\app` and the WinSW daemon.
2. In `thermal.ps1 -Action Register`, remove the old service (`<wrapper> uninstall`,
   or `sc.exe delete xpthermalprintservice.exe`), then run
   `ThermalBridge-Portable-<version>.exe --install-service` and check for exit code 0.
3. Optionally import the old settings by copying
   `C:\ProgramData\XPThermalService\config.json` to `C:\ProgramData\ThermalBridge\config.json`
   before the first start.

### Updating the service from the manifest

Pulsar's updater (`lib/updates`) could keep a service-mode install current
from the same manifest it already knows how to read:

- URL `https://updates.xenithpulse.com/thermal-bridge/manifest.json`, channel `stable`, schema 1.
- The top-level entry is the per-user installer, which suits desktops rather
  than services. For a service, use the **`portable`** entry
  (`url`, `sha256`, `sizeBytes`), which needs only a small addition to
  `parseChannel`.
- Verify it as Pulsar already does (`downloadAndVerify` for SHA-256 and size,
  `inspectSignature` for Authenticode with publisher "XenithPulse"). Then, from
  the elevated `apply-update.ps1`, run `ThermalBridge-Portable-<version>.exe --install-service`.
  That stops the service, swaps the binaries and starts it again.
