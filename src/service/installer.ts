/**
 * Windows Service Wrapper
 * Allows the print service to run as a Windows service
 */

import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

// We'll use node-windows for Windows service management
let Service: typeof import('node-windows').Service;

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  Service = require('node-windows').Service;
} catch {
  // node-windows not available
}

const SERVICE_NAME = 'XP Thermal Print Service';
const SERVICE_DESCRIPTION = 'Production-grade thermal printing service for restaurant POS';
// node-windows derives the Windows service key name by lowercasing and removing
// spaces from the display name, then appending ".exe".
const SERVICE_KEY_NAME = 'xpthermalprintservice.exe';

/**
 * Detect project root for both dev (dist/service/) and flat install (XPThermalService/service/).
 */
function detectProjectRoot(): string {
  const parentDir = path.resolve(__dirname, '..');
  // Flat install: parent has package.json (C:\ProgramData\XPThermalService\)
  if (fs.existsSync(path.join(parentDir, 'package.json'))) {
    return parentDir;
  }
  // Dev: parent is dist/, grandparent is project root
  return path.resolve(__dirname, '..', '..');
}

export interface ServiceOptions {
  name?: string;
  description?: string;
  script?: string;
  env?: Array<{ name: string; value: string }>;
}

export class WindowsServiceManager {
  private service: InstanceType<typeof Service> | null = null;
  private options: ServiceOptions;

  constructor(options: ServiceOptions = {}) {
    const projectRoot = detectProjectRoot();

    this.options = {
      name: options.name || SERVICE_NAME,
      description: options.description || SERVICE_DESCRIPTION,
      script: options.script || path.join(__dirname, '..', 'index.js'),
      env: options.env || []
    };

    if (Service) {
      this.service = new Service({
        name: this.options.name!,
        description: this.options.description,
        script: this.options.script!,
        env: this.options.env,
        nodeOptions: ['--max-old-space-size=256'],
        maxRestarts: 10,
        wait: 5,
        grow: 0.5,
        workingDirectory: projectRoot
      }) as InstanceType<typeof Service>;
    }
  }

  /**
   * Install the Windows service
   */
  async install(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.service) {
        reject(new Error('node-windows not available. Install with: npm install node-windows'));
        return;
      }

      console.log(`Installing ${this.options.name}...`);
      console.log(`  Script: ${this.options.script}`);
      console.log(`  WorkDir: ${detectProjectRoot()}`);

      const timeout = setTimeout(() => {
        console.log('Install+start timeout — attempting start via sc.exe...');
        this.scStart().then(resolve).catch(reject);
      }, 30000);

      this.service.on('install', () => {
        console.log('Service installed, starting...');
        this.service!.start();
      });

      this.service.on('start', () => {
        clearTimeout(timeout);
        console.log('Service started');
        resolve();
      });

      this.service.on('alreadyinstalled', () => {
        console.log('Service already installed, starting...');
        this.service!.start();
      });

      (this.service as any).on('alreadyrunning', () => {
        clearTimeout(timeout);
        console.log('Service is already running');
        resolve();
      });

      this.service.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.service.install();
    });
  }

  /**
   * Uninstall the Windows service
   */
  async uninstall(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.service) {
        reject(new Error('node-windows not available'));
        return;
      }

      console.log(`Uninstalling ${this.options.name}...`);

      const timeout = setTimeout(() => {
        console.log('Uninstall timeout — forcing removal via sc.exe...');
        this.scDelete().then(resolve).catch(reject);
      }, 15000);

      this.service.on('uninstall', () => {
        clearTimeout(timeout);
        console.log('Service uninstalled successfully');
        resolve();
      });

      this.service.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.service.uninstall();
    });
  }

  /**
   * Start the Windows service
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.service) {
        reject(new Error('node-windows not available'));
        return;
      }

      console.log(`Starting ${this.options.name}...`);

      const timeout = setTimeout(() => {
        console.log('Start event timeout — attempting start via sc.exe...');
        this.scStart().then(resolve).catch(reject);
      }, 15000);

      this.service.on('start', () => {
        clearTimeout(timeout);
        console.log('Service started');
        resolve();
      });

      (this.service as any).on('alreadyrunning', () => {
        clearTimeout(timeout);
        console.log('Service is already running');
        resolve();
      });

      this.service.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.service.start();
    });
  }

  /**
   * Stop the Windows service
   */
  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.service) {
        reject(new Error('node-windows not available'));
        return;
      }

      console.log(`Stopping ${this.options.name}...`);

      const timeout = setTimeout(() => {
        console.log('Stop timeout — forcing stop via sc.exe...');
        this.scStop().then(resolve).catch(reject);
      }, 15000);

      this.service.on('stop', () => {
        clearTimeout(timeout);
        console.log('Service stopped');
        resolve();
      });

      this.service.on('error', (error: Error) => {
        clearTimeout(timeout);
        reject(error);
      });

      this.service.stop();
    });
  }

  /**
   * Check if running as a Windows service
   */
  static isRunningAsService(): boolean {
    // Check if running in Windows service context
    return !process.stdout.isTTY && process.platform === 'win32';
  }

  /**
   * Check if the service is installed
   */
  async isInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.service) {
        resolve(false);
        return;
      }

      const child = spawn('sc', ['query', SERVICE_KEY_NAME], { shell: false });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    });
  }

  /** Start service via sc.exe (fallback when node-windows events don't fire) */
  private scStart(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('sc', ['start', SERVICE_KEY_NAME], { shell: false });
      let output = '';
      child.stdout?.on('data', (d) => { output += String(d); });
      child.stderr?.on('data', (d) => { output += String(d); });
      child.on('close', (code) => {
        if (code === 0 || output.includes('RUNNING')) {
          console.log('Service started via sc.exe');
          resolve();
        } else {
          reject(new Error(`sc start failed (code ${code}): ${output.trim()}`));
        }
      });
      child.on('error', reject);
    });
  }

  /** Stop service via sc.exe (fallback) */
  private scStop(): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn('sc', ['stop', SERVICE_KEY_NAME], { shell: false });
      child.on('close', () => {
        console.log('Service stop sent via sc.exe');
        resolve();
      });
      child.on('error', () => resolve());
    });
  }

  /** Delete service via sc.exe (fallback) */
  private scDelete(): Promise<void> {
    return new Promise((resolve) => {
      const stopChild = spawn('sc', ['stop', SERVICE_KEY_NAME], { shell: false });
      stopChild.on('close', () => {
        setTimeout(() => {
          const delChild = spawn('sc', ['delete', SERVICE_KEY_NAME], { shell: false });
          delChild.on('close', () => {
            console.log('Service removed via sc.exe');
            resolve();
          });
          delChild.on('error', () => resolve());
        }, 2000);
      });
      stopChild.on('error', () => resolve());
    });
  }
}

/**
 * CLI for service management
 */
export async function runServiceCLI(args: string[]): Promise<void> {
  const command = args[0];
  const manager = new WindowsServiceManager();

  switch (command) {
    case 'install':
      await manager.install();
      break;
    case 'uninstall':
      await manager.uninstall();
      break;
    case 'start':
      await manager.start();
      break;
    case 'stop':
      await manager.stop();
      break;
    default:
      console.log(`
XP Thermal Service - Windows Service Manager

Usage: 
  node installer.js <command>

Commands:
  install     Install the service
  uninstall   Uninstall the service
  start       Start the service
  stop        Stop the service

Examples:
  node installer.js install
  node installer.js start
`);
  }
}

// Run CLI if executed directly
if (require.main === module) {
  runServiceCLI(process.argv.slice(2))
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Error:', error.message);
      process.exit(1);
    });
}

export default WindowsServiceManager;
