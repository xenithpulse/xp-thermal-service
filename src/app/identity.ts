/**
 * Product identity: the names a user sees, in one place.
 *
 * VERSION is a literal rather than a read of package.json because the same
 * code runs from three layouts (ts-node in the repo, tsc output copied flat
 * into the POS install, and the single-file exe) and package.json sits at a
 * different relative path in each. tests/identity.test.ts and the exe build
 * both fail if this drifts from package.json.
 */

export const VERSION = '3.0.1';

export const PRODUCT_NAME = 'Thermal Bridge';
export const PRODUCT_FULL_NAME = 'Thermal Bridge by XenithPulse';
export const TAGLINE = 'Silent receipt printing for web apps';
export const COMPANY = 'XenithPulse';

/**
 * What /health and the endpoint files call this service.
 *
 * Deliberately NOT renamed: Pulsar POS and the dashboard's own port scan
 * confirm they found the print service by checking for exactly this string.
 */
export const SERVICE_ID = 'xp-thermal-service';

/** Windows service registered by `--install-service`. */
export const WINDOWS_SERVICE_NAME = 'ThermalBridge';
export const WINDOWS_SERVICE_DISPLAY_NAME = 'Thermal Bridge';

/** The service installed by the old setup.bat / Pulsar's WinSW wrapper. */
export const LEGACY_SERVICE_NAME = 'xpthermalprintservice.exe';
export const LEGACY_SERVICE_DISPLAY_NAME = 'XP Thermal Print Service';

/** HKCU Run value used for "Start with Windows". */
export const RUN_KEY_VALUE = 'ThermalBridge';

export const RELEASES_URL = 'https://github.com/xenithpulse/xp-thermal-service/releases';
export const HOMEPAGE_URL = 'https://xenithpulse.com/products/thermal-bridge';

/** The port the service tries first, and the range a client scans for it. */
export const DEFAULT_PORT = 9100;
export const DISCOVERY_PORTS: readonly number[] = Array.from({ length: 11 }, (_, i) => DEFAULT_PORT + i);
