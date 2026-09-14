/**
 * Alert timing rules.
 *
 * The failure these guard against is not a missing alert, it is a storm: a
 * printer at the edge of its Wi-Fi range flaps all evening, and an alerter
 * that fires on every status change becomes noise people mute — which is
 * indistinguishable from having no alerting at all.
 */

import { HealthAlerter } from '../src/health/health-alerter';

const WHY = ['None of the 1 configured printer(s) are online (0 in error, 1 offline).'];

describe('HealthAlerter', () => {
  it('says nothing about the first sample, even a bad one', () => {
    // A service that starts up already degraded has not changed. Announcing it
    // on every restart trains people to ignore the channel.
    const a = new HealthAlerter();
    expect(a.observe('degraded', WHY, 0)).toBeNull();
    expect(a.currentStatus).toBe('degraded');
  });

  it('ignores initializing, which is a startup value not a verdict', () => {
    const a = new HealthAlerter();
    expect(a.observe('initializing', [], 0)).toBeNull();
    expect(a.currentStatus).toBeNull();
  });

  it('alerts once a new status has held for the confirm window', () => {
    const a = new HealthAlerter({ confirmSamples: 2 });
    a.observe('healthy', [], 0);
    expect(a.observe('degraded', WHY, 1000)).toBeNull(); // one sample, not yet believed
    const alert = a.observe('degraded', WHY, 2000);
    expect(alert).not.toBeNull();
    expect(alert!.status).toBe('degraded');
    expect(alert!.previous).toBe('healthy');
    expect(alert!.reasons).toEqual(WHY);
    expect(alert!.recovered).toBe(false);
  });

  it('never alerts on a blip that resolves within the window', () => {
    // The whole point. One bad poll between two good ones is not an outage.
    const a = new HealthAlerter({ confirmSamples: 2 });
    a.observe('healthy', [], 0);
    expect(a.observe('degraded', WHY, 1000)).toBeNull();
    expect(a.observe('healthy', [], 2000)).toBeNull();
    expect(a.observe('degraded', WHY, 3000)).toBeNull();
    expect(a.observe('healthy', [], 4000)).toBeNull();
  });

  it('rate limits repeated problems', () => {
    const a = new HealthAlerter({ confirmSamples: 1, minIntervalMs: 10_000 });
    a.observe('healthy', [], 0);
    expect(a.observe('degraded', WHY, 1000)).not.toBeNull();

    // Recovers and breaks again inside the window — stays quiet.
    a.observe('healthy', [], 2000);
    expect(a.observe('degraded', WHY, 3000)).toBeNull();
  });

  it('always sends a recovery, even inside the rate-limit window', () => {
    // Someone holding a "degraded" message needs to know it is over.
    const a = new HealthAlerter({ confirmSamples: 1, minIntervalMs: 10_000 });
    a.observe('healthy', [], 0);
    expect(a.observe('degraded', WHY, 1000)).not.toBeNull();

    const recovery = a.observe('healthy', [], 2000);
    expect(recovery).not.toBeNull();
    expect(recovery!.recovered).toBe(true);
    expect(recovery!.previous).toBe('degraded');
  });

  it('does not re-alert the moment the rate-limit window expires', () => {
    // A suppressed alert still updates what we believe, otherwise the same
    // unchanged problem fires again as soon as the window is over.
    const a = new HealthAlerter({ confirmSamples: 1, minIntervalMs: 10_000 });
    a.observe('healthy', [], 0);
    a.observe('degraded', WHY, 1000);
    a.observe('healthy', [], 2000);
    expect(a.observe('degraded', WHY, 3000)).toBeNull(); // suppressed
    expect(a.observe('degraded', WHY, 60_000)).toBeNull(); // unchanged, so still nothing
  });

  it('alerts again for a genuinely new problem after the window', () => {
    const a = new HealthAlerter({ confirmSamples: 1, minIntervalMs: 10_000 });
    a.observe('healthy', [], 0);
    expect(a.observe('degraded', WHY, 1000)).not.toBeNull();
    expect(a.observe('healthy', [], 20_000)).not.toBeNull();
    expect(a.observe('degraded', WHY, 40_000)).not.toBeNull();
  });

  it('treats unhealthy as its own status, not a louder degraded', () => {
    const a = new HealthAlerter({ confirmSamples: 1, minIntervalMs: 0 });
    a.observe('healthy', [], 0);
    expect(a.observe('degraded', WHY, 1000)!.status).toBe('degraded');
    const worse = a.observe('unhealthy', ['The job store is unusable.'], 2000);
    expect(worse).not.toBeNull();
    expect(worse!.previous).toBe('degraded');
    expect(worse!.status).toBe('unhealthy');
  });
});
