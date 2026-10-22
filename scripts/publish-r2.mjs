#!/usr/bin/env node
/**
 * Publishes release/ to the update channel on Cloudflare R2, using the same
 * mechanism as Pulsar POS (installer/build.ps1 -Publish): rclone, the same
 * remote, bucket and public domain, and the same schema-1 manifest.
 *
 * Everything goes under the thermal-bridge/ prefix. Pulsar's own objects
 * (manifest.json and releases/ at the bucket root) are never read for writing
 * and never written; every key is checked against the prefix before upload.
 *
 *   npm run publish:r2 -- [--dry-run] [--force] [--channel stable]
 *
 * Settings, with the same defaults as Pulsar's build.ps1 parameters:
 *   PUBLISH_REMOTE   rclone remote           (r2pos)
 *   PUBLISH_BUCKET   bucket                  (xp-pos-releases; or POS_RELEASE_BUCKET)
 *   PUBLISH_DOMAIN   public host             (updates.xenithpulse.com; or POS_RELEASE_DOMAIN)
 *   PUBLISH_CHANNEL  manifest channel        (stable)
 *
 * Credentials are rclone's business, exactly as for Pulsar: the [r2pos]
 * section of rclone.conf, or RCLONE_CONFIG_R2POS_* environment variables
 * (TYPE, PROVIDER, ACCESS_KEY_ID, SECRET_ACCESS_KEY, ENDPOINT). This script
 * never reads, prints or stores them; it only passes its environment on to
 * rclone. All of these may also be set in a gitignored .env file.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');

// Local settings and secrets (gitignored). Variables already set in the
// environment, as in CI, win over the file.
try {
  process.loadEnvFile(path.join(root, '.env'));
} catch {
  // No .env: use the environment as it is.
}
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const PREFIX = 'thermal-bridge';
const remote = process.env.PUBLISH_REMOTE || 'r2pos';
const bucket = process.env.PUBLISH_BUCKET || process.env.POS_RELEASE_BUCKET || 'xp-pos-releases';
const domain = process.env.PUBLISH_DOMAIN || process.env.POS_RELEASE_DOMAIN || 'updates.xenithpulse.com';
const channel = option('--channel') || process.env.PUBLISH_CHANNEL || 'stable';
const dryRun = flag('--dry-run');
const force = flag('--force');

const fail = (msg) => {
  console.error(`\nPublish failed: ${msg}`);
  process.exit(1);
};

/** Every object this script touches must sit under thermal-bridge/. */
function key(name) {
  const k = `${PREFIX}/${name}`;
  if (!k.startsWith(`${PREFIX}/`) || name.includes('/') || name.includes('..')) fail(`refusing key outside ${PREFIX}/: ${k}`);
  return k;
}
const target = (k) => `${remote}:${bucket}/${k}`;

function rclone(rcArgs, { allowFail = false } = {}) {
  const r = spawnSync('rclone', rcArgs, { encoding: 'utf8', windowsHide: true });
  if (r.error) fail(`could not run rclone (${r.error.message}). Install it: winget install Rclone.Rclone`);
  if (r.status !== 0 && !allowFail) fail(`rclone ${rcArgs[0]} exited ${r.status}: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ── 1. What was built ─────────────────────────────────────────────────────────
const manifestPath = path.join(releaseDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) fail('release/manifest.json is missing. Run npm run build:exe first.');
const built = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const builtChannel = Object.keys(built.channels ?? {})[0];
const entry = built.channels?.[builtChannel];
if (built.schema !== 1 || !entry?.version) fail('release/manifest.json is not a schema-1 manifest.');
const version = entry.version;
const entryForChannel = { ...entry };

const files = [
  { name: `ThermalBridge-Setup-${version}.exe`, cache: 'public, max-age=31536000, immutable', type: 'application/octet-stream', versioned: true },
  { name: `ThermalBridge-Portable-${version}.exe`, cache: 'public, max-age=31536000, immutable', type: 'application/octet-stream', versioned: true },
  { name: 'ThermalBridge-Setup.exe', cache: 'public, max-age=300', type: 'application/octet-stream' },
  { name: 'SHA256SUMS.txt', cache: 'public, max-age=300', type: 'text/plain; charset=utf-8' }
];

// Re-hash against SHA256SUMS.txt: what goes up must be what was built.
const sums = new Map(
  fs.readFileSync(path.join(releaseDir, 'SHA256SUMS.txt'), 'utf8')
    .split(/\r?\n/).filter(Boolean).map((l) => l.split(/\s+/)).map(([h, n]) => [n, h])
);
for (const f of files) {
  f.path = path.join(releaseDir, f.name);
  if (!fs.existsSync(f.path)) fail(`release/${f.name} is missing.`);
  if (f.name.endsWith('.exe') && sums.get(f.name) !== sha256(f.path)) fail(`release/${f.name} does not match SHA256SUMS.txt.`);
  f.key = key(f.name);
}
if (entry.sha256 !== sums.get(`ThermalBridge-Setup-${version}.exe`)) fail('manifest.json and SHA256SUMS.txt disagree about the installer.');

const publicBase = `https://${domain}/${PREFIX}`;
entryForChannel.url = `${publicBase}/ThermalBridge-Setup-${version}.exe`;
if (entryForChannel.portable) entryForChannel.portable.url = `${publicBase}/ThermalBridge-Portable-${version}.exe`;
if (option('--notes')) entryForChannel.notes = option('--notes');

console.log(`Publishing Thermal Bridge ${version} to ${remote}:${bucket}/${PREFIX}/ (channel "${channel}")${dryRun ? ' — DRY RUN' : ''}`);

// ── 2. Preflight: the remote exists and the credential works ─────────────────
rclone(['lsd', `${remote}:`]);

// ── 3. Never overwrite a published version by accident ───────────────────────
for (const f of files.filter((x) => x.versioned)) {
  const r = rclone(['size', target(f.key), '--json'], { allowFail: true });
  const count = r.status === 0 ? JSON.parse(r.stdout || '{}').count ?? 0 : 0;
  if (count > 0 && !force) fail(`${f.key} is already published. Bump the version, or pass --force to replace it.`);
}

// ── 4. Merge into the live manifest, touching only this channel ──────────────
const manifestKey = key('manifest.json');
const live = rclone(['cat', target(manifestKey)], { allowFail: true });
let manifest = { schema: 1, channels: {} };
if (live.status === 0 && live.stdout.trim()) {
  try {
    const parsed = JSON.parse(live.stdout.replace(/^\uFEFF/, ''));
    if (parsed.schema === 1 && parsed.channels) manifest = parsed;
  } catch {
    console.warn('  The live manifest is not valid JSON; replacing it.');
  }
}
manifest.channels[channel] = entryForChannel;
const manifestFile = path.join(os.tmpdir(), `thermal-bridge-manifest-${randomUUID()}.json`);
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

// ── 5. Upload: binaries first, the manifest last, so it never points at a missing file
const uploads = [...files, { name: 'manifest.json', key: manifestKey, path: manifestFile, cache: 'public, max-age=60', type: 'application/json; charset=utf-8' }];
for (const u of uploads) {
  console.log(`  ${dryRun ? 'would upload' : 'uploading'}  ${u.key}  (${(fs.statSync(u.path).size / 1048576).toFixed(1)} MB)`);
  if (!dryRun) {
    rclone(['copyto', u.path, target(u.key), '--header-upload', `Cache-Control: ${u.cache}`, '--header-upload', `Content-Type: ${u.type}`]);
  }
}
if (dryRun) {
  console.log('\nManifest that would be published:\n' + JSON.stringify(manifest, null, 2));
  fs.rmSync(manifestFile, { force: true });
  process.exit(0);
}
fs.rmSync(manifestFile, { force: true });

// ── 6. Check from outside, the way an updater will see it ─────────────────────
const res = await fetch(`${publicBase}/manifest.json?cb=${randomUUID()}`, { headers: { 'cache-control': 'no-cache' } });
const seen = res.ok ? JSON.parse((await res.text()).replace(/^\uFEFF/, '')) : null;
const seenEntry = seen?.channels?.[channel];
if (!seenEntry || seenEntry.version !== version || seenEntry.sha256 !== entry.sha256) {
  fail(`uploaded, but ${publicBase}/manifest.json does not show ${version} yet (HTTP ${res.status}). Check the bucket's public domain.`);
}
const head = await fetch(entryForChannel.url, { method: 'HEAD' });
if (Number(head.headers.get('content-length')) !== entry.sizeBytes) {
  fail(`${entryForChannel.url} answered with the wrong size (HTTP ${head.status}).`);
}
console.log(`\nPublished. ${publicBase}/manifest.json now offers ${version} on "${channel}".`);
