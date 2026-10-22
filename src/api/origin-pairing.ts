/**
 * Origin pairing: websites that tried to print but are not on the list yet.
 *
 * Rather than asking a restaurant owner to edit allowedOrigins in JSON, the
 * service remembers each unknown origin that calls it, and the dashboard asks
 * "https://example-pos.com wants to print — Allow / Block". Allow adds it to
 * security.allowedOrigins, Block to security.blockedOrigins.
 *
 * Held in memory only, and capped, because any page the user visits can make
 * the browser send a request here; a hostile page must not be able to grow
 * this without bound or fill the config file.
 */

export interface PendingOrigin {
  origin: string;
  firstSeen: string;
  lastSeen: string;
  attempts: number;
}

const MAX_PENDING = 20;

export class OriginPairing {
  private readonly pending = new Map<string, PendingOrigin>();

  /** Record an origin the policy refused. Only well-formed web origins count. */
  note(origin: string): void {
    let normalised: string;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      normalised = url.origin.toLowerCase();
    } catch {
      return;
    }

    const now = new Date().toISOString();
    const existing = this.pending.get(normalised);
    if (existing) {
      existing.lastSeen = now;
      existing.attempts++;
      return;
    }

    if (this.pending.size >= MAX_PENDING) {
      const oldest = [...this.pending.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0];
      this.pending.delete(oldest.origin);
    }
    this.pending.set(normalised, { origin: normalised, firstSeen: now, lastSeen: now, attempts: 1 });
  }

  list(): PendingOrigin[] {
    return [...this.pending.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  forget(origin: string): void {
    this.pending.delete(origin.toLowerCase());
  }
}
