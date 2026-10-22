/**
 * The names other software depends on.
 *
 * Pulsar POS and older clients find the service by /health's `service` field
 * and by scanning 9100–9110; the rebrand must not move either.
 */

import * as fs from 'fs';
import * as path from 'path';
import { VERSION, SERVICE_ID, DISCOVERY_PORTS, PRODUCT_NAME } from '../src/app/identity';
import { machineWideService } from '../src/app/discover';

describe('identity', () => {
  it('reports the same version as package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });

  it('keeps the service id and port range clients rely on', () => {
    expect(SERVICE_ID).toBe('xp-thermal-service');
    expect(DISCOVERY_PORTS[0]).toBe(9100);
    expect(DISCOVERY_PORTS[DISCOVERY_PORTS.length - 1]).toBe(9110);
    expect(PRODUCT_NAME).toBe('Thermal Bridge');
  });
});

describe('machineWideService', () => {
  it('defers to the old service and to a Thermal Bridge service, never to another per-user app', () => {
    expect(machineWideService([{ port: 9100, legacy: true }])?.port).toBe(9100);
    expect(machineWideService([{ port: 9101, legacy: false, mode: 'service' }])?.port).toBe(9101);
    expect(machineWideService([{ port: 9100, legacy: false, mode: 'user' }])).toBeUndefined();
  });
});
