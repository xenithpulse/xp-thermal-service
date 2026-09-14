/**
 * Deciding when a change in health is worth telling someone about.
 *
 * `/health` is well built and nobody watches it. A site ran degraded for an
 * unknown length of time and only found out because someone thought to ask —
 * which makes the endpoint a record of the outage rather than a warning about
 * it.
 *
 * The hard part is not sending a webhook, it is not sending thousands. A
 * printer at the edge of its Wi-Fi range flaps between online and offline all
 * evening; a naive "alert on every status change" turns that into a pager
 * storm, and a pager storm is indistinguishable from no alerting at all once
 * people start ignoring it.
 *
 * So the rules here are:
 *
 *   CONFIRM   a new status must hold for N consecutive samples before it is
 *             believed. A printer that drops and recovers between two polls
 *             never produces an alert.
 *   RATE      at most one alert per window, so a genuinely broken site does
 *             not send one every poll for the rest of the night.
 *   RECOVER   returning to healthy is always worth sending, and is never rate
 *             limited away — an operator who got "degraded" needs the "fixed"
 *             more than they needed the first one.
 *
 * Pure and clock-injected, like health-verdict: the timing rules are the part
 * worth being able to prove without waiting an evening to see them.
 */

import { HealthStatus } from '../types';

export interface HealthAlert {
  /** The status now being reported. */
  status: HealthStatus;
  /** The status this replaced. */
  previous: HealthStatus;
  /** Why, verbatim from decideHealth — already written to be read by a person. */
  reasons: string[];
  /** True when this is a return to healthy rather than a new problem. */
  recovered: boolean;
  at: number;
}

export interface HealthAlerterOptions {
  /** Consecutive samples a new status must hold before it is believed. */
  confirmSamples?: number;
  /** Minimum gap between non-recovery alerts. */
  minIntervalMs?: number;
}

const DEFAULT_CONFIRM = 2;
const DEFAULT_MIN_INTERVAL_MS = 15 * 60 * 1000;

export class HealthAlerter {
  private readonly confirmSamples: number;
  private readonly minIntervalMs: number;

  /** The last status we actually believe, as opposed to merely sampled. */
  private confirmed: HealthStatus | null = null;

  /** The status currently accumulating evidence, and how much it has. */
  private candidate: HealthStatus | null = null;
  private candidateCount = 0;

  /**
   * Negative infinity, not 0: the rate limit must never apply when no alert
   * has ever been sent. Starting at 0 makes the very first alert depend on how
   * large `now` happens to be, which works by accident with a real clock and
   * fails the moment anything supplies a small one.
   */
  private lastAlertAt = Number.NEGATIVE_INFINITY;

  constructor(options: HealthAlerterOptions = {}) {
    this.confirmSamples = Math.max(1, options.confirmSamples ?? DEFAULT_CONFIRM);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  }

  /**
   * Feed one sample. Returns an alert to send, or null.
   */
  observe(status: HealthStatus, reasons: string[], now: number = Date.now()): HealthAlert | null {
    // 'initializing' is a transient startup value, not a verdict. Alerting on
    // it would page someone every time the service restarts.
    if (status === 'initializing') {
      return null;
    }

    // First real sample establishes a baseline. Deliberately silent: a service
    // that starts up already degraded has not *changed*, and announcing it on
    // every restart trains people to ignore the channel.
    if (this.confirmed === null) {
      this.confirmed = status;
      this.candidate = status;
      this.candidateCount = this.confirmSamples;
      return null;
    }

    if (status === this.confirmed) {
      // Back to what we already believe — abandon any half-formed candidate.
      this.candidate = status;
      this.candidateCount = this.confirmSamples;
      return null;
    }

    // Accumulate evidence, then test the threshold — never return early on a
    // fresh candidate, or confirmSamples: 1 could never fire at all.
    if (status !== this.candidate) {
      this.candidate = status;
      this.candidateCount = 1;
    } else {
      this.candidateCount++;
    }

    if (this.candidateCount < this.confirmSamples) {
      return null;
    }

    const previous = this.confirmed;
    const recovered = status === 'healthy';

    // Rate limiting never suppresses a recovery. Someone holding a "degraded"
    // message needs to know it is over.
    if (!recovered && now - this.lastAlertAt < this.minIntervalMs) {
      // Believe the new status so we do not re-alert the moment the window
      // expires, but stay quiet about it.
      this.confirmed = status;
      return null;
    }

    this.confirmed = status;
    this.lastAlertAt = now;

    return { status, previous, reasons, recovered, at: now };
  }

  /** The status currently believed, for diagnostics. */
  get currentStatus(): HealthStatus | null {
    return this.confirmed;
  }
}
