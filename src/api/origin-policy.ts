/**
 * Origin and host policy for the local API.
 *
 * The service binds to a configured port but falls back to the next free one
 * when that port is taken (9100 → 9101 → … → 9109). The old policy only ever
 * trusted the *configured* port, so as soon as the fallback kicked in the
 * dashboard was talking to an origin the server did not recognise and every
 * request died with "Not allowed by CORS" — the dashboard's own CRUD included.
 *
 * The rule here is simple and portable: anything on the loopback interface is
 * trusted on every port. A page served from 127.0.0.1 is already running on the
 * user's machine, and the port it happens to have been given carries no
 * security meaning.
 */

import * as os from 'os';

export interface OriginPolicyOptions {
  /** Extra origins from config; may contain `*` wildcards. */
  allowedOrigins: string[];
  /** Trust browsers elsewhere on the private LAN (POS terminals). */
  allowPrivateNetwork: boolean;
}

export interface OriginDecision {
  allowed: boolean;
  /** Why the origin was accepted or rejected — logged, and returned on 403. */
  reason: string;
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** RFC1918 / link-local ranges plus IPv6 unique-local and link-local. */
function isPrivateAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // unique-local IPv6
  if (host.startsWith('fe80:')) return true; // link-local IPv6
  if (host.endsWith('.local')) return true; // mDNS

  return false;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return LOOPBACK_HOSTNAMES.has(host) || LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

/** Every IPv4/IPv6 address this machine currently holds. */
export function getLocalAddresses(): string[] {
  const addresses: string[] = [];
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name] ?? []) {
        if (iface.address) addresses.push(iface.address.toLowerCase());
      }
    }
  } catch {
    // Interface enumeration is best-effort.
  }
  return addresses;
}

/**
 * Turn a wildcard origin pattern into a regex.
 * `https://*.pos.example.com` and `http://192.168.*:*` both work.
 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`, 'i');
}

export class OriginPolicy {
  private options: OriginPolicyOptions;
  private localAddresses: Set<string>;

  constructor(options: OriginPolicyOptions) {
    this.options = options;
    this.localAddresses = new Set(getLocalAddresses());
  }

  /** Apply an updated security config without restarting the server. */
  update(options: OriginPolicyOptions): void {
    this.options = options;
    this.localAddresses = new Set(getLocalAddresses());
  }

  /**
   * Decide whether a browser Origin may call the API.
   *
   * Order matters: cheap, always-true cases first so the common path (the
   * dashboard talking to itself) never depends on configuration at all.
   */
  check(origin: string | undefined): OriginDecision {
    // Non-browser callers (the POS service, curl, server-to-server) send no
    // Origin header at all. Host validation and the API key still apply.
    if (!origin) {
      return { allowed: true, reason: 'No Origin header (not a browser request)' };
    }

    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return { allowed: false, reason: `Malformed Origin header: ${origin}` };
    }

    const hostname = url.hostname.toLowerCase();

    // 1. Loopback on ANY port. This is what keeps the dashboard working when
    //    the service falls back from 9100 to 9101+.
    if (isLoopbackHostname(hostname)) {
      return { allowed: true, reason: 'Loopback origin (always trusted, any port)' };
    }

    // 2. An address belonging to this very machine, reached over the LAN.
    if (this.localAddresses.has(hostname)) {
      return { allowed: true, reason: 'Origin is this machine' };
    }

    // 3. Explicit configuration, exact or wildcard.
    for (const pattern of this.options.allowedOrigins) {
      const candidate = pattern.trim();
      if (!candidate) continue;

      if (candidate === '*') {
        return { allowed: true, reason: 'Wildcard "*" in allowedOrigins' };
      }
      if (candidate.toLowerCase() === origin.toLowerCase()) {
        return { allowed: true, reason: 'Listed in allowedOrigins' };
      }
      if (candidate.includes('*') && wildcardToRegExp(candidate).test(origin)) {
        return { allowed: true, reason: `Matches allowedOrigins pattern "${candidate}"` };
      }
    }

    // 4. Other machines on the same private network (a POS terminal talking to
    //    the till PC), when enabled.
    if (this.options.allowPrivateNetwork && isPrivateAddress(hostname)) {
      return { allowed: true, reason: 'Private network origin' };
    }

    return {
      allowed: false,
      reason:
        `Origin "${origin}" is not allowed. Add it to security.allowedOrigins in ` +
        `config.json (wildcards such as "https://*.example.com" are supported), ` +
        `or use the Settings page in the dashboard.`
    };
  }

  /**
   * Decide whether the Host header a request arrived on is acceptable.
   *
   * Loopback and this machine's own addresses are always fine, whatever the
   * port. Anything else must be listed in allowedHosts.
   */
  checkHost(hostname: string | undefined, allowedHosts: string[]): OriginDecision {
    if (!hostname) {
      return { allowed: false, reason: 'Request has no Host header' };
    }

    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

    if (isLoopbackHostname(host)) {
      return { allowed: true, reason: 'Loopback host' };
    }
    if (this.localAddresses.has(host)) {
      return { allowed: true, reason: 'Host is this machine' };
    }
    if (allowedHosts.some((h) => h.trim().toLowerCase() === host)) {
      return { allowed: true, reason: 'Listed in allowedHosts' };
    }
    if (allowedHosts.includes('*')) {
      return { allowed: true, reason: 'Wildcard "*" in allowedHosts' };
    }
    if (this.options.allowPrivateNetwork && isPrivateAddress(host)) {
      return { allowed: true, reason: 'Private network host' };
    }

    return {
      allowed: false,
      reason: `Requests to host "${hostname}" are not allowed. Add it to security.allowedHosts.`
    };
  }
}

export default OriginPolicy;
