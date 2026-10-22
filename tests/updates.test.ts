/**
 * Tests for the update checker's parsing and comparison.
 *
 * The manifest is the same schema Pulsar POS publishes and reads, so these
 * mirror that reader's rules: https only (loopback excepted), 64-hex SHA-256,
 * a positive size, and a valid x.y.z version.
 */

import { compareVersions, isNewer, parseManifest, parseSha256Sums, ManifestError } from '../src/app/updates';

const SHA = 'a'.repeat(64);

function manifest(stable: Record<string, unknown>) {
  return { schema: 1, channels: { stable } };
}

const good = {
  version: '2.1.0',
  url: 'https://updates.xenithpulse.com/thermal-bridge/ThermalBridge-Setup-2.1.0.exe',
  sha256: SHA.toUpperCase(),
  sizeBytes: 24_000_000,
  releasedAt: '2026-11-01T10:00:00Z',
  notes: 'Fixes',
  portable: {
    url: 'https://updates.xenithpulse.com/thermal-bridge/ThermalBridge-Portable-2.1.0.exe',
    sha256: 'b'.repeat(64),
    sizeBytes: 90_000_000
  }
};

describe('compareVersions', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.10', '2.0.9')).toBe(1);
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });

  it('ranks a release above its prerelease', () => {
    expect(compareVersions('2.0.0', '2.0.0-beta.1')).toBe(1);
    expect(isNewer('2.0.0-beta.1', '2.0.0')).toBe(false);
  });

  it('refuses things that are not versions', () => {
    expect(() => compareVersions('latest', '2.0.0')).toThrow();
  });
});

describe('parseManifest', () => {
  it('reads a channel, lower-casing the hashes', () => {
    const info = parseManifest(manifest(good), 'stable');
    expect(info.version).toBe('2.1.0');
    expect(info.sha256).toBe(SHA);
    expect(info.portable?.sizeBytes).toBe(90_000_000);
    expect(info.source).toBe('manifest');
  });

  it('rejects a plain-http download from anywhere but this machine', () => {
    expect(() => parseManifest(manifest({ ...good, url: 'http://evil.example/x.exe' }), 'stable')).toThrow(ManifestError);
    expect(parseManifest(manifest({ ...good, url: 'http://127.0.0.1:8080/x.exe' }), 'stable').url).toContain('127.0.0.1');
  });

  it('rejects a malformed hash, a bad size, and a bad version', () => {
    expect(() => parseManifest(manifest({ ...good, sha256: 'abc' }), 'stable')).toThrow(/sha256/);
    expect(() => parseManifest(manifest({ ...good, sizeBytes: 0 }), 'stable')).toThrow(/sizeBytes/);
    expect(() => parseManifest(manifest({ ...good, version: 'v2' }), 'stable')).toThrow(/version/);
  });

  it('rejects other schemas and missing channels', () => {
    expect(() => parseManifest({ schema: 2, channels: { stable: good } }, 'stable')).toThrow(/schema/);
    expect(() => parseManifest(manifest(good), 'beta')).toThrow(/beta/);
  });
});

describe('parseSha256Sums', () => {
  it('reads sha256sum output, with or without the binary marker', () => {
    const sums = parseSha256Sums(`${SHA}  ThermalBridge-Setup.exe\r\n${'C'.repeat(64)} *SHA256SUMS.txt\n\njunk line\n`);
    expect(sums.get('ThermalBridge-Setup.exe')).toBe(SHA);
    expect(sums.get('SHA256SUMS.txt')).toBe('c'.repeat(64));
    expect(sums.size).toBe(2);
  });
});
