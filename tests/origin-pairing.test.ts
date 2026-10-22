/**
 * Tests for origin pairing: websites that asked to print are offered to the
 * operator, and "Block" in the dashboard always means blocked.
 */

import { OriginPairing } from '../src/api/origin-pairing';
import { OriginPolicy } from '../src/api/origin-policy';

describe('OriginPairing', () => {
  it('records each web origin once, counting repeat attempts', () => {
    const p = new OriginPairing();
    p.note('https://Example-POS.com');
    p.note('https://example-pos.com');
    expect(p.list()).toHaveLength(1);
    expect(p.list()[0]).toMatchObject({ origin: 'https://example-pos.com', attempts: 2 });
  });

  it('ignores anything that is not an http(s) origin', () => {
    const p = new OriginPairing();
    p.note('null');
    p.note('file:///C:/receipt.html');
    p.note('chrome-extension://abc');
    expect(p.list()).toHaveLength(0);
  });

  it('stays bounded however many sites try', () => {
    const p = new OriginPairing();
    for (let i = 0; i < 50; i++) p.note(`https://site${i}.example`);
    expect(p.list().length).toBeLessThanOrEqual(20);
  });

  it('forgets an origin once the operator decided', () => {
    const p = new OriginPairing();
    p.note('https://example-pos.com');
    p.forget('https://example-pos.com');
    expect(p.list()).toHaveLength(0);
  });
});

describe('OriginPolicy with blocked origins', () => {
  const policy = (allowed: string[], blocked: string[]) =>
    new OriginPolicy({ allowedOrigins: allowed, blockedOrigins: blocked, allowPrivateNetwork: true });

  it('blocks a blocked origin even if it is also allowed', () => {
    const d = policy(['https://pos.example.com'], ['https://pos.example.com']).check('https://pos.example.com');
    expect(d.allowed).toBe(false);
    expect(d.blocked).toBe(true);
  });

  it('blocks a private-network origin the operator refused', () => {
    expect(policy([], ['http://192.168.1.50:3000']).check('http://192.168.1.50:3000').allowed).toBe(false);
  });

  it('never blocks the dashboard itself on loopback', () => {
    expect(policy([], ['http://127.0.0.1:9100']).check('http://127.0.0.1:9100').allowed).toBe(true);
  });

  it('marks an unknown origin as not blocked, so it can be offered for pairing', () => {
    const d = policy([], []).check('https://new-site.example');
    expect(d.allowed).toBe(false);
    expect(d.blocked).toBeUndefined();
  });
});
