# Building Thermal Bridge

How `npm run build:exe` turns this repository into one Windows executable, why
it is built the way it is, and how a release reaches users.

## Quick reference

```bash
npm ci
npm run build:exe          # all three artifacts, in release/
npm run build:dashboard    # rebuild public/dashboard.html from src/dashboard/ (build:exe does this too)
npm run dev:dashboard      # the same, on every save
node scripts/build-exe.mjs --portable-only   # skip the installer (saves the minute its compression takes)
npm run publish:r2 -- --dry-run              # show what would be uploaded to the update channel
```

Needs Windows 10/11 x64 and Node.js 20 or newer to run the build, and nothing
else: the C# compiler that ships with the .NET Framework on every Windows
install builds the two helpers and the installer, and the installer's
compression is part of Windows. `signtool.exe` (Windows SDK) is only needed
for signing.

Output in `release/`:

| File | What it is | Size (3.0.1) |
|---|---|---|
| `ThermalBridge-Setup-<version>.exe` | Per-user installer | 29.0 MB |
| `ThermalBridge-Setup.exe` | The same file under a stable name, for `/releases/latest/download/` links | 29.0 MB |
| `ThermalBridge-Portable-<version>.exe` | The app itself; runs from anywhere | 86.7 MB |
| `SHA256SUMS.txt` | `sha256sum`-format checksums of the above | |
| `manifest.json` | Update manifest (schema 1, same as Pulsar POS) | |

The exe is large because it carries the Node.js runtime (about 80 MB of it).
The installer compresses it to about a third of that.

## The pipeline (`scripts/build-exe.mjs`)

1. **C# helpers.** `helpers/TrayHost.cs` → `ThermalBridgeTray.exe` (tray icon)
   and `helpers/ServiceHost.cs` → `ThermalBridgeService.exe` (Windows service
   wrapper), compiled with `%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
   and signed if a certificate is configured.
2. **Bundle.** esbuild compiles `src/app/main.ts` and every dependency into one
   CommonJS file, `dist/thermal-bridge.cjs` (`platform: node`, `target: node22`).
3. **Runtime.** Downloads the pinned Node.js 22 LTS `node.exe` (currently
   22.23.4, set in `NODE_VERSION`) from nodejs.org and checks it against the
   release's `SHASUMS256.txt`. Cached in `.cache/`.
4. **SEA blob.** That same `node.exe` runs `--experimental-sea-config sea-config.json`,
   which packs the bundle and the assets into `build/sea-prep.blob`. The blob
   must come from the Node version that will run it.
5. **The exe.** Copy `node.exe` → `build/ThermalBridge.exe`, then:
   - remove its OpenJS Foundation signature (`signtool remove /s`, or an
     equivalent built into the script when signtool is absent). Any change
     invalidates it anyway;
   - inject the blob with `postject` (sentinel fuse `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`);
   - replace the icon and version information with `resedit`:
     ProductName *Thermal Bridge*, CompanyName *XenithPulse*,
     FileDescription *Thermal Bridge — local receipt printing service*,
     LegalCopyright *© XenithPulse. MIT License.* Injection comes first:
     postject's PE parser rejects the relocation table resedit writes, while
     resedit happily edits postject's output;
   - mark it a Windows **GUI** program (PE subsystem 2), so double-clicking it
     never opens a console window;
   - sign it, if configured.
6. **Installer.** `installer/*.cs`, compiled twice with the same csc: first
   without a payload, which is `Uninstall.exe` (signed); then with
   `ThermalBridge.exe` packed inside and `Uninstall.exe` embedded, which is
   `ThermalBridge-Setup-<version>.exe` (signed). See [The installer](#the-installer).
7. **Checksums and manifest.** `SHA256SUMS.txt`, `manifest.json`, and the
   release notes (from `CHANGELOG.md`) in `build/release-notes.md`.

## Embedded assets

Declared in `sea-config.json` and read with `sea.getAsset()` through
`src/app/assets.ts`, which falls back to the repository files when not running
as an exe, so `npm run dev` and the tsc build behave as before:

| Asset | Used for |
|---|---|
| `public/dashboard.html` | The dashboard, built from `src/dashboard/` (below) |
| `assets/icon.ico` | Favicon, tray icon |
| `node_modules/sql.js/dist/sql-wasm.wasm` | The job store's SQLite, passed to sql.js as `wasmBinary` |
| `config.example.json` | Seeds `config.json` on first run, and repairs a corrupt one |
| `ThermalBridgeTray.exe`, `ThermalBridgeService.exe` | Extracted to `%LOCALAPPDATA%\ThermalBridge\bin` (tray) or `%ProgramFiles%\ThermalBridge` (service) when needed |

## The dashboard (`scripts/build-dashboard.mjs`)

The source is `src/dashboard/dashboard.html` (markup and script) and
`src/dashboard/dashboard.css` (the Tailwind CSS v4 entry: the XenithPulse
palette as light and dark theme tokens, plus a few component classes).
`npm run build:dashboard` compiles the stylesheet with the Tailwind CLI, keeping
only the classes the page uses, and inlines it into `public/dashboard.html`.

- **No CDN, on purpose.** Tills are often offline, and the exe serves the page
  from memory. The output is one self-contained file of about 180 KB.
- **The output is committed**, so `npm run dev`, the tsc build and Pulsar POS's
  copied install keep working without a build step. Edit `src/dashboard/`,
  never `public/dashboard.html`; the file says so in its first line.
- **`npm run lint` fails if it is stale** (`build-dashboard.mjs --check`), and
  `npm run build`, `npm run app` and `npm run build:exe` rebuild it first.
- Tailwind is a dev dependency only. Nothing of it runs in the app.

## Why Node SEA, not pkg

Node's Single Executable Applications handled every dependency, so
`@yao-pkg/pkg` was not needed. What made that possible:

- **No native addons at runtime** (audit below).
- **sql.js is WebAssembly.** Its `.wasm` is an SEA asset handed to `initSqlJs({ wasmBinary })`
  rather than looked up next to the script.
- **pino transports were replaced.** Transports run in a worker thread that
  loads its target module by file path, which cannot work from inside an exe.
  The logger now uses in-process streams (`pino.multistream`, `pino.destination`,
  `pino-pretty` as a stream). It is synchronous, which at a few lines per print
  job costs nothing measurable and means the last line before a crash is kept.
- **express** has a dynamic `require()` for view engines; this app renders no
  views, so that path is never reached.

## Native module audit

| Package | `.node` binary? | Status |
|---|---|---|
| `sql.js` | No. WebAssembly | Kept; `.wasm` embedded |
| `node-windows` | No addon, but ships `winsw.exe` and needs admin to install a service | **Removed.** Service mode now uses `sc.exe` and `ThermalBridgeService.exe` |
| express, cors, helmet, pino, pino-pretty, qrcode, rate-limiter-flexible, uuid, zod, commander | No | Bundled |
| `@unrs/resolver-binding-win32-x64-msvc` | Yes | Dev-only (jest); never bundled |
| `@esbuild/win32-x64` | Native exe | Dev-only (build tool) |

### USB printing: no native binary

USB (and any Windows-queue) printing pushes raw ESC/POS bytes through the
Windows spooler with `OpenPrinter` / `StartDocPrinter("RAW")` / `WritePrinter`
from `winspool.drv`. The call is a small C# P/Invoke shim (`src/printers/winspool.ts`)
that PowerShell compiles once with `Add-Type`. The result is cached as
`data\RawPrinterHelper-<hash>.dll`, and the name carries a hash of the source so
an update never loads a stale copy. If compiling is impossible on a locked-down
machine, each job compiles it inline instead.

Why this over the alternatives:

- **`Out-Printer`** sends text through the printer driver, which renders it.
  ESC/POS control bytes get mangled, and cutting or opening the drawer stops
  working. Only the `RAW` datatype passes bytes through untouched.
- **A `.node` addon** would be tied to one Node ABI, need extracting to disk at
  first run, and is the kind of file antivirus products quarantine. The
  spooler route works with whatever driver the printer came with, needs nothing
  extracted, and was already proven in the field.

## The two C# helpers, and why not systray2

**Tray icon.** `systray2` drives a prebuilt Go binary from a third party,
which we could not sign with our certificate or easily audit, and it locates
that binary relative to its own package folder, which does not exist inside a
single exe. `ThermalBridgeTray.exe` is about 15 KB of WinForms `NotifyIcon`
compiled from source in this repository, with the compiler already used for
the printing shim, and signed with the release certificate. It speaks one line
per message over stdin/stdout (`src/app/tray.ts`) and exits when its stdin
closes, so the icon can never outlive the app.

**Service host.** Windows only starts a service binary that answers the
Service Control Manager, which a Node executable cannot do.
`ThermalBridgeService.exe` does only that: it starts `ThermalBridge.exe --service`
and closes its stdin when Windows stops the service. See [SERVICE-MODE.md](SERVICE-MODE.md).

## The installer

`installer/` is our own setup program, written in C# and built with the
same compiler as the helpers, rather than a third-party installer tool: the
window is the XenithPulse brand (the emerald pulse and wordmark, drawn from the
brand kit's vector geometry, sharp at any display scale), the build needs
nothing installed, and every file it writes is ours.

| File | Role |
|---|---|
| `Setup.cs` | Entry point, command line, the uninstaller's hand-over to `%TEMP%` |
| `Engine.cs` | What installing and uninstalling do; no UI |
| `SetupWindow.cs`, `Controls.cs`, `Brand.cs` | The window, its controls, the brand drawing |
| `Lzms.cs` | The payload codec (below) |
| `Pack.cs` | Build-time only: compresses `ThermalBridge.exe` |
| `setup.manifest` | `asInvoker` (no UAC, and no "installer detection" elevation), Windows 10/11, per-monitor DPI |

**What it does.** Installs for the current user only, with no admin rights:
asks a running copy to quit (`ThermalBridge.exe --quit`, the same named-pipe
command the tray uses), unpacks the app and checks its SHA-256 against the
value baked in at build time, swaps it into
`%LOCALAPPDATA%\Programs\ThermalBridge` (a running exe can be renamed but not
overwritten, so the old one is moved aside first), writes `Uninstall.exe`, the
Start Menu shortcut and the `HKCU\...\Uninstall\ThermalBridge` entry, then
starts the app. A normal install takes about five seconds. It never touches
`%LOCALAPPDATA%\ThermalBridge`, where settings and the print queue live.

**Payload.** LZMS through the Windows Compression API (`cabinet.dll`, Windows 8
and later): `ThermalBridge.exe` goes from 86.7 MB to 28.8 MB and unpacks in a
second or two. LZMA would be about 5 MB smaller, but needs a decompressor
carried in the installer; LZMS is part of Windows and is what the build uses to
pack it, so there is no codec of our own to get wrong. Packing takes about a
minute.

**Command line.**

| | |
|---|---|
| `ThermalBridge-Setup.exe` | Install, with the window |
| `/S` (or `/SILENT`, `/VERYSILENT`) | Install silently, then start the app with `--background` |
| `/S /NOLAUNCH` | Install silently, start nothing |
| `--update` | What "Install update" in the dashboard runs: install straight away with a progress window, restart the app in the background, close |
| `Uninstall.exe [/S]` | Uninstall; silent keeps settings and print history |
| `/uninstall` | The same, from the setup file |

Exit codes: `0` done, `1` failed, `2` cancelled. `/SUPPRESSMSGBOXES` and
`/NORESTART` are accepted and ignored. Every run logs to
`%TEMP%\ThermalBridge-Setup.log`.

**Uninstalling.** `Uninstall.exe` cannot delete itself or the folder it runs
from, so the copy in the program folder starts a copy of itself in `%TEMP%` and
waits. The copy removes the app, the shortcut, the Apps & Features entry and the
"Start with Windows" value (only if it points at this install), signals the
waiting copy (so whoever ran `Uninstall.exe /S` sees it finish), then deletes
`Uninstall.exe` and the folder once that copy has exited, and is itself deleted
a moment later. If settings are kept, it also clears `startupConfigured` from
`app-state.json`, so a later install starts with Windows again.

**From 3.0.1's first installer.** The first 3.0.1 builds were packaged with a
different tool, which registered `{B6E0F7A2-3C1D-4E8B-9A57-2D4C6E8F1B30}_is1`
and left `unins000.exe`/`.dat` beside the app. Installing over it removes both,
so Apps & Features lists one Thermal Bridge.

**Checking the window.** `SetupWindow.Preview(page, ...)` puts the window on
any page without doing anything, so each page can be rendered to an image (for
instance with `DrawToBitmap` from a small harness that loads the exe by
reflection) after a design change.

## The exe is a GUI program

So that nothing ever flashes a console window, the exe's PE subsystem is set
to GUI. Node supports this: with no console attached, `process.stdout` and
`stderr` become no-op streams. The command-line flags (`--install-service`,
`--version`, ...) therefore write to stdout only when a caller redirected it, as
an installer capturing output does, and otherwise show a message box. Exit codes
are always set. From a command prompt, use `start /wait ThermalBridge.exe --install-service`
to wait for the result.

## Code signing

Unsigned executables trigger SmartScreen's "Windows protected your PC".
Signing is optional in the build and switched on by environment variables:

| Variable | Meaning |
|---|---|
| `SIGN_THUMBPRINT` | SHA-1 thumbprint of a certificate in the Windows store, the same approach as Pulsar's `build.ps1 -SignThumbprint` |
| `SIGN_PFX_PATH`, `SIGN_PFX_PASSWORD` | Or a `.pfx` file (what CI uses) |
| `SIGN_TIMESTAMP_URL` | Default `http://timestamp.digicert.com` |
| `SIGNTOOL_PATH` | Override signtool discovery |

When set, the build signs both helpers (before they are embedded),
`ThermalBridge.exe`, the uninstaller and the installer, with SHA-256 digests
and RFC 3161 timestamps. When absent, the build completes and prints a warning.

The update check accepts an installer only if Windows reports its Authenticode
signature as `Valid` and the signer's subject contains "XenithPulse". That is
the same rule as Pulsar's updater, so **until releases are signed, "Check
for updates" will offer the download page instead of running the installer.**

## Releases and downloads

| | URL |
|---|---|
| Public home (open source) | <https://github.com/xenithpulse/xp-thermal-service/releases> |
| Always the latest installer | <https://github.com/xenithpulse/xp-thermal-service/releases/latest/download/ThermalBridge-Setup.exe> |
| Update channel and download mirror | <https://updates.xenithpulse.com/thermal-bridge/ThermalBridge-Setup.exe> |
| Update manifest | <https://updates.xenithpulse.com/thermal-bridge/manifest.json> |
| Checksums | `…/thermal-bridge/SHA256SUMS.txt` on R2, and on each GitHub release |

GitHub Releases stays the public home. Cloudflare R2, the bucket Pulsar POS
already publishes to, is the update channel and a faster mirror.

### The update channel (`npm run publish:r2`)

`scripts/publish-r2.mjs` mirrors Pulsar's `installer/build.ps1 -Publish`:

- **rclone**, with the same remote, bucket and domain defaults:
  `PUBLISH_REMOTE=r2pos`, `PUBLISH_BUCKET=xp-pos-releases`,
  `PUBLISH_DOMAIN=updates.xenithpulse.com`, `PUBLISH_CHANNEL=stable`.
- **Credentials stay with rclone**, as for Pulsar: the `[r2pos]` section of
  `rclone.conf`, or `RCLONE_CONFIG_R2POS_ACCESS_KEY_ID`,
  `RCLONE_CONFIG_R2POS_SECRET_ACCESS_KEY` and `RCLONE_CONFIG_R2POS_ENDPOINT`
  (plus `..._TYPE=s3`, `..._PROVIDER=Cloudflare`). The script never reads or
  prints them, and none are stored in this repository.
- **A local `.env`** in the repository root (gitignored) is loaded by both
  `build-exe.mjs` and `publish-r2.mjs`, so the variables above, the signing
  variables, and `POS_RELEASE_BUCKET` / `POS_RELEASE_DOMAIN` (accepted in place
  of `PUBLISH_BUCKET` / `PUBLISH_DOMAIN`) can live there. Anything already set
  in the environment, as in CI, wins over the file.
- **Only `thermal-bridge/`.** Every key is checked against that prefix before
  upload. Pulsar's `manifest.json` and `releases/` at the bucket root are never
  written.
- **Order and safety, as in Pulsar:** check the remote, refuse to overwrite a
  published version without `--force`, upload the binaries, then read the live
  `thermal-bridge/manifest.json`, replace only this channel, and upload it last.
  It then checks from outside, the way an updater sees it.
- Versioned exes are cached as immutable; `ThermalBridge-Setup.exe`,
  `SHA256SUMS.txt` (5 minutes) and `manifest.json` (60 seconds) are not.

The manifest uses Pulsar's schema, plus an optional `portable` entry that
Pulsar's reader ignores:

```json
{
  "schema": 1,
  "channels": {
    "stable": {
      "version": "3.0.1",
      "url": "https://updates.xenithpulse.com/thermal-bridge/ThermalBridge-Setup-3.0.1.exe",
      "sha256": "<64 lowercase hex>",
      "sizeBytes": 24257021,
      "releasedAt": "2026-10-22T11:36:24Z",
      "notes": "…",
      "portable": { "url": "…/ThermalBridge-Portable-3.0.1.exe", "sha256": "…", "sizeBytes": 90873344 }
    }
  }
}
```

### The release workflow

`.github/workflows/release.yml` runs on a `v*` tag, on `windows-latest`: install,
lint, test, check that the tag matches `package.json`, build (signed when the
certificate secrets exist), create the GitHub Release
with all artifacts and the CHANGELOG section as notes, then publish the same
files to R2 when the R2 secrets exist.

To release: bump `version` in `package.json` **and** `VERSION` in
`src/app/identity.ts` (a test and the build both fail if they differ), add a
`## v<version>` section to `CHANGELOG.md`, then push the tag.

## Supported Windows versions

Windows 10 and 11, x64. Node.js 22 does not run on Windows 7 or 8.1, so neither
does Thermal Bridge.

## TODO for Joseph

- [ ] **App icon.** `assets/icon.ico` is drawn by `scripts/make-icon.mjs` (a
  receipt hanging from a bridge arch). It is legible at 16 px but was not made
  by a designer. Replace the `.ico` and `.png`, and the `LOGO` SVG in
  `src/dashboard/dashboard.html`, if you want something better. The installer uses `icon.png` as is.
- [ ] **Code-signing certificate.** Get an OV certificate, or use Azure
  Trusted Signing, ideally the same one Pulsar's Authenticode-verified updates
  will use. Then add repository secrets `SIGN_PFX_BASE64` (the `.pfx`,
  base64-encoded) and `SIGN_PFX_PASSWORD`.
- [ ] **R2 secrets for CI.** Add `RCLONE_CONFIG_R2POS_ACCESS_KEY_ID`,
  `RCLONE_CONFIG_R2POS_SECRET_ACCESS_KEY` and `RCLONE_CONFIG_R2POS_ENDPOINT`
  (`https://<account_id>.r2.cloudflarestorage.com`), using an R2 API token
  scoped to the bucket with Object Read & Write.
- [ ] **Repository name.** Still `xp-thermal-service`. GitHub redirects old
  URLs if it is renamed; update `RELEASES_URL` and `GITHUB_LATEST_URL` in
  `src/app/` afterwards.
