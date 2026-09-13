/**
 * The LAN counterpart to printer-resolver.test.ts.
 *
 * These assertions are about *what the operator is told*, not about internal
 * shape. A test that only checked `reason` was non-empty would have passed
 * against the errno string this module exists to replace.
 */

import {
  diagnoseNetworkError,
  validateNetworkTarget,
  warnAboutPort,
  RAW_PRINT_PORT
} from '../src/printers/network-diagnosis';

const HOST = '192.168.1.100';

describe('diagnoseNetworkError', () => {
  it('names the address in every diagnosis', () => {
    // A site with four printers produces four of these. One that does not say
    // which printer failed is unusable.
    const codes = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNRESET', 'WEIRD'];
    for (const code of codes) {
      const d = diagnoseNetworkError({ code }, HOST, RAW_PRINT_PORT);
      expect(d.reason).toContain(HOST);
      expect(d.fix.length).toBeGreaterThan(0);
    }
  });

  it('treats a refused connection as a configuration fault, not a transient one', () => {
    // The host answered. Waiting cannot change the answer.
    const d = diagnoseNetworkError({ code: 'ECONNREFUSED' }, HOST, RAW_PRINT_PORT);
    expect(d.retryable).toBe(false);
    expect(d.reason).toMatch(/reachable but refused/i);
  });

  it('calls out a port that is obviously the wrong service', () => {
    const d = diagnoseNetworkError({ code: 'ECONNREFUSED' }, HOST, 80);
    expect(d.reason).toMatch(/web page/i);
    expect(d.fix).toContain(String(RAW_PRINT_PORT));
  });

  it('blames DHCP on a timeout, because that is usually what happened', () => {
    const d = diagnoseNetworkError({ code: 'ETIMEDOUT' }, HOST, RAW_PRINT_PORT);
    expect(d.retryable).toBe(true);
    expect(d.fix).toMatch(/DHCP|static/i);
  });

  it('explains a subnet mismatch rather than saying "unreachable"', () => {
    const d = diagnoseNetworkError({ code: 'EHOSTUNREACH' }, HOST, RAW_PRINT_PORT);
    expect(d.fix).toMatch(/same network/i);
    expect(d.retryable).toBe(false);
  });

  it('recognises the single-connection limit behind a reset', () => {
    const d = diagnoseNetworkError({ code: 'ECONNRESET' }, HOST, RAW_PRINT_PORT);
    expect(d.fix).toMatch(/one connection at a time/i);
  });

  it('still gives a first step for an unrecognised errno', () => {
    // The failure mode this guards against is a default branch that says
    // "unknown error" and leaves the operator with nothing to do.
    const d = diagnoseNetworkError({ code: 'ENOBUFS', message: 'no buffer space' }, HOST, 9100);
    expect(d.reason).toContain(HOST);
    expect(d.fix).toContain(String(RAW_PRINT_PORT));
  });
});

describe('validateNetworkTarget', () => {
  it('accepts a well-formed address', () => {
    expect(validateNetworkTarget(HOST, RAW_PRINT_PORT)).toBeNull();
  });

  it('accepts a host name, which some sites genuinely use', () => {
    expect(validateNetworkTarget('printer.local', RAW_PRINT_PORT)).toBeNull();
  });

  it('rejects a missing host and says where to find one', () => {
    const msg = validateNetworkTarget(undefined, RAW_PRINT_PORT);
    expect(msg).toMatch(/self-test|display menu/i);
  });

  it('rejects a blank host', () => {
    expect(validateNetworkTarget('   ', RAW_PRINT_PORT)).not.toBeNull();
  });

  it('names the offending octet rather than saying "invalid"', () => {
    const msg = validateNetworkTarget('192.168.1.300', RAW_PRINT_PORT);
    expect(msg).toContain('300');
  });

  it('catches an incomplete dotted quad', () => {
    const msg = validateNetworkTarget('192.168.1', RAW_PRINT_PORT);
    expect(msg).toMatch(/four numbers/i);
  });

  it('strips a pasted URL and shows what to use instead', () => {
    const msg = validateNetworkTarget('http://192.168.1.100', RAW_PRINT_PORT);
    expect(msg).toContain('192.168.1.100');
    expect(msg).toMatch(/not a URL/i);
  });

  it('rejects a missing port', () => {
    expect(validateNetworkTarget(HOST, undefined)).toMatch(/9100/);
  });

  it('rejects an out-of-range port', () => {
    expect(validateNetworkTarget(HOST, 70000)).not.toBeNull();
    expect(validateNetworkTarget(HOST, 0)).not.toBeNull();
  });
});

describe('warnAboutPort', () => {
  it('stays silent on the standard port', () => {
    expect(warnAboutPort(RAW_PRINT_PORT)).toBeNull();
  });

  it('warns about a known wrong service but does not block it', () => {
    // Deliberately advisory: a site may have moved raw printing elsewhere.
    expect(warnAboutPort(631)).toMatch(/IPP/i);
  });

  it('says nothing about an unusual but plausible port', () => {
    expect(warnAboutPort(9101)).toBeNull();
  });
});
