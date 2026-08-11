/**
 * Printer Resolver
 *
 * Decides three things, and nothing else:
 *
 *   1. classifyStatus() — what a Windows queue's real state is, corroborating
 *      the notoriously unreliable WorkOffline flag against physical presence.
 *   2. resolveQueue()   — which live queue a saved config actually refers to,
 *      after the queue was renamed, duplicated, or moved to another USB port.
 *   3. planHealing()    — the ordered, least-invasive repairs to try.
 *
 * Keeping this pure (snapshot in, decision out) makes the behaviour testable
 * and keeps the adapter free of Windows trivia.
 */

import {
  WindowsPrinterInfo,
  WindowsPrintSnapshot,
  UsbPrintDevice,
  PRINTER_STATE,
  DETECTED_ERROR,
  findByName
} from './windows-printers';
import { PrinterStatus } from '../types';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface StatusVerdict {
  status: PrinterStatus;
  /** Short, human-readable explanation suitable for the dashboard. */
  reason: string;
  /** True when a repair action is likely to fix this without user help. */
  healable: boolean;
  /** True when we believe bytes would reach the printer right now. */
  printable: boolean;
  /** Structured signals behind the verdict, for the diagnose endpoint. */
  signals: {
    queueFound: boolean;
    spoolerRunning: boolean;
    workOffline: boolean;
    devicePresent: boolean | null;
    portLive: boolean | null;
    portMigrated: boolean;
    suggestedPort?: string;
    hardErrorFlags: string[];
  };
}

export interface ResolutionCandidate {
  printer: WindowsPrinterInfo;
  score: number;
  reasons: string[];
}

export interface QueueResolution {
  /** The queue we believe the config refers to, if any. */
  match: WindowsPrinterInfo | null;
  /** True when the configured name matched a live queue exactly. */
  exact: boolean;
  /** Confident enough to silently adopt (rename the binding). */
  autoAdopt: boolean;
  reason: string;
  candidates: ResolutionCandidate[];
}

export type HealAction =
  | { kind: 'clearWorkOffline'; printerName: string; why: string }
  | { kind: 'setPort'; printerName: string; portName: string; why: string }
  | { kind: 'resumeQueue'; printerName: string; purge: boolean; why: string }
  | { kind: 'rebind'; printerName: string; why: string }
  | { kind: 'restartSpooler'; why: string };

export interface HealPlan {
  actions: HealAction[];
  /** Set when no automated action can help and the user must intervene. */
  manualHint?: string;
}

/** Identity breadcrumbs stored in printer config metadata. */
export interface PrinterIdentityHints {
  windowsPort?: string;
  windowsDriver?: string;
  usbHardwareId?: string;
  lastKnownGoodAt?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Queue classification helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Virtual/document queues that are never a physical receipt printer. */
const VIRTUAL_QUEUE_PATTERNS = [
  /microsoft print to pdf/i,
  /microsoft xps document writer/i,
  /^fax$/i,
  /onenote/i,
  /adobe pdf/i,
  /pdfcreator/i,
  /print to file/i,
  /^send to /i
];

/** Strong signals that a queue is an ESC/POS receipt printer. */
const THERMAL_NAME_PATTERNS = [
  /xprinter/i, /\bxp-?\d/i, /\bpos-?\d{2}/i, /pos58/i, /pos80/i,
  /\btm-?[tu]\d/i, /epson tm/i, /star (tsp|mc|sp7)/i, /\btsp\d/i,
  /citizen (ct|cbm)/i, /bixolon/i, /\bsrp-?\d/i, /rongta/i, /\brp-?\d{2}/i,
  /gprinter/i, /\bgp-?\d{2}/i, /zjiang/i, /\bzj-?\d{2}/i, /munbyn/i,
  /\bhoin\b/i, /netum/i, /sam4s/i, /ellix/i, /\bmht-?p/i, /goojprt/i,
  /thermal/i, /receipt/i, /\bkitchen\b/i, /\bkot\b/i, /ticket printer/i,
  /58\s?mm/i, /80\s?mm/i, /\b(58|80)(mm)?\b/i,
  /generic\s*\/\s*text only/i
];

/** Ports that imply a directly attached (not virtual) device. */
const PHYSICAL_PORT_PATTERN = /^(USB\d+|COM\d+:?|LPT\d+:?|ESDPRT|WSD-|\d{1,3}(\.\d{1,3}){3})/i;

const USB_PORT_PATTERN = /^USB\d+$/i;

export function isVirtualQueue(printer: WindowsPrinterInfo): boolean {
  return VIRTUAL_QUEUE_PATTERNS.some(
    (re) => re.test(printer.name) || re.test(printer.driverName)
  );
}

/**
 * Score how likely a queue is to be an ESC/POS thermal printer (0–100).
 * Used to rank discovery results so the right printer is offered first.
 */
export function thermalScore(printer: WindowsPrinterInfo): number {
  if (isVirtualQueue(printer)) return 0;

  let score = 20; // any real queue is at least conceivable
  const haystack = `${printer.name} ${printer.driverName}`;

  const nameHits = THERMAL_NAME_PATTERNS.filter((re) => re.test(haystack)).length;
  score += Math.min(nameHits * 25, 60);

  if (USB_PORT_PATTERN.test(printer.portName)) score += 15;
  else if (/^COM\d+/i.test(printer.portName)) score += 10;
  else if (PHYSICAL_PORT_PATTERN.test(printer.portName)) score += 5;

  // Full-page drivers are a strong negative: inkjets and lasers advertise
  // page-description languages that thermal units never do.
  if (/\b(pcl|postscript|ps3|xps|deskjet|laserjet|officejet|pixma|inkjet|ecotank|imageclass|photosmart)\b/i.test(haystack)) {
    score -= 45;
  }

  return Math.max(0, Math.min(100, score));
}

export function isLikelyThermal(printer: WindowsPrinterInfo): boolean {
  return thermalScore(printer) >= 50;
}

/** Guess the character width from the model name (58mm ≈ 32 cols, 80mm ≈ 48). */
export function guessPaperWidth(printer: WindowsPrinterInfo): number {
  const haystack = `${printer.name} ${printer.driverName}`;
  if (/58\s?mm|pos-?58|rp-?58|zj-?58|\bxp-?58/i.test(haystack)) return 32;
  if (/76\s?mm|\bxp-?76/i.test(haystack)) return 42;
  if (/80\s?mm|pos-?80|rp-?80|zj-?80|\bxp-?80|tm-?t8/i.test(haystack)) return 48;
  return 48;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Status classification
// ─────────────────────────────────────────────────────────────────────────────

function hardErrorFlags(state: number): string[] {
  const flags: string[] = [];
  if (state & PRINTER_STATE.PAPER_OUT) flags.push('paper out');
  if (state & PRINTER_STATE.PAPER_JAM) flags.push('paper jam');
  if (state & PRINTER_STATE.PAPER_PROBLEM) flags.push('paper problem');
  if (state & PRINTER_STATE.DOOR_OPEN) flags.push('cover open');
  if (state & PRINTER_STATE.NO_TONER) flags.push('no toner');
  if (state & PRINTER_STATE.USER_INTERVENTION) flags.push('needs attention');
  if (state & PRINTER_STATE.OUT_OF_MEMORY) flags.push('out of memory');
  if (state & PRINTER_STATE.NOT_AVAILABLE) flags.push('not available');
  if (state & PRINTER_STATE.ERROR) flags.push('error');
  return flags;
}

/**
 * Work out what a queue's state really is.
 *
 * The central rule: WorkOffline is only believed when something else agrees
 * with it. A queue reporting WorkOffline with PrinterState=0 and
 * DetectedErrorState=0, backed by a physically attached device, is online — the
 * flag is simply stale. This single change is what stops healthy thermal
 * printers being reported as offline.
 */
export function classifyStatus(
  printer: WindowsPrinterInfo | undefined,
  snapshot: WindowsPrintSnapshot,
  hints: PrinterIdentityHints = {}
): StatusVerdict {
  const base = {
    queueFound: !!printer,
    spoolerRunning: snapshot.spoolerRunning,
    workOffline: printer?.workOffline ?? false,
    devicePresent: null as boolean | null,
    portLive: null as boolean | null,
    portMigrated: false,
    hardErrorFlags: [] as string[]
  };

  if (!printer) {
    return {
      status: PrinterStatus.OFFLINE,
      reason: 'No Windows print queue with this name exists',
      healable: true, // a rebind may find it under a new name
      printable: false,
      signals: base
    };
  }

  if (!snapshot.spoolerRunning) {
    return {
      status: PrinterStatus.ERROR,
      reason: 'The Windows Print Spooler service is not running',
      healable: true,
      printable: false,
      signals: { ...base, workOffline: printer.workOffline }
    };
  }

  const isUsb = USB_PORT_PATTERN.test(printer.portName);
  const portLive = isUsb ? snapshot.livePorts.includes(printer.portName) : null;
  // Only meaningful for USB: an empty device list with a USB-bound queue means
  // nothing is plugged in. For COM/LAN queues we have no equivalent probe.
  const devicePresent = isUsb ? snapshot.usbDevices.length > 0 && portLive : null;
  const migrated = isUsb && !portLive && snapshot.livePorts.length > 0;
  const suggestedPort = migrated ? pickMigrationPort(printer, snapshot, hints) : undefined;

  const signals = {
    ...base,
    devicePresent,
    portLive,
    portMigrated: migrated,
    suggestedPort,
    hardErrorFlags: hardErrorFlags(printer.printerState)
  };

  // ── Real, physical faults come first: these are never spurious ───────────
  if (printer.printerState & PRINTER_STATE.PAPER_OUT ||
      printer.detectedErrorState === DETECTED_ERROR.NO_PAPER ||
      printer.detectedErrorState === DETECTED_ERROR.LOW_PAPER) {
    return {
      status: PrinterStatus.PAPER_OUT,
      reason: 'The printer is out of paper',
      healable: false,
      printable: false,
      signals
    };
  }

  if (printer.printerState & PRINTER_STATE.DOOR_OPEN ||
      printer.detectedErrorState === DETECTED_ERROR.DOOR_OPEN) {
    return {
      status: PrinterStatus.COVER_OPEN,
      reason: 'The printer cover is open',
      healable: false,
      printable: false,
      signals
    };
  }

  if (printer.printerState & PRINTER_STATE.PAPER_JAM ||
      printer.detectedErrorState === DETECTED_ERROR.JAMMED) {
    return {
      status: PrinterStatus.ERROR,
      reason: 'The printer reports a paper jam',
      healable: false,
      printable: false,
      signals
    };
  }

  // ── USB cable moved to a different socket ────────────────────────────────
  if (migrated) {
    return {
      status: PrinterStatus.OFFLINE,
      reason: suggestedPort
        ? `The printer moved to USB port ${suggestedPort} but the queue is still bound to ${printer.portName}`
        : `The queue is bound to ${printer.portName}, which has no device attached. Several printers are ` +
          `connected and none can be matched to this one with confidence — choose the right one from Find Printers.`,
      // Only claim this is repairable when we know which port to move it to.
      healable: !!suggestedPort,
      printable: false,
      signals
    };
  }

  // ── Genuinely unplugged USB device ───────────────────────────────────────
  // Two independent signals must agree before we call a printer unplugged:
  // no device enumerated on its port, *and* Windows itself having marked the
  // queue offline. Requiring both means a printer behind a vendor driver that
  // does not enumerate the way we expect is never wrongly declared dead — if
  // Windows sees no problem, neither do we.
  if (isUsb && devicePresent === false && printer.workOffline) {
    return {
      status: PrinterStatus.OFFLINE,
      reason: 'No USB printing device is attached — check the cable and that the printer is switched on',
      healable: false,
      printable: false,
      signals
    };
  }

  // ── Hard offline signals that agree with each other ──────────────────────
  // DetectedErrorState 9 and ExtendedPrinterStatus 7 are far more trustworthy
  // than WorkOffline, and are what a genuinely unreachable printer reports.
  const corroboratedOffline =
    printer.detectedErrorState === DETECTED_ERROR.OFFLINE ||
    printer.extendedPrinterStatus === 7 ||
    (printer.printerState & PRINTER_STATE.OFFLINE) !== 0;

  if (corroboratedOffline && devicePresent !== true) {
    return {
      status: PrinterStatus.OFFLINE,
      reason: 'Windows reports the printer as offline or unreachable',
      healable: printer.workOffline,
      printable: false,
      signals
    };
  }

  if (printer.printerState & PRINTER_STATE.ERROR ||
      printer.printerState & PRINTER_STATE.NOT_AVAILABLE) {
    return {
      status: PrinterStatus.ERROR,
      reason: `The printer reports: ${signals.hardErrorFlags.join(', ') || 'an error'}`,
      healable: true,
      printable: false,
      signals
    };
  }

  if (printer.printerState & PRINTER_STATE.PAUSED) {
    return {
      status: PrinterStatus.ERROR,
      reason: 'The print queue is paused',
      healable: true,
      printable: false,
      signals
    };
  }

  // ── The stale-flag case: WorkOffline with nothing corroborating it ───────
  if (printer.workOffline) {
    return {
      status: PrinterStatus.ONLINE,
      reason:
        'Ready — Windows has a stale "Use Printer Offline" flag set, which will be cleared automatically',
      healable: true,
      printable: true,
      signals
    };
  }

  if (printer.printerState & (PRINTER_STATE.PRINTING | PRINTER_STATE.BUSY | PRINTER_STATE.PROCESSING)) {
    return {
      status: PrinterStatus.BUSY,
      reason: 'The printer is currently printing',
      healable: false,
      printable: true,
      signals
    };
  }

  // Anything left is ready. Cheap thermal units routinely report PrinterStatus
  // 1 ("Other") or 2 ("Unknown") while working perfectly, so an unrecognised
  // value must not be downgraded to an error.
  return {
    status: PrinterStatus.ONLINE,
    reason: 'Ready',
    healable: false,
    printable: true,
    signals
  };
}

/**
 * Choose which live USB port a migrated queue should be repointed at.
 * With exactly one attached device the answer is unambiguous; with several we
 * prefer a port no other queue has already claimed.
 */
function pickMigrationPort(
  printer: WindowsPrinterInfo,
  snapshot: WindowsPrintSnapshot,
  hints: PrinterIdentityHints = {}
): string | undefined {
  const live = snapshot.livePorts;
  if (live.length === 0) return undefined;

  const claimed = new Set(
    snapshot.printers
      .filter((p) => p.name !== printer.name)
      .map((p) => p.portName)
  );

  // Strongest signal, and the one that matters on a USB hub or a Type-C dock
  // where several printers move ports together: the same physical device we
  // were bound to last time, identified by its hardware id.
  if (hints.usbHardwareId) {
    const sameDevice = snapshot.usbDevices.find(
      (d) => d.portName && d.hardwareId && d.hardwareId === hints.usbHardwareId
    );
    if (sameDevice?.portName) return sameDevice.portName;
  }

  // Never consider a port another configured printer is already using: moving
  // onto it would hijack that printer's device.
  const unclaimed = live.filter((p) => !claimed.has(p));
  if (unclaimed.length === 0) return undefined;
  if (unclaimed.length === 1) return unclaimed[0];

  // Still several candidates: prefer a device whose reported name resembles
  // this queue.
  const byName = snapshot.usbDevices.find(
    (d) => d.portName && !claimed.has(d.portName) && namesRelated(d.name, printer.name)
  );
  if (byName?.portName) return byName.portName;

  // Several indistinguishable printers on a hub. A wrong guess would send order
  // tickets to the bar, so this one is left for a human to decide.
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Queue resolution (rename / duplicate / migration tolerant)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip the decorations Windows adds when it re-installs a printer it has seen
 * before: "XP-80C (Copy 1)", "XP-80C (1)", "XP-80C - Copy".
 */
export function normalizeQueueName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((?:copy\s*)?\d*\)\s*$/i, '')
    .replace(/\s*-\s*copy(\s*\(\d+\))?\s*$/i, '')
    .replace(/\s*copy\s*\d*\s*$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(name: string): string[] {
  return normalizeQueueName(name).split(' ').filter((t) => t.length > 1);
}

function namesRelated(a: string, b: string): boolean {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const overlap = ta.filter((t) => tb.includes(t)).length;
  return overlap / Math.min(ta.length, tb.length) >= 0.5;
}

/**
 * Work out which live queue a saved configuration refers to.
 *
 * Ordered by how much we trust each signal: an exact name beats everything,
 * then a normalized name, then the remembered driver/port breadcrumbs, then
 * loose name similarity. Physical presence is a strong tie-breaker.
 */
export function resolveQueue(
  configuredName: string,
  snapshot: WindowsPrintSnapshot,
  hints: PrinterIdentityHints = {},
  claimedByOthers: string[] = []
): QueueResolution {
  const exactMatch = findByName(snapshot.printers, configuredName);

  if (exactMatch) {
    return {
      match: exactMatch,
      exact: true,
      autoAdopt: false,
      reason: 'The configured print queue exists',
      candidates: [{ printer: exactMatch, score: 1000, reasons: ['exact name match'] }]
    };
  }

  const claimed = new Set(claimedByOthers.map((n) => n.trim().toLowerCase()));
  const normTarget = normalizeQueueName(configuredName);
  const targetTokens = tokens(configuredName);

  const candidates: ResolutionCandidate[] = [];

  for (const printer of snapshot.printers) {
    if (isVirtualQueue(printer)) continue;

    let score = 0;
    const reasons: string[] = [];

    if (normalizeQueueName(printer.name) === normTarget && normTarget) {
      score += 850;
      reasons.push('same name ignoring copy/duplicate suffix');
    } else {
      const pt = tokens(printer.name);
      const overlap = targetTokens.filter((t) => pt.includes(t)).length;
      if (overlap > 0 && targetTokens.length > 0) {
        const ratio = overlap / Math.max(targetTokens.length, pt.length);
        score += Math.round(ratio * 400);
        reasons.push(`name similarity ${Math.round(ratio * 100)}%`);
      }
    }

    if (hints.windowsDriver && printer.driverName === hints.windowsDriver) {
      score += 260;
      reasons.push('same printer driver as before');
    }

    if (hints.windowsPort && printer.portName === hints.windowsPort) {
      score += 140;
      reasons.push('same port as before');
    }

    if (USB_PORT_PATTERN.test(printer.portName) && snapshot.livePorts.includes(printer.portName)) {
      score += 150;
      reasons.push('a device is physically attached to its port');
    }

    if (isLikelyThermal(printer)) {
      score += 90;
      reasons.push('looks like a thermal receipt printer');
    }

    if (claimed.has(printer.name.trim().toLowerCase())) {
      score -= 300;
      reasons.push('already used by another configured printer');
    }

    if (score > 0) {
      candidates.push({ printer, score, reasons });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0];
  const runnerUp = candidates[1];

  // A queue another configured printer already owns is still offered as a
  // suggestion — two entries may legitimately share one physical printer — but
  // it is never adopted automatically. Silently pointing the receipt printer at
  // the kitchen's queue would send every order ticket to the wrong place.
  const bestIsClaimed = best ? claimed.has(best.printer.name.trim().toLowerCase()) : false;

  if (!best) {
    return {
      match: null,
      exact: false,
      autoAdopt: false,
      reason: `No Windows queue resembles "${configuredName}"`,
      candidates: []
    };
  }

  // Adopt only when the winner is both strong and clearly ahead, so we never
  // silently bind a receipt printer to the wrong device.
  const decisive = !runnerUp || best.score - runnerUp.score >= 150;
  const autoAdopt = best.score >= 600 && decisive && !bestIsClaimed;

  let reason: string;
  if (autoAdopt) {
    reason = `Matched "${configuredName}" to "${best.printer.name}" (${best.reasons.join('; ')})`;
  } else if (bestIsClaimed) {
    reason =
      `"${best.printer.name}" looks like the right queue but another configured printer ` +
      `already uses it, so it needs to be chosen manually`;
  } else {
    reason = `Best guess is "${best.printer.name}", but the match is not confident enough to apply automatically`;
  }

  return {
    match: best.printer,
    exact: false,
    autoAdopt,
    reason,
    candidates: candidates.slice(0, 5)
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Repair planning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Produce the ordered list of repairs to attempt, cheapest and least invasive
 * first. An empty action list means nothing automated will help.
 */
export function planHealing(
  configuredName: string,
  printer: WindowsPrinterInfo | undefined,
  verdict: StatusVerdict,
  snapshot: WindowsPrintSnapshot
): HealPlan {
  const actions: HealAction[] = [];

  if (!snapshot.spoolerRunning) {
    return {
      actions: [{ kind: 'restartSpooler', why: 'The Print Spooler service is not running' }]
    };
  }

  if (!printer) {
    return {
      actions: [
        {
          kind: 'rebind',
          printerName: configuredName,
          why: 'The configured queue no longer exists; searching for it under a new name'
        }
      ],
      manualHint:
        `No print queue named "${configuredName}" exists. Open Printers & scanners to confirm the ` +
        `printer is installed, or pick it again from Discover printers.`
    };
  }

  // Cable moved to another USB socket — repoint the queue.
  if (verdict.signals.portMigrated && verdict.signals.suggestedPort) {
    actions.push({
      kind: 'setPort',
      printerName: printer.name,
      portName: verdict.signals.suggestedPort,
      why: `The printer is now on ${verdict.signals.suggestedPort} but the queue points at ${printer.portName}`
    });
  }

  // Stale offline flag — the most common cause of a false "offline".
  // Pointless when the device really is unplugged: Windows sets the flag right
  // back, so we would just churn the spooler until someone plugs the cable in.
  if (printer.workOffline && verdict.signals.devicePresent !== false) {
    actions.push({
      kind: 'clearWorkOffline',
      printerName: printer.name,
      why: 'Windows has the "Use Printer Offline" flag set on this queue'
    });
  }

  // Paused queue, or jobs wedged behind a failed one.
  if (printer.printerState & PRINTER_STATE.PAUSED) {
    actions.push({
      kind: 'resumeQueue',
      printerName: printer.name,
      purge: false,
      why: 'The print queue is paused'
    });
  } else if (printer.printerState & PRINTER_STATE.ERROR) {
    actions.push({
      kind: 'resumeQueue',
      printerName: printer.name,
      purge: true,
      why: 'Clearing jobs stuck in an errored queue'
    });
  }

  let manualHint: string | undefined;

  if (actions.length === 0) {
    if (verdict.status === PrinterStatus.PAPER_OUT) {
      manualHint = 'Load a new paper roll, then the printer will come back automatically.';
    } else if (verdict.status === PrinterStatus.COVER_OPEN) {
      manualHint = 'Close the printer cover.';
    } else if (verdict.signals.devicePresent === false) {
      manualHint =
        'No USB printing device is attached. Check that the printer is powered on and the USB ' +
        'cable is connected — any port will do, the service will follow it.';
    }
  }

  return { actions, manualHint };
}

/** Read identity breadcrumbs out of a printer config's metadata bag. */
export function readHints(metadata: Record<string, unknown> | undefined): PrinterIdentityHints {
  const m = metadata ?? {};
  return {
    windowsPort: typeof m.windowsPort === 'string' ? m.windowsPort : undefined,
    windowsDriver: typeof m.windowsDriver === 'string' ? m.windowsDriver : undefined,
    usbHardwareId: typeof m.usbHardwareId === 'string' ? m.usbHardwareId : undefined,
    lastKnownGoodAt: typeof m.lastKnownGoodAt === 'number' ? m.lastKnownGoodAt : undefined
  };
}

/** Build the breadcrumbs to persist after a successful connection. */
export function buildHints(
  printer: WindowsPrinterInfo,
  usbDevices: UsbPrintDevice[]
): PrinterIdentityHints {
  const device = usbDevices.find((d) => d.portName === printer.portName);
  return {
    windowsPort: printer.portName,
    windowsDriver: printer.driverName,
    usbHardwareId: device?.hardwareId || undefined,
    lastKnownGoodAt: Date.now()
  };
}
