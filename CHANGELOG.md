# Changelog

## v3.0.1 — Thermal Bridge: single-file installer, no admin, no Node.js required

XP Thermal Service is now **Thermal Bridge by XenithPulse**.

### Install and run
- One installer, `ThermalBridge-Setup.exe`, in the XenithPulse look: one click and about five seconds, for the current Windows user with no UAC prompt. Node.js is built in. A portable exe is published alongside it.
- Updating or reinstalling keeps printers and settings. Uninstalling (Settings → Apps) keeps them too unless you tick **Also delete printer settings and print history**.
- Silent install for fleets: `ThermalBridge-Setup.exe /S` (add `/NOLAUNCH` to install without starting). Silent uninstall: `Uninstall.exe /S`. Every run logs to `%TEMP%\ThermalBridge-Setup.log`.
- Runs as a background app with a system tray icon (open dashboard, print test page, printers, Start with Windows, logs, updates, quit).
- Starts with Windows through the current user's Run key, toggled from the tray or the dashboard.
- A small supervisor restarts the print server after 5s, 10s, then 30s if it exits. Jobs queued before a crash or reboot still print.
- Only one copy runs per user. Launching it again opens the dashboard.
- Windows service mode for POS and fleet installs: `ThermalBridge.exe --install-service` / `--uninstall-service`.
- Stands aside when the old XP Thermal Print Service or a Thermal Bridge service is already printing on the PC.

### Dashboard
- Rebuilt with Tailwind CSS in the XenithPulse palette, with light and dark themes (follows Windows, or choose in Settings). The styles are compiled at build time and inlined, so the dashboard needs no internet connection.
- A status banner on every page ("Ready to print · 2 of 2 printers online · Web apps print to http://127.0.0.1:9100") with **Detect printers** and **Print test page**.
- Pages for Overview, Printers, Jobs, Websites and Settings. The Queue controls moved into Jobs, and system details into Settings → About. Old links (`#queue`, `#system`, `#updates`) still work.
- Printer cards show what each printer is for, why it is not ready and a **Fix this** button where a repair exists. Jobs are listed in plain words (Waiting, Printing, Printed, Gave up) with failures explained inline.
- A **Websites** page: answer pending requests, allow a site by hand, and undo Allow or Block.
- Confirmations, toasts and dialogs are the dashboard's own rather than browser pop-ups, and stay readable over an open dialog.
- **Detect printers** finds Windows printers and scans the network on port 9100. Name each printer and choose its role (Receipt, Kitchen, Label).
- Website pairing: "https://example-pos.com wants to print — Allow / Block", instead of editing `allowedOrigins` by hand.
- Imports printers from an existing XP Thermal Service install.
- Check for updates: downloads from the update channel, verifies the SHA-256 and the Authenticode signature, then updates in place. The installer shows its progress and restarts Thermal Bridge by itself.

### Security
- Listens on `127.0.0.1` only. No firewall rule is created, and no firewall prompt appears.
- The default `allowedOrigins` is `http://localhost:3000` and `http://127.0.0.1:3000`. The example config ships with no sample printers.

### API
- No changes to paths, request or response shapes, error codes or the port range.
- `/health` adds `name` ("Thermal Bridge") and `mode`. `version` now reports the real version; it was always "1.0.0". `service` is still `xp-thermal-service`.
- New, dashboard-only routes: `/api/app/*` and `/api/origins`.

### Removed
- `node-windows`, `setup.bat` and `scripts/install.ps1`. The scripts moved to `legacy/` for repairing or removing old installs.
- The Windows 7 support claim. The built-in Node.js 22 runtime needs Windows 10 or 11.
