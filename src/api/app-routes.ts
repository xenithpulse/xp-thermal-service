/**
 * Routes that manage the app rather than print: Start with Windows, updates,
 * origin pairing, and importing from the old XP Thermal Service.
 *
 * All of them are new; no existing route changed. They sit behind the API key
 * like everything else, and additionally only answer the dashboard itself — a
 * request from this machine whose page (if any) is also on this machine. A
 * website the operator allowed to print can fetch the API key, so without this
 * it could approve other websites or start an installer.
 */

import { Express, Request, Response, NextFunction } from 'express';
import { ConfigManager } from '../utils/config';
import { Logger } from '../utils/logger';
import { PrinterConfig } from '../types';
import { OriginPairing } from './origin-pairing';
import { isLoopbackHostname } from './origin-policy';
import { AppMode, isInstalledCopy } from '../app/paths';
import { isSea } from '../app/assets';
import {
  PRODUCT_NAME, PRODUCT_FULL_NAME, TAGLINE, VERSION, RELEASES_URL, HOMEPAGE_URL
} from '../app/identity';
import { getStartWithWindows, setStartWithWindows } from '../app/startup';
import { UpdateManager } from '../app/updates';
import {
  readLegacyPrinters, isLegacyServiceInstalled, importLegacyPrinters, legacyConfigPath
} from '../app/migration';
import { readAppState, updateAppState } from '../app/app-state';

export interface AppRoutesDeps {
  mode: AppMode;
  configManager: ConfigManager;
  pairing: OriginPairing;
  /** Push the saved security config into the running server. */
  applySecurity: () => void;
  /** Bring a newly configured printer online without a restart. */
  activatePrinter: (printer: PrinterConfig) => Promise<void>;
  logger: Logger;
}

function isLoopbackIp(ip: string): boolean {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip);
}

/** Only the dashboard (or a local tool with no browser origin) may use these. */
function localOperatorOnly(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket.remoteAddress || '';
  const origin = req.get('origin');
  let originIsLocal = !origin;
  if (origin) {
    try {
      originIsLocal = isLoopbackHostname(new URL(origin).hostname);
    } catch {
      originIsLocal = false;
    }
  }
  if (isLoopbackIp(ip) && originIsLocal) {
    next();
    return;
  }
  res.status(403).json({ error: 'Forbidden', message: 'Only the Thermal Bridge dashboard on this computer can do this.' });
}

/** Accept a bare web origin such as https://pos.example.com and nothing else. */
function parseOrigin(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

export function registerAppRoutes(app: Express, deps: AppRoutesDeps): void {
  const { mode, configManager: cm, pairing, logger } = deps;
  // The exe's server runs with its data directory as the working directory.
  const dataDir = process.cwd();
  const exe = isSea();
  const portable = mode === 'user' && exe && !isInstalledCopy();
  const startupAvailable = mode === 'user' && exe;

  const updates = new UpdateManager({
    dataDir,
    installKind: mode === 'user' && exe ? (portable ? 'portable' : 'setup') : 'none'
  });

  const fail = (res: Response, error: unknown, status = 400) => {
    res.status(status).json({ error: 'APP_ERROR', message: (error as Error).message ?? String(error) });
  };

  app.get('/api/app/info', localOperatorOnly, async (_req, res) => {
    try {
      const startup = startupAvailable ? await getStartWithWindows() : null;
      let legacy = null;
      if (mode === 'user') {
        const printers = readLegacyPrinters();
        legacy = {
          configPath: legacyConfigPath(),
          configFound: printers !== null,
          printerCount: printers?.length ?? 0,
          serviceInstalled: await isLegacyServiceInstalled(),
          handled: !!readAppState(dataDir).legacyImportHandled
        };
      }
      res.json({
        name: PRODUCT_NAME,
        fullName: PRODUCT_FULL_NAME,
        tagline: TAGLINE,
        version: VERSION,
        mode,
        exe,
        portable,
        dataDir,
        startup: { available: startupAvailable, enabled: startup?.enabled ?? false },
        legacy,
        releasesUrl: RELEASES_URL,
        homepageUrl: HOMEPAGE_URL
      });
    } catch (error) {
      fail(res, error, 500);
    }
  });

  app.put('/api/app/startup', localOperatorOnly, async (req, res) => {
    if (!startupAvailable) {
      fail(res, new Error('Start with Windows is only available in the Thermal Bridge app.'));
      return;
    }
    try {
      const enabled = req.body?.enabled === true;
      await setStartWithWindows(enabled);
      updateAppState(dataDir, { startupConfigured: true });
      // Tell the supervisor so the tray's check mark agrees with the page.
      process.send?.({ type: 'startupChanged', enabled });
      res.json({ success: true, enabled });
    } catch (error) {
      fail(res, error, 500);
    }
  });

  app.get('/api/app/updates', localOperatorOnly, (_req, res) => {
    res.json(updates.getStatus());
  });

  app.post('/api/app/updates/check', localOperatorOnly, async (_req, res) => {
    res.json(await updates.check());
  });

  app.post('/api/app/updates/download', localOperatorOnly, (_req, res) => {
    try {
      res.json(updates.download());
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/app/updates/install', localOperatorOnly, async (_req, res) => {
    try {
      res.json(await updates.install());
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/app/legacy/import', localOperatorOnly, async (_req, res) => {
    try {
      const result = importLegacyPrinters(cm);
      for (const id of result.imported) {
        const printer = cm.getPrinter(id);
        if (printer) await deps.activatePrinter(printer).catch(() => undefined);
      }
      updateAppState(dataDir, { legacyImportHandled: true });
      logger.info({ imported: result.imported, skipped: result.skipped }, 'Imported printers from XP Thermal Service');
      res.json({ success: true, ...result, printers: cm.getPrinters() });
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/api/app/legacy/dismiss', localOperatorOnly, (_req, res) => {
    updateAppState(dataDir, { legacyImportHandled: true });
    res.json({ success: true });
  });

  app.get('/api/origins', localOperatorOnly, (_req, res) => {
    const security = cm.getSecurityConfig();
    res.json({
      allowed: security.allowedOrigins,
      blocked: security.blockedOrigins ?? [],
      pending: pairing.list()
    });
  });

  app.post('/api/origins/decision', localOperatorOnly, (req, res) => {
    const origin = parseOrigin(req.body?.origin);
    const decision = req.body?.decision;
    if (!origin || !['allow', 'block', 'remove'].includes(decision)) {
      fail(res, new Error('Send { origin: "https://site.example", decision: "allow" | "block" | "remove" }.'));
      return;
    }

    try {
      const security = cm.getSecurityConfig();
      const same = (o: string) => o.trim().toLowerCase() === origin;
      const allowed = security.allowedOrigins.filter((o) => !same(o));
      const blocked = (security.blockedOrigins ?? []).filter((o) => !same(o));
      if (decision === 'allow') allowed.push(origin);
      if (decision === 'block') blocked.push(origin);

      cm.updateSecurityConfig({ allowedOrigins: allowed, blockedOrigins: blocked });
      deps.applySecurity();
      pairing.forget(origin);
      logger.info({ origin, decision }, 'Website origin decision saved');
      res.json({ success: true, allowed, blocked, pending: pairing.list() });
    } catch (error) {
      fail(res, error);
    }
  });
}
