/**
 * Windows Service Wrapper
 * Allows the print service to run as a Windows service
 */

import * as path from 'path';

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
    this.options = {
      name: options.name || SERVICE_NAME,
      description: options.description || SERVICE_DESCRIPTION,
      script: options.script || path.join(__dirname, '..', 'index.js'),
      env: options.env || []
    };

    if (Service) {
      const projectRoot = path.resolve(__dirname, '..', '..');

      this.service = new Service({
        name: this.options.name!,
        description: this.options.description,
        script: this.options.script!,
        env: this.options.env,
        // Service configuration
        nodeOptions: ['--max-old-space-size=256'],
        // Restart on failure
        maxRestarts: 3,
        wait: 2,
        grow: 0.5,
        // Ensure the service runs from the project root so relative paths work
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

      this.service.on('install', () => {
        console.log('Service installed successfully');
        // Start the service after installation
        this.service!.start();
        resolve();
      });

      this.service.on('alreadyinstalled', () => {
        console.log('Service is already installed');
        resolve();
      });

      this.service.on('error', (error: Error) => {
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

      this.service.on('uninstall', () => {
        console.log('Service uninstalled successfully');
        resolve();
      });

      this.service.on('error', (error: Error) => {
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

      this.service.on('start', () => {
        console.log('Service started');
        resolve();
      });

      this.service.on('error', (error: Error) => {
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

      this.service.on('stop', () => {
        console.log('Service stopped');
        resolve();
      });

      this.service.on('error', (error: Error) => {
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

      // Use spawn instead of exec to prevent command injection
      const { spawn } = require('child_process');
      const child = spawn('sc', ['query', this.options.name!], { shell: false });
      child.on('close', (code: number) => resolve(code === 0));
      child.on('error', () => resolve(false));
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
