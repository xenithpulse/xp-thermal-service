#!/usr/bin/env node
/**
 * Builds Thermal Bridge into release/:
 *
 *   ThermalBridge-Setup-<version>.exe     per-user installer (installer/*.cs)
 *   ThermalBridge-Setup.exe               the same file, stable name for /latest links
 *   ThermalBridge-Portable-<version>.exe  runs from anywhere, no install
 *   SHA256SUMS.txt, manifest.json         for GitHub Releases and the R2 update channel
 *
 * Steps: compile the two C# helpers -> bundle with esbuild -> Node SEA blob ->
 * copy node.exe, set icon and version info, inject the blob, mark it a GUI
 * program -> sign (optional) -> installer (Uninstall.exe, the LZMS-packed app,
 * and the setup exe around them) -> checksums and manifest.
 * docs/BUILD.md explains each decision.
 *
 *   node scripts/build-exe.mjs [--portable-only]
 *
 * Signing (optional; unsigned builds print a warning):
 *   SIGN_THUMBPRINT            certificate in the Windows store (as Pulsar's -SignThumbprint)
 *   SIGN_PFX_PATH              or a .pfx file, with SIGN_PFX_PASSWORD
 *   SIGN_TIMESTAMP_URL         default http://timestamp.digicert.com
 *   SIGNTOOL_PATH              override signtool discovery
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import * as ResEdit from 'resedit';
import postject from 'postject';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = (...p) => path.join(root, ...p);
const portableOnly = process.argv.includes('--portable-only');

// Local settings and secrets (gitignored). Variables already set in the
// environment, as in CI, win over the file.
try {
  process.loadEnvFile(at('.env'));
} catch {
  // No .env: use the environment as it is.
}

/** Node 22 LTS runtime embedded in the exe. Bump deliberately; see docs/BUILD.md. */
const NODE_VERSION = process.env.SEA_NODE_VERSION || '22.23.4';
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const META = {
  ProductName: 'Thermal Bridge',
  CompanyName: 'XenithPulse',
  FileDescription: 'Thermal Bridge — local receipt printing service',
  LegalCopyright: '© XenithPulse. MIT License.',
  OriginalFilename: 'ThermalBridge.exe',
  InternalName: 'ThermalBridge'
};

const step = (msg) => console.log(`\n▸ ${msg}`);
const warn = (msg) => console.warn(`\n  WARNING: ${msg}`);
const run = (exe, args, opts = {}) => execFileSync(exe, args, { stdio: 'inherit', cwd: root, ...opts });
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ── Version ───────────────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(at('package.json'), 'utf8'));
const version = pkg.version;
const identity = fs.readFileSync(at('src', 'app', 'identity.ts'), 'utf8');
const coded = /export const VERSION = '([^']+)'/.exec(identity)?.[1];
if (coded !== version) {
  throw new Error(`package.json says ${version} but src/app/identity.ts says ${coded}. Make them match.`);
}
const numeric = /^(\d+)\.(\d+)\.(\d+)/.exec(version).slice(1).map(Number);
console.log(`Thermal Bridge ${version}`);

// ── Tools ─────────────────────────────────────────────────────────────────────
function findSigntool() {
  if (process.env.SIGNTOOL_PATH) return process.env.SIGNTOOL_PATH;
  const kits = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Windows Kits', '10', 'bin');
  if (!fs.existsSync(kits)) return null;
  const versions = fs.readdirSync(kits).filter((d) => /^10\./.test(d)).sort().reverse();
  for (const v of versions) {
    const candidate = path.join(kits, v, 'x64', 'signtool.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const signtool = findSigntool();
const signing = (() => {
  const thumb = process.env.SIGN_THUMBPRINT;
  const pfx = process.env.SIGN_PFX_PATH;
  if (!thumb && !pfx) return null;
  if (!signtool) throw new Error('A signing certificate is configured but signtool.exe was not found. Set SIGNTOOL_PATH.');
  const ts = process.env.SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
  const who = thumb ? ['/sha1', thumb] : ['/f', pfx, ...(process.env.SIGN_PFX_PASSWORD ? ['/p', process.env.SIGN_PFX_PASSWORD] : [])];
  return ['sign', ...who, '/fd', 'sha256', '/tr', ts, '/td', 'sha256', '/d', 'Thermal Bridge', '/q'];
})();

function sign(file) {
  if (!signing) return;
  execFileSync(signtool, [...signing, file], { stdio: 'inherit' });
}

// ── 1. Clean ──────────────────────────────────────────────────────────────────
step('Cleaning build/ and release/');
fs.rmSync(at('build'), { recursive: true, force: true });
fs.rmSync(at('release'), { recursive: true, force: true });
fs.mkdirSync(at('build', 'helpers'), { recursive: true });
fs.mkdirSync(at('release'), { recursive: true });

// ── 2. C# helpers (tray icon host, Windows service host) ─────────────────────
step('Compiling the tray and service helpers');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!fs.existsSync(csc)) throw new Error(`The .NET Framework C# compiler was not found at ${csc}.`);

const helpers = [
  { source: 'TrayHost.cs', out: 'ThermalBridgeTray.exe', title: 'Thermal Bridge tray icon', refs: ['System.Windows.Forms.dll', 'System.Drawing.dll'] },
  { source: 'ServiceHost.cs', out: 'ThermalBridgeService.exe', title: 'Thermal Bridge service host', refs: ['System.ServiceProcess.dll'] }
];
for (const h of helpers) {
  run(csc, [
    '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
    `/win32icon:${at('assets', 'icon.ico')}`,
    `/out:${at('build', 'helpers', h.out)}`,
    ...h.refs.map((r) => `/r:${r}`),
    at('helpers', h.source), assemblyInfo(at('build', 'helpers', `${h.out}.AssemblyInfo.cs`), h.title)
  ]);
  sign(at('build', 'helpers', h.out));
}

// ── 3. Bundle ─────────────────────────────────────────────────────────────────
step('Bundling with esbuild');
await esbuild.build({
  entryPoints: [at('src', 'app', 'main.ts')],
  outfile: at('dist', 'thermal-bridge.cjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  define: { __THERMAL_BRIDGE_EXE__: 'true' },
  legalComments: 'none',
  logLevel: 'warning',
  // express can load view engines by name; this app renders no views.
  logOverride: { 'unsupported-require-call': 'silent' }
});

// ── 4. Node runtime ───────────────────────────────────────────────────────────
step(`Fetching Node ${NODE_VERSION} (win-x64)`);
const cacheDir = at('.cache');
const nodeExe = path.join(cacheDir, `node-v${NODE_VERSION}-win-x64.exe`);
if (!fs.existsSync(nodeExe)) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = /^([0-9a-f]{64})\s+win-x64\/node\.exe$/m.exec(sums)?.[1];
  if (!expected) throw new Error(`No win-x64/node.exe checksum in ${base}/SHASUMS256.txt`);
  const res = await fetch(`${base}/win-x64/node.exe`);
  if (!res.ok) throw new Error(`Downloading node.exe failed: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expected) throw new Error(`node.exe checksum mismatch: expected ${expected}, got ${actual}`);
  fs.writeFileSync(nodeExe, data);
}
console.log(`  ${nodeExe}`);

// ── 5. SEA blob (generated by the same Node that will run it) ─────────────────
step('Generating the SEA blob');
run(nodeExe, ['--experimental-sea-config', 'sea-config.json']);

// ── 6. The executable ─────────────────────────────────────────────────────────
step('Building ThermalBridge.exe');
const exePath = at('build', 'ThermalBridge.exe');
fs.copyFileSync(nodeExe, exePath);

// node.exe is signed by the OpenJS Foundation; any change invalidates that
// signature, so it is removed first.
if (signtool) {
  run(signtool, ['remove', '/s', exePath]);
} else {
  stripSignature(exePath);
}

// Inject first: postject's PE parser (LIEF) rejects the relocation table
// resedit writes, while resedit is happy to edit an exe postject produced.
await postject.inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(at('build', 'sea-prep.blob')), {
  sentinelFuse: SEA_FUSE,
  overwrite: true
});
setIconAndVersion(exePath);
setGuiSubsystem(exePath);
sign(exePath);

const portable = at('release', `ThermalBridge-Portable-${version}.exe`);
fs.copyFileSync(exePath, portable);

// ── 7. Installer ──────────────────────────────────────────────────────────────
// installer/*.cs, compiled twice: without the app inside it is Uninstall.exe;
// with the app (LZMS-packed) and Uninstall.exe embedded, it is the setup.
const outputs = [portable];
if (portableOnly) {
  warn('--portable-only: the installer was not built.');
} else {
  step('Building the installer');
  const dir = at('build', 'installer');
  fs.mkdirSync(dir, { recursive: true });
  const sources = ['Setup.cs', 'SetupWindow.cs', 'Controls.cs', 'Brand.cs', 'Engine.cs', 'Lzms.cs'].map((f) => at('installer', f));
  const common = [
    '/nologo', '/target:winexe', '/optimize+', '/codepage:65001',
    `/win32icon:${at('assets', 'icon.ico')}`,
    `/win32manifest:${at('installer', 'setup.manifest')}`,
    `/resource:${at('assets', 'icon.png')},icon.png`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', '/r:System.Web.Extensions.dll'
  ];

  const uninstaller = path.join(dir, 'Uninstall.exe');
  run(csc, [
    ...common, `/out:${uninstaller}`, ...sources,
    buildInfo(path.join(dir, 'Uninstall.BuildInfo.cs'), 0, ''),
    assemblyInfo(path.join(dir, 'Uninstall.AssemblyInfo.cs'), 'Thermal Bridge Uninstall')
  ]);
  sign(uninstaller);

  // Packed with the Windows API that unpacks it, so setup needs no codec of its own.
  const packer = path.join(dir, 'Pack.exe');
  run(csc, ['/nologo', '/target:exe', '/optimize+', `/out:${packer}`, at('installer', 'Pack.cs'), at('installer', 'Lzms.cs')]);
  const payload = path.join(dir, 'ThermalBridge.exe.lzms');
  console.log('  Compressing ThermalBridge.exe (LZMS, about a minute)');
  run(packer, [exePath, payload]);

  const setup = at('release', `ThermalBridge-Setup-${version}.exe`);
  run(csc, [
    ...common, `/out:${setup}`,
    `/resource:${payload},ThermalBridge.exe.lzms`,
    `/resource:${uninstaller},Uninstall.exe`,
    ...sources,
    // Setup checks the unpacked exe against this before installing it.
    buildInfo(path.join(dir, 'Setup.BuildInfo.cs'), fs.statSync(exePath).size, sha256(exePath)),
    assemblyInfo(path.join(dir, 'Setup.AssemblyInfo.cs'), 'Thermal Bridge Setup')
  ]);
  sign(setup);
  const stable = at('release', 'ThermalBridge-Setup.exe');
  fs.copyFileSync(setup, stable);
  outputs.unshift(setup, stable);
}

// ── 8. Checksums and update manifest ─────────────────────────────────────────
step('Writing SHA256SUMS.txt and manifest.json');
const sums = outputs.map((f) => `${sha256(f)}  ${path.basename(f)}`).join('\n') + '\n';
fs.writeFileSync(at('release', 'SHA256SUMS.txt'), sums);

const domain = process.env.PUBLISH_DOMAIN || process.env.POS_RELEASE_DOMAIN || 'updates.xenithpulse.com';
const channel = process.env.PUBLISH_CHANNEL || 'stable';
const baseUrl = `https://${domain}/thermal-bridge`;
const fileEntry = (file) => ({
  url: `${baseUrl}/${path.basename(file)}`,
  sha256: sha256(file),
  sizeBytes: fs.statSync(file).size
});
// The GitHub release body; build/ rather than release/ so it is not uploaded as a file.
fs.writeFileSync(at('build', 'release-notes.md'), changelogNotes(version) || `Thermal Bridge ${version}`);
if (!portableOnly) {
  const manifest = {
    schema: 1,
    channels: {
      [channel]: {
        version,
        ...fileEntry(outputs[0]),
        releasedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        notes: shorten(changelogNotes(version), 2000),
        portable: fileEntry(portable)
      }
    }
  };
  fs.writeFileSync(at('release', 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

step('Done');
for (const f of [...outputs, at('release', 'SHA256SUMS.txt')]) {
  console.log(`  ${path.relative(root, f).padEnd(48)} ${(fs.statSync(f).size / 1048576).toFixed(1)} MB`);
}
if (!signing) {
  warn('These executables are NOT code-signed, so Windows SmartScreen will warn before running them. ' +
    'Set SIGN_THUMBPRINT or SIGN_PFX_PATH to sign (see docs/BUILD.md).');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Version information for a C# program, as assembly attributes csc turns into a VERSIONINFO resource. */
function assemblyInfo(file, title) {
  fs.writeFileSync(file, [
    'using System.Reflection;',
    `[assembly: AssemblyTitle("${title}")]`,
    `[assembly: AssemblyDescription("${title}")]`,
    `[assembly: AssemblyCompany("${META.CompanyName}")]`,
    `[assembly: AssemblyProduct("${META.ProductName}")]`,
    `[assembly: AssemblyCopyright("${META.LegalCopyright}")]`,
    `[assembly: AssemblyVersion("${numeric.join('.')}.0")]`,
    `[assembly: AssemblyFileVersion("${numeric.join('.')}.0")]`,
    `[assembly: AssemblyInformationalVersion("${version}")]`,
    ''
  ].join('\r\n'), 'utf8');
  return file;
}

/** What the installer is installing: its version, and the size and hash of the packed exe. */
function buildInfo(file, appSize, appSha256) {
  fs.writeFileSync(file, [
    '// Generated by scripts/build-exe.mjs.',
    'static class BuildInfo',
    '{',
    `    public const string Version = "${version}";`,
    `    public const long AppSize = ${appSize};`,
    `    public const string AppSha256 = "${appSha256}";`,
    '}',
    ''
  ].join('\r\n'), 'utf8');
  return file;
}

/** Drop an Authenticode signature by hand when signtool is not installed. */
function stripSignature(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  const opt = pe + 24;
  const dirs = opt + (buf.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const security = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  const offset = buf.readUInt32LE(security);
  const size = buf.readUInt32LE(security + 4);
  if (!offset) return;
  buf.writeUInt32LE(0, security);
  buf.writeUInt32LE(0, security + 4);
  // The certificate table is the last thing in a signed file.
  fs.writeFileSync(file, offset + size >= buf.length ? buf.subarray(0, offset) : buf);
}

function setIconAndVersion(file) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(file), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(at('assets', 'icon.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const group = groups[0] ?? { id: 1, lang: 1033 };
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icon.icons.map((i) => i.data));

  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const langs = vi.getAllLanguagesForStringValues();
  const lang = langs[0] ?? { lang: 1033, codepage: 1200 };
  for (const key of ['Comments', 'ProductName', 'CompanyName', 'FileDescription', 'LegalCopyright', 'OriginalFilename', 'InternalName']) {
    vi.removeStringValue(lang, key);
  }
  // Numeric versions first: setting them also rewrites the version strings.
  vi.setFileVersion(numeric[0], numeric[1], numeric[2], 0, lang.lang);
  vi.setProductVersion(numeric[0], numeric[1], numeric[2], 0, lang.lang);
  vi.setStringValues(lang, { ...META, FileVersion: version, ProductVersion: version });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(file, Buffer.from(exe.generate()));
}

/**
 * Mark the exe as a GUI program, so double-clicking it opens no console
 * window. Node supports running this way: with no console, its stdout and
 * stderr become no-op streams.
 */
function setGuiSubsystem(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a PE file');
  buf.writeUInt16LE(2, pe + 24 + 68); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeFileSync(file, buf);
}

/** Cut at the last whole line that fits; the dashboard shows the rest on GitHub. */
function shorten(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf('\n')).trimEnd()}\n…`;
}

/** The CHANGELOG.md section for this version, as plain text. */
function changelogNotes(v) {
  try {
    const log = fs.readFileSync(at('CHANGELOG.md'), 'utf8');
    const start = log.search(new RegExp(`^## v?${v.replace(/\./g, '\\.')}\\b`, 'm'));
    if (start < 0) return '';
    const rest = log.slice(start);
    const next = rest.slice(1).search(/^## /m);
    return (next < 0 ? rest : rest.slice(0, next + 1)).trim();
  } catch {
    return '';
  }
}
