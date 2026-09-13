/**
 * Why can't we reach this network printer? — the LAN counterpart to
 * printer-resolver's classifyStatus.
 *
 * A USB printer that will not print gets a sentence the operator can act on
 * ("The printer is out of paper", "Moved to USB003"). A network printer got
 * this:
 *
 *     connect ECONNREFUSED 192.168.1.100:9100
 *
 * which is the errno, not a diagnosis. The person reading it is standing in a
 * restaurant wondering why the kitchen ticket did not come out, and every one
 * of these failures has a different and specific cause: a wrong IP reaches
 * nothing, a right IP with a wrong port is refused instantly, and a printer
 * asleep on Wi-Fi times out. They are not interchangeable, and telling them
 * apart is the whole job of this module.
 *
 * Pure and dependency-free on purpose, the same as health-verdict: a decision
 * this load-bearing should be provable without opening a socket.
 */

/** A Node socket error, narrowed to what we actually read. */
export interface SocketErrorLike {
  code?: string;
  message?: string;
  /** Present on DNS failures. */
  syscall?: string;
}

export interface NetworkDiagnosis {
  /** One sentence naming the cause, for the dashboard status line. */
  reason: string;
  /** What the operator should do next. Always actionable, never "check the network". */
  fix: string;
  /**
   * True when the cause is transient and retrying unattended is reasonable —
   * a printer waking from sleep, a brief Wi-Fi drop.
   *
   * False when retrying cannot possibly help because the configuration is
   * wrong: no amount of waiting turns a typo'd IP into a printer.
   */
  retryable: boolean;
}

/**
 * Ports that are almost always a mistake to point a thermal printer at.
 * Not a security control — the adapter's own range check does that — but the
 * difference between "refused" and "you typed the web port" is the difference
 * between a support call and a fix.
 */
const MISTAKEN_PORTS: Record<number, string> = {
  80: 'port 80 is the printer\'s web page, not its print port',
  443: 'port 443 is the printer\'s web page, not its print port',
  515: 'port 515 is LPR/LPD, which this service does not speak',
  631: 'port 631 is IPP, which this service does not speak',
  25: 'port 25 is email',
  22: 'port 22 is SSH'
};

/** The de-facto standard RAW/JetDirect port every ESC/POS network printer uses. */
export const RAW_PRINT_PORT = 9100;

/**
 * Turn a failed connection attempt into something a person can act on.
 *
 * `host` and `port` are echoed into the text deliberately. A site with four
 * printers produces four of these lines, and a reason that does not say which
 * address failed is a reason nobody can use.
 */
export function diagnoseNetworkError(
  error: SocketErrorLike,
  host: string,
  port: number
): NetworkDiagnosis {
  const code = (error.code || '').toUpperCase();
  const target = `${host}:${port}`;

  switch (code) {
    case 'ECONNREFUSED': {
      // The host is alive and answered — it simply has nothing listening here.
      // That makes this the most diagnostic failure of the set: the IP is
      // right, so the port or the printer's mode is wrong.
      const mistaken = MISTAKEN_PORTS[port];
      if (mistaken) {
        return {
          reason: `${host} refused the connection on port ${port} — ${mistaken}.`,
          fix: `Change the port to ${RAW_PRINT_PORT}. Almost every network thermal printer listens on ${RAW_PRINT_PORT} for raw ESC/POS.`,
          retryable: false
        };
      }
      return {
        reason: `${host} is reachable but refused the connection on port ${port}.`,
        fix:
          port === RAW_PRINT_PORT
            ? `The device at ${host} answered, so the IP is right, but nothing is listening on ${RAW_PRINT_PORT}. Check that raw/JetDirect printing is enabled in the printer's network settings, and that this IP is the printer rather than another device.`
            : `Try port ${RAW_PRINT_PORT}, which is the standard raw printing port. If the printer really uses ${port}, confirm raw printing is enabled on it.`,
        retryable: false
      };
    }

    case 'EHOSTUNREACH':
      return {
        reason: `No route to ${host} — it is not reachable from this machine.`,
        fix: `Check that ${host} is on the same network as this PC. A printer on 192.168.1.x cannot be reached from a PC on 192.168.0.x without a router between them.`,
        retryable: false
      };

    case 'ENETUNREACH':
      return {
        reason: `The network is unreachable while trying to contact ${host}.`,
        fix: 'This PC has no usable network connection. Check the Ethernet cable or Wi-Fi on the PC itself, not the printer.',
        retryable: true
      };

    case 'ETIMEDOUT':
    case 'PRINTER_TIMEOUT':
      // Nothing answered at all. Either the address is empty or the device is
      // asleep — and those need different advice, so say both plainly.
      return {
        reason: `${target} did not respond within the connection timeout.`,
        fix: `Confirm the printer is powered on and its IP is still ${host} — printers on DHCP change address after a reboot. Print the printer's self-test page to read its current IP, then give it a DHCP reservation or a static IP so it stops moving.`,
        retryable: true
      };

    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        reason: `The name "${host}" could not be resolved to an address.`,
        fix: `Use the printer's numeric IP address (for example 192.168.1.100) instead of a name. Host names depend on DNS, which most printers are not registered in.`,
        retryable: false
      };

    case 'ECONNRESET':
      return {
        reason: `${host} closed the connection unexpectedly.`,
        fix: `The printer accepted the connection then dropped it. This usually means another machine is already connected to it — most network thermal printers accept only one connection at a time. Check whether a second till or print server is holding it open.`,
        retryable: true
      };

    case 'EADDRNOTAVAIL':
      return {
        reason: `${host} is not a valid address on this network.`,
        fix: 'Check the IP for a typo. It should look like 192.168.1.100 — four numbers, each 0-255.',
        retryable: false
      };

    case 'EACCES':
    case 'EPERM':
      return {
        reason: `Permission denied connecting to ${target}.`,
        fix: 'Windows Firewall or security software is blocking outbound connections from this service. Allow it through, or add an outbound rule for this port.',
        retryable: false
      };

    default:
      // Unknown errno. Still name the target and still give a first step —
      // an unrecognised code is not a reason to fall back to "unknown error".
      return {
        reason: error.message
          ? `Could not connect to ${target}: ${error.message}`
          : `Could not connect to ${target}.`,
        fix: `Confirm the printer is powered on, then check that ${host} answers a ping from this PC. If it does, the port is likely wrong — the standard is ${RAW_PRINT_PORT}.`,
        retryable: true
      };
  }
}

/**
 * Validate the address before a socket is ever opened.
 *
 * Returns null when the configuration is usable. Catching a blank host here
 * means the operator is told at the moment they press Save, rather than
 * discovering it when the first ticket fails to print.
 */
export function validateNetworkTarget(
  host: string | undefined,
  port: number | undefined
): string | null {
  if (!host || !host.trim()) {
    return 'A network printer needs an IP address. Find it on the printer\'s self-test page, or in its display menu under Network.';
  }

  const trimmed = host.trim();

  // Reject the obvious typo classes with specific advice. A generic "invalid
  // host" teaches nothing; naming the mistake fixes it in one pass.
  if (/^https?:\/\//i.test(trimmed)) {
    return `Enter only the address, not a URL. Use "${trimmed.replace(/^https?:\/\//i, '').replace(/[/:].*$/, '')}" rather than "${trimmed}".`;
  }

  if (/\s/.test(trimmed)) {
    return `The IP address "${trimmed}" contains a space.`;
  }

  // A dotted-quad that is *nearly* right is the common case: 192.168.1.300,
  // or three octets because one was missed.
  if (/^\d+(\.\d+)*$/.test(trimmed)) {
    const parts = trimmed.split('.');
    if (parts.length !== 4) {
      return `"${trimmed}" is not a complete IP address. It needs four numbers separated by dots, for example 192.168.1.100.`;
    }
    const bad = parts.find((p) => Number(p) > 255);
    if (bad !== undefined) {
      return `"${trimmed}" is not a valid IP address — ${bad} is above 255.`;
    }
  }

  if (port === undefined || port === null || Number.isNaN(port)) {
    return `A network printer needs a port. Use ${RAW_PRINT_PORT} unless the printer's manual says otherwise.`;
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return `Port ${port} is not valid. Use ${RAW_PRINT_PORT} unless the printer's manual says otherwise.`;
  }

  return null;
}

/**
 * Advice for a port that is technically valid but probably not what was meant.
 * Separate from validation because this must never block saving — a site may
 * genuinely have moved raw printing to another port.
 */
export function warnAboutPort(port: number): string | null {
  if (port === RAW_PRINT_PORT) return null;
  const mistaken = MISTAKEN_PORTS[port];
  if (mistaken) {
    return `Port ${port} looks wrong — ${mistaken}. Raw ESC/POS printing is almost always on ${RAW_PRINT_PORT}.`;
  }
  return null;
}
