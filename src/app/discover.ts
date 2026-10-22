/**
 * Find print services already answering on this machine.
 *
 * Every build of the service, old and new, answers /health with
 * service: 'xp-thermal-service'. Thermal Bridge also reports its name and run
 * mode, so an answer without `name` is the old XP Thermal Print Service.
 */

import { DISCOVERY_PORTS, SERVICE_ID } from './identity';

export interface RunningService {
  port: number;
  /** 'user' | 'service' | 'legacy' for Thermal Bridge; undefined for the old service. */
  mode?: string;
  version?: string;
  /** The old XP Thermal Print Service, which predates the rebrand. */
  legacy: boolean;
}

async function probe(port: number, timeoutMs: number): Promise<RunningService | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || body.service !== SERVICE_ID) return null;
    return {
      port,
      mode: typeof body.mode === 'string' ? body.mode : undefined,
      version: typeof body.version === 'string' ? body.version : undefined,
      legacy: typeof body.name !== 'string'
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the whole discovery range in parallel; lowest port first. */
export async function findRunningServices(
  ports: readonly number[] = DISCOVERY_PORTS,
  timeoutMs = 800
): Promise<RunningService[]> {
  const found = await Promise.all(ports.map((port) => probe(port, timeoutMs)));
  return found.filter((s): s is RunningService => s !== null);
}

/** A machine-wide install (Thermal Bridge service or the old service) that this app should defer to. */
export function machineWideService(services: RunningService[]): RunningService | undefined {
  return services.find((s) => s.legacy || s.mode === 'service' || s.mode === 'legacy');
}
