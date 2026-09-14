/**
 * Watching health so nobody has to.
 *
 * `/health` is only evaluated when something asks, and in practice nothing
 * does. This polls the same inputs on a timer, runs them through the same
 * decideHealth used by the endpoint — so the alert and the API can never
 * disagree — and hands confirmed transitions to HealthAlerter, which decides
 * whether they are worth sending.
 *
 * Delivery is deliberately dumb: one POST, short timeout, failures logged and
 * dropped. A retry queue for alerts would be a second queue to go wrong, and
 * an alert that arrives twenty minutes late is worse than useless — the
 * operator has already seen the printer.
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { decideHealth } from '../api/health-verdict';
import { HealthAlerter, HealthAlert } from './health-alerter';
import { Logger } from '../utils/logger';
import { HealthVerdictInput } from '../api/health-verdict';

export interface HealthMonitorOptions {
  enabled: boolean;
  webhookUrl: string;
  pollIntervalMs: number;
  confirmSamples: number;
  minIntervalMs: number;
}

/** Supplies the same numbers /health reads. */
export type HealthSampler = () => HealthVerdictInput;

export class HealthMonitor {
  private timer: NodeJS.Timeout | null = null;
  private readonly alerter: HealthAlerter;

  constructor(
    private readonly options: HealthMonitorOptions,
    private readonly sample: HealthSampler,
    private readonly logger: Logger
  ) {
    this.alerter = new HealthAlerter({
      confirmSamples: options.confirmSamples,
      minIntervalMs: options.minIntervalMs
    });
  }

  start(): void {
    if (!this.options.enabled) return;

    if (!this.options.webhookUrl) {
      this.logger.warn(
        'Health alerts are enabled but alerts.webhookUrl is empty — nothing will be sent.'
      );
      return;
    }

    this.timer = setInterval(() => this.tick(), this.options.pollIntervalMs);
    // Never hold the process open for an alert timer.
    this.timer.unref?.();

    this.logger.info(
      { every: this.options.pollIntervalMs, target: this.options.webhookUrl },
      'Health alerting started'
    );
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Exposed for tests and for an immediate check after startup. */
  tick(now: number = Date.now()): void {
    let alert: HealthAlert | null = null;

    try {
      const { status, reasons } = decideHealth(this.sample());
      alert = this.alerter.observe(status, reasons, now);
    } catch (error) {
      // A monitor that throws must not take the service with it.
      this.logger.warn({ error: (error as Error).message }, 'Health sample failed');
      return;
    }

    if (!alert) return;

    this.logger.warn(
      { from: alert.previous, to: alert.status, reasons: alert.reasons },
      alert.recovered ? 'Service recovered' : 'Service health degraded'
    );

    this.deliver(alert);
  }

  private deliver(alert: HealthAlert): void {
    let target: URL;
    try {
      target = new URL(this.options.webhookUrl);
    } catch {
      this.logger.warn(
        { url: this.options.webhookUrl },
        'alerts.webhookUrl is not a valid URL — alert not sent'
      );
      return;
    }

    const payload = JSON.stringify({
      service: 'xp-thermal-service',
      status: alert.status,
      previousStatus: alert.previous,
      recovered: alert.recovered,
      // Verbatim from decideHealth. These are already written as sentences for
      // a person; an alert that paraphrases them would drift from what the
      // dashboard shows for the same fault.
      reasons: alert.reasons,
      at: new Date(alert.at).toISOString()
    });

    const transport = target.protocol === 'https:' ? https : http;

    const req = transport.request(
      target,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 5000
      },
      (res) => {
        const ok = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
        if (!ok) {
          this.logger.warn({ statusCode: res.statusCode }, 'Health alert was rejected');
        }
        res.resume(); // drain, so the socket is released
      }
    );

    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error) => {
      this.logger.warn({ error: error.message }, 'Could not deliver health alert');
    });

    req.end(payload);
  }
}
