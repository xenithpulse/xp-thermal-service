/**
 * Tests for the CORS/host policy.
 *
 * The bug these guard against: the service falls back from its configured port
 * to the next free one, and the dashboard served on that fallback port was then
 * refused by its own API.
 */

import { OriginPolicy } from '../src/api/origin-policy';

function policy(allowedOrigins: string[] = [], allowPrivateNetwork = true): OriginPolicy {
  return new OriginPolicy({ allowedOrigins, allowPrivateNetwork });
}

describe('OriginPolicy.check', () => {
  it('trusts loopback on every port the service might land on', () => {
    const p = policy();
    for (let port = 9100; port <= 9110; port++) {
      expect(p.check(`http://127.0.0.1:${port}`).allowed).toBe(true);
      expect(p.check(`http://localhost:${port}`).allowed).toBe(true);
    }
  });

  it('trusts loopback on unrelated ports and both IP spellings', () => {
    const p = policy();
    for (const origin of [
      'http://127.0.0.1:3000',
      'http://localhost:5173',
      'http://[::1]:8080',
      'https://localhost:443'
    ]) {
      expect({ origin, ...p.check(origin) }).toMatchObject({ allowed: true });
    }
  });

  it('allows requests with no Origin header', () => {
    // Server-to-server callers and curl send none; the API key still applies.
    expect(policy().check(undefined).allowed).toBe(true);
  });

  it('honours exact entries in allowedOrigins', () => {
    const p = policy(['https://dd.pos.xenithpulse.com']);
    expect(p.check('https://dd.pos.xenithpulse.com').allowed).toBe(true);
    expect(p.check('https://other.example.com').allowed).toBe(false);
  });

  it('supports wildcard patterns', () => {
    const p = policy(['https://*.pos.xenithpulse.com'], false);
    expect(p.check('https://dd.pos.xenithpulse.com').allowed).toBe(true);
    expect(p.check('https://p1.pos.xenithpulse.com').allowed).toBe(true);
    expect(p.check('https://pos.xenithpulse.com').allowed).toBe(false);
    expect(p.check('https://evil.com').allowed).toBe(false);
  });

  it('does not let a wildcard leak across dots into another host', () => {
    const p = policy(['https://*.example.com'], false);
    expect(p.check('https://a.b.example.com.evil.com').allowed).toBe(false);
  });

  it('honours a bare "*"', () => {
    expect(policy(['*']).check('https://anything.example').allowed).toBe(true);
  });

  it('allows private LAN origins only when enabled', () => {
    expect(policy([], true).check('http://192.168.0.116:8080').allowed).toBe(true);
    expect(policy([], true).check('http://10.0.0.5:3000').allowed).toBe(true);
    expect(policy([], true).check('http://172.16.4.4').allowed).toBe(true);

    expect(policy([], false).check('http://192.168.0.116:8080').allowed).toBe(false);
    // A public address is never private, whatever the flag says.
    expect(policy([], true).check('https://93.184.216.34').allowed).toBe(false);
  });

  it('does not treat 172.32.x as private', () => {
    // The private range stops at 172.31; an off-by-one here would trust the
    // public internet.
    expect(policy([], true).check('http://172.32.0.1').allowed).toBe(false);
    expect(policy([], true).check('http://172.15.0.1').allowed).toBe(false);
  });

  it('rejects a malformed Origin', () => {
    expect(policy(['*']).check('not-a-url').allowed).toBe(false);
  });

  it('explains how to fix a rejection', () => {
    const decision = policy([], false).check('https://evil.example.com');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/allowedOrigins/);
  });

  it('applies an updated configuration immediately', () => {
    const p = policy([], false);
    expect(p.check('https://new.example.com').allowed).toBe(false);
    p.update({ allowedOrigins: ['https://new.example.com'], allowPrivateNetwork: false });
    expect(p.check('https://new.example.com').allowed).toBe(true);
  });
});

describe('OriginPolicy.checkHost', () => {
  it('always accepts loopback hosts', () => {
    const p = policy();
    expect(p.checkHost('127.0.0.1', []).allowed).toBe(true);
    expect(p.checkHost('localhost', []).allowed).toBe(true);
    expect(p.checkHost('::1', []).allowed).toBe(true);
  });

  it('accepts hosts listed in allowedHosts', () => {
    expect(policy([], false).checkHost('pos-till-1', ['pos-till-1']).allowed).toBe(true);
  });

  it('rejects unknown hosts with an explanation', () => {
    const decision = policy([], false).checkHost('evil.example.com', ['localhost']);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/allowedHosts/);
  });

  it('rejects a request with no Host header', () => {
    expect(policy().checkHost(undefined, ['localhost']).allowed).toBe(false);
  });
});
