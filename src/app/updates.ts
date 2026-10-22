/**
 * Update checks, mirroring Pulsar POS's updater (lib/updates in that repo):
 *
 *   - the same manifest schema, published by the same pipeline to the same
 *     bucket, under thermal-bridge/ at updates.xenithpulse.com
 *   - SHA-256 from the manifest for integrity, checked while downloading
 *   - Authenticode for origin, delegated to Windows (Get-AuthenticodeSignature)
 *     and accepted only when Valid and signed by the expected publisher
 *
 * Everything is outbound HTTPS, and only when someone clicks "Check for
 * updates". There is no background polling, no telemetry, and nothing is ever
 * installed until the operator clicks "Install update".
 *
 * GitHub Releases is the fallback, used only when the manifest is unreachable.
 */

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runPowerShell } from '../printers/windows-printers';
import { VERSION, COMPANY } from './identity';

export const DEFAULT_MANIFEST_URL = 'https://updates.xenithpulse.com/thermal-bridge/manifest.json';
export const GITHUB_LATEST_URL = 'https://api.github.com/repos/xenithpulse/xp-thermal-service/releases/latest';

const MAX_MANIFEST_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;

// ── Versions ──────────────────────────────────────────────────────────────────

const VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,32}))?$/;

export function isValidVersion(value: unknown): value is string {
  return typeof value === 'string' && VERSION_RE.test(value);
}

/** Major, minor, patch; a release outranks its prereleases. */
export function compareVersions(a: string, b: string): number {
  const ma = VERSION_RE.exec(a);
  const mb = VERSION_RE.exec(b);
  if (!ma || !mb) throw new Error(`Not a version: ${!ma ? a : b}`);
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i]);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  const pa = ma[4];
  const pb = mb[4];
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa > pb ? 1 : -1;
}

export function isNewer(candidate: string, installed: string): boolean {
  return compareVersions(candidate, installed) > 0;
}

// ── Manifest ──────────────────────────────────────────────────────────────────

export interface UpdateFile {
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface UpdateInfo extends UpdateFile {
  version: string;
  releasedAt?: string;
  notes?: string;
  /** The portable exe for the same release, when published. */
  portable?: UpdateFile;
  source: 'manifest' | 'github';
}

export class ManifestError extends Error {
  constructor(message: string, readonly unreachable = false) {
    super(message);
  }
}

/** https only; plain http is allowed for loopback so a test server works. */
function isAcceptableUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

function parseFile(raw: Record<string, unknown>, label: string): UpdateFile {
  if (!isAcceptableUrl(raw.url)) throw new ManifestError(`${label}: url must be https`);
  if (typeof raw.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.sha256)) {
    throw new ManifestError(`${label}: sha256 must be 64 hex characters`);
  }
  const size = raw.sizeBytes;
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_DOWNLOAD_BYTES) {
    throw new ManifestError(`${label}: sizeBytes is missing or out of range`);
  }
  return { url: raw.url, sha256: raw.sha256.toLowerCase(), sizeBytes: size };
}

/** Validate one channel of a schema-1 manifest. */
export function parseManifest(root: unknown, channel: string): UpdateInfo {
  const doc = root as { schema?: unknown; channels?: Record<string, unknown> } | null;
  if (doc?.schema !== 1) throw new ManifestError(`Unsupported manifest schema ${String(doc?.schema)}`);
  const entry = doc.channels?.[channel] as Record<string, unknown> | undefined;
  if (!entry || typeof entry !== 'object') throw new ManifestError(`The manifest has no "${channel}" channel`);
  if (!isValidVersion(entry.version)) throw new ManifestError('The manifest version is not valid');

  const info: UpdateInfo = {
    ...parseFile(entry, channel),
    version: entry.version,
    releasedAt: typeof entry.releasedAt === 'string' ? entry.releasedAt : undefined,
    notes: typeof entry.notes === 'string' ? entry.notes : undefined,
    source: 'manifest'
  };
  if (entry.portable && typeof entry.portable === 'object') {
    info.portable = parseFile(entry.portable as Record<string, unknown>, `${channel}.portable`);
  }
  return info;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const text = await res.text();
  if (Buffer.byteLength(text) > maxBytes) throw new ManifestError('The response is too large');
  return text.replace(/^\uFEFF/, '');
}

export async function fetchManifest(url: string, channel: string): Promise<UpdateInfo> {
  let res: Response;
  try {
    // Node's fetch keeps no HTTP cache; the header asks the CDN not to serve a stale copy.
    res = await fetchWithTimeout(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' } });
  } catch (error) {
    throw new ManifestError(`The update server could not be reached: ${(error as Error).message}`, true);
  }
  if (!res.ok) {
    throw new ManifestError(`The update server answered HTTP ${res.status}`, res.status >= 500 || res.status === 404);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readCapped(res, MAX_MANIFEST_BYTES));
  } catch (error) {
    if (error instanceof ManifestError) throw error;
    throw new ManifestError('The update manifest is not valid JSON');
  }
  return parseManifest(parsed, channel);
}

/** Read SHA256SUMS.txt ("<hash>  <file>" per line, as sha256sum writes it). */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m) sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

interface GithubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

/** The fallback: the latest GitHub release, hashes from its SHA256SUMS.txt. */
export async function fetchGithubLatest(): Promise<UpdateInfo> {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': `ThermalBridge/${VERSION}` };
  const res = await fetchWithTimeout(GITHUB_LATEST_URL, { headers });
  if (!res.ok) throw new ManifestError(`GitHub answered HTTP ${res.status}`, true);
  const release = JSON.parse(await readCapped(res, 4 * MAX_MANIFEST_BYTES)) as {
    tag_name?: string;
    body?: string;
    published_at?: string;
    assets?: GithubAsset[];
  };

  const version = String(release.tag_name ?? '').replace(/^v/, '');
  if (!isValidVersion(version)) throw new ManifestError('The latest GitHub release has no usable version tag');

  const assets = release.assets ?? [];
  const find = (name: string) => assets.find((a) => a.name === name);
  const sumsAsset = find('SHA256SUMS.txt');
  if (!sumsAsset) throw new ManifestError('The latest GitHub release has no SHA256SUMS.txt');
  const sumsRes = await fetchWithTimeout(sumsAsset.browser_download_url, { headers });
  if (!sumsRes.ok) throw new ManifestError(`Could not read SHA256SUMS.txt (HTTP ${sumsRes.status})`);
  const sums = parseSha256Sums(await readCapped(sumsRes, MAX_MANIFEST_BYTES));

  const toFile = (name: string): UpdateFile | undefined => {
    const asset = find(name);
    const sha256 = sums.get(name);
    if (!asset || !sha256) return undefined;
    return { url: asset.browser_download_url, sha256, sizeBytes: asset.size };
  };

  const setup = toFile(`ThermalBridge-Setup-${version}.exe`) ?? toFile('ThermalBridge-Setup.exe');
  if (!setup) throw new ManifestError('The latest GitHub release has no verifiable installer');

  return {
    ...setup,
    version,
    releasedAt: release.published_at,
    notes: release.body?.slice(0, 2000),
    portable: toFile(`ThermalBridge-Portable-${version}.exe`),
    source: 'github'
  };
}

// ── Verification ──────────────────────────────────────────────────────────────

export interface SignatureCheck {
  status: string;
  subject: string | null;
  /** Valid, and signed by the expected publisher. */
  trusted: boolean;
}

/** Ask Windows whether the file is Authenticode-signed, and by whom. */
export async function inspectSignature(file: string, expectedPublisher: string): Promise<SignatureCheck> {
  const result = await runPowerShell(
    `
      $ErrorActionPreference = 'Stop'
      $sig = Get-AuthenticodeSignature -LiteralPath $env:TB_SIGNED_FILE
      $subject = ''
      if ($sig.SignerCertificate) { $subject = $sig.SignerCertificate.Subject }
      Write-Output ([string]$sig.Status)
      Write-Output $subject
    `,
    { TB_SIGNED_FILE: file },
    60_000
  );
  const [status = 'UnknownError', subject = ''] = result.stdout.split(/\r?\n/).map((l) => l.trim());
  const subjectOrNull = subject || null;
  const trusted =
    status === 'Valid' &&
    !!subjectOrNull &&
    expectedPublisher.length > 0 &&
    subjectOrNull.toLowerCase().includes(expectedPublisher.toLowerCase());
  return { status: result.ok ? status : 'UnknownError', subject: subjectOrNull, trusted: result.ok && trusted };
}

export function describeSignature(sig: SignatureCheck | null, expectedPublisher: string): string {
  if (!sig) return 'The signature was not checked.';
  if (sig.trusted) return `Signed by ${sig.subject}.`;
  if (sig.status === 'NotSigned') return 'The installer is not code-signed.';
  if (sig.status === 'Valid') return `It is signed by "${sig.subject}", not by ${expectedPublisher}.`;
  return `Windows reported the signature as ${sig.status}.`;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Download to a .part file, hashing as the bytes arrive, and only rename it
 * into place once the size and SHA-256 both match the manifest.
 */
export async function downloadVerified(
  file: UpdateFile,
  target: string,
  onProgress?: (received: number) => void
): Promise<void> {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  const hash = createHash('sha256');
  let received = 0;

  try {
    const res = await fetchWithTimeout(file.url, {}, DOWNLOAD_TIMEOUT_MS);
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);

    const out = fs.openSync(part, 'w');
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_DOWNLOAD_BYTES || received > file.sizeBytes) {
          throw new Error(`The download is larger than the ${file.sizeBytes} bytes the manifest promised.`);
        }
        hash.update(value);
        fs.writeSync(out, value);
        onProgress?.(received);
      }
    } finally {
      fs.closeSync(out);
    }

    const actual = hash.digest('hex');
    if (received !== file.sizeBytes) {
      throw new Error(`Size mismatch: expected ${file.sizeBytes} bytes, received ${received}.`);
    }
    if (actual !== file.sha256) {
      throw new Error(
        `The download FAILED verification. Expected SHA-256 ${file.sha256}, got ${actual}. ` +
          'It was corrupted or tampered with, and has been deleted.'
      );
    }
    fs.renameSync(part, target);
  } catch (error) {
    try {
      fs.unlinkSync(part);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

// ── The flow the dashboard drives ─────────────────────────────────────────────

export interface UpdateStatus {
  currentVersion: string;
  checking: boolean;
  checkedAt: string | null;
  available: boolean;
  latest: UpdateInfo | null;
  error: string | null;
  download: {
    state: 'idle' | 'downloading' | 'ready' | 'failed';
    received: number;
    total: number;
    file: string | null;
    signature: SignatureCheck | null;
    signatureNote: string | null;
    error: string | null;
  };
  /** What "install" does here: run the installer, or reveal a new portable exe. */
  installKind: 'setup' | 'portable' | 'none';
}

export interface UpdateManagerOptions {
  dataDir: string;
  installKind: UpdateStatus['installKind'];
  manifestUrl?: string;
  channel?: string;
  expectedPublisher?: string;
}

export class UpdateManager {
  private readonly manifestUrl: string;
  private readonly channel: string;
  private readonly publisher: string;
  private status: UpdateStatus;

  constructor(private readonly options: UpdateManagerOptions) {
    this.manifestUrl = options.manifestUrl || process.env.TB_UPDATE_URL || DEFAULT_MANIFEST_URL;
    this.channel = options.channel || process.env.TB_UPDATE_CHANNEL || 'stable';
    this.publisher = options.expectedPublisher || process.env.TB_UPDATE_PUBLISHER || COMPANY;
    this.status = {
      currentVersion: VERSION,
      checking: false,
      checkedAt: null,
      available: false,
      latest: null,
      error: null,
      download: { state: 'idle', received: 0, total: 0, file: null, signature: null, signatureNote: null, error: null },
      installKind: options.installKind
    };
  }

  getStatus(): UpdateStatus {
    return this.status;
  }

  async check(): Promise<UpdateStatus> {
    if (this.status.checking) return this.status;
    this.status = { ...this.status, checking: true, error: null };
    try {
      let latest: UpdateInfo;
      try {
        latest = await fetchManifest(this.manifestUrl, this.channel);
      } catch (error) {
        if (!(error instanceof ManifestError && error.unreachable)) throw error;
        latest = await fetchGithubLatest();
      }
      this.status = {
        ...this.status,
        latest,
        available: isNewer(latest.version, VERSION),
        checkedAt: new Date().toISOString()
      };
    } catch (error) {
      this.status = { ...this.status, error: (error as Error).message, checkedAt: new Date().toISOString() };
    } finally {
      this.status = { ...this.status, checking: false };
    }
    return this.status;
  }

  /** Start downloading the latest release in the background. */
  download(): UpdateStatus {
    const latest = this.status.latest;
    if (this.options.installKind === 'none') {
      throw new Error('This copy is updated by whoever installed it (a POS installer, or a build from source).');
    }
    if (!latest || !this.status.available) throw new Error('There is no update to download. Check for updates first.');
    if (this.status.download.state === 'downloading') return this.status;

    const portable = this.options.installKind === 'portable';
    const file = portable ? latest.portable ?? null : latest;
    if (!file) throw new Error('This release has no portable download.');

    const name = portable ? `ThermalBridge-Portable-${latest.version}.exe` : `ThermalBridge-Setup-${latest.version}.exe`;
    const target = path.join(this.options.dataDir, 'updates', name);
    this.status.download = {
      state: 'downloading', received: 0, total: file.sizeBytes, file: null, signature: null, signatureNote: null, error: null
    };

    void downloadVerified(file, target, (received) => {
      this.status.download.received = received;
    })
      .then(async () => {
        const signature = await inspectSignature(target, this.publisher);
        this.status.download = {
          ...this.status.download,
          state: 'ready',
          file: target,
          signature,
          signatureNote: describeSignature(signature, this.publisher)
        };
      })
      .catch((error: Error) => {
        this.status.download = { ...this.status.download, state: 'failed', error: error.message };
      });

    return this.status;
  }

  /**
   * Run the verified installer, which asks the running app to quit before it
   * replaces any files and starts the new version afterwards. A portable
   * update is revealed in Explorer instead.
   */
  async install(): Promise<{ launched: boolean; message: string }> {
    const dl = this.status.download;
    if (dl.state !== 'ready' || !dl.file) throw new Error('The update has not finished downloading.');

    // Re-hash immediately before use: the file sat in a user-writable folder.
    const expected = this.options.installKind === 'portable' ? this.status.latest?.portable?.sha256 : this.status.latest?.sha256;
    if (!expected || (await sha256File(dl.file)) !== expected) {
      throw new Error('The downloaded file no longer matches its checksum. Check for updates again.');
    }

    if (this.options.installKind === 'portable') {
      spawn('explorer.exe', [`/select,${dl.file}`], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      return { launched: true, message: 'The new portable exe is ready. Quit this copy and run the new one.' };
    }

    if (!dl.signature?.trusted) {
      throw new Error(
        `Thermal Bridge will not run this installer: ${describeSignature(dl.signature, this.publisher)} ` +
          'Download it yourself from the releases page if you trust it.'
      );
    }

    // --update: install straight away with a progress window, then start the
    // new version in the background; this page reconnects by itself.
    spawn(dl.file, ['--update'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { launched: true, message: 'Updating now. Thermal Bridge restarts by itself in a few seconds.' };
  }
}
