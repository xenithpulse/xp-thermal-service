#!/usr/bin/env node
/**
 * XP Thermal Service CLI
 * Command-line interface for service management
 */

import { Command } from 'commander';
import * as readline from 'readline';
import { WindowsServiceManager } from './service/installer';
import { ThermalPrintService } from './index';

// API Response types
interface HealthResponse {
  uptime: number;
  printers: { online: number; total: number };
  queue: { pending: number; processing: number };
}

interface PrintResultResponse {
  data: { jobId: string };
}

interface PrinterInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  isOnline: boolean;
  totalJobsPrinted: number;
}

interface PrintersResponse {
  data: PrinterInfo[];
}

const program = new Command();

program
  .name('xp-thermal')
  .description('XP Thermal Print Service CLI')
  .version('1.0.0');

// Run command - starts the service in foreground
program
  .command('run')
  .description('Run the service in foreground (development mode)')
  .option('-c, --config <path>', 'Path to configuration file')
  .action(async (options) => {
    console.log('Starting XP Thermal Service in foreground mode...');
    console.log('Press Ctrl+C to stop.\n');

    const service = new ThermalPrintService(options.config);

    const shutdown = async () => {
      console.log('\nShutting down...');
      await service.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await service.start();
    } catch (error) {
      console.error('Failed to start:', error);
      process.exit(1);
    }
  });

// Install command
program
  .command('install')
  .description('Install as Windows service')
  .option('-c, --config <path>', 'Path to configuration file')
  .action(async (options) => {
    console.log('Installing XP Thermal Service...');

    const manager = new WindowsServiceManager({
      name: 'XPThermalService',
      description: 'XP Thermal Print Service',
      script: __filename,
      env: options.config ? [{ name: 'XP_CONFIG_PATH', value: options.config }] : []
    });

    try {
      await manager.install();
      console.log('Service installed successfully!');
      console.log('The service will start automatically on system boot.');
    } catch (error) {
      console.error('Installation failed:', error);
      process.exit(1);
    }
  });

// Uninstall command
program
  .command('uninstall')
  .description('Uninstall Windows service')
  .action(async () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const confirm = await new Promise<string>((resolve) => {
      rl.question('Are you sure you want to uninstall? (y/N): ', resolve);
    });
    rl.close();

    if (confirm.toLowerCase() !== 'y') {
      console.log('Cancelled.');
      return;
    }

    console.log('Uninstalling XP Thermal Service...');

    const manager = new WindowsServiceManager({
      name: 'XPThermalService',
      description: 'XP Thermal Print Service',
      script: __filename
    });

    try {
      await manager.uninstall();
      console.log('Service uninstalled successfully!');
    } catch (error) {
      console.error('Uninstallation failed:', error);
      process.exit(1);
    }
  });

// Start command
program
  .command('start')
  .description('Start the Windows service')
  .action(async () => {
    console.log('Starting XP Thermal Service...');

    const manager = new WindowsServiceManager({
      name: 'XPThermalService',
      description: 'XP Thermal Print Service',
      script: __filename
    });

    try {
      await manager.start();
      console.log('Service started.');
    } catch (error) {
      console.error('Failed to start:', error);
      process.exit(1);
    }
  });

// Stop command
program
  .command('stop')
  .description('Stop the Windows service')
  .action(async () => {
    console.log('Stopping XP Thermal Service...');

    const manager = new WindowsServiceManager({
      name: 'XPThermalService',
      description: 'XP Thermal Print Service',
      script: __filename
    });

    try {
      await manager.stop();
      console.log('Service stopped.');
    } catch (error) {
      console.error('Failed to stop:', error);
      process.exit(1);
    }
  });

// Status command
program
  .command('status')
  .description('Check service status')
  .action(async () => {
    const manager = new WindowsServiceManager({
      name: 'XPThermalService',
      description: 'XP Thermal Print Service',
      script: __filename
    });

    const exists = await manager.isInstalled();
    
    if (!exists) {
      console.log('Status: NOT INSTALLED');
      return;
    }

    // Check if running by trying to connect to the API
    try {
      const response = await fetch('http://127.0.0.1:9100/api/health', {
        signal: AbortSignal.timeout(2000)
      });
      
      if (response.ok) {
        const data = await response.json() as HealthResponse;
        console.log('Status: RUNNING');
        console.log(`Uptime: ${formatUptime(data.uptime)}`);
        console.log(`Printers: ${data.printers.online}/${data.printers.total} online`);
        console.log(`Queue: ${data.queue.pending} pending, ${data.queue.processing} processing`);
      } else {
        console.log('Status: INSTALLED (not responding)');
      }
    } catch {
      console.log('Status: INSTALLED (not running or not responding)');
    }
  });

// Test print command
program
  .command('test-print')
  .description('Send a test print job')
  .option('-p, --printer <id>', 'Printer ID (defaults to first available)')
  .action(async (options) => {
    console.log('Sending test print...');

    try {
      const response = await fetch('http://127.0.0.1:9100/api/print', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: 'test',
          printerId: options.printer,
          priority: 10,
          data: {
            message: 'Manual test print from CLI',
            timestamp: new Date().toISOString()
          }
        }),
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        const errorData = await response.json() as { message?: string };
        throw new Error(errorData.message || 'Request failed');
      }

      const result = await response.json() as PrintResultResponse;
      console.log(`Test print queued. Job ID: ${result.data.jobId}`);
      console.log('Check printer for output.');
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.name === 'AbortError' || err.code === 'ECONNREFUSED') {
        console.error('Error: Cannot connect to service. Is it running?');
      } else {
        console.error('Error:', err.message);
      }
      process.exit(1);
    }
  });

// List printers command
program
  .command('printers')
  .description('List configured printers')
  .action(async () => {
    try {
      const response = await fetch('http://127.0.0.1:9100/api/printers', {
        signal: AbortSignal.timeout(2000)
      });

      if (!response.ok) {
        throw new Error('Failed to get printers');
      }

      const result = await response.json() as PrintersResponse;
      const printers = result.data;

      if (printers.length === 0) {
        console.log('No printers configured.');
        return;
      }

      console.log('\nConfigured Printers:');
      console.log('-------------------');
      
      for (const printer of printers) {
        const statusIcon = printer.isOnline ? '✓' : '✗';
        const statusColor = printer.isOnline ? '\x1b[32m' : '\x1b[31m';
        console.log(`${statusColor}${statusIcon}\x1b[0m ${printer.id}`);
        console.log(`   Name: ${printer.name}`);
        console.log(`   Type: ${printer.type}`);
        console.log(`   Status: ${printer.status}`);
        console.log(`   Jobs Printed: ${printer.totalJobsPrinted}`);
        console.log('');
      }
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'ECONNREFUSED') {
        console.error('Error: Cannot connect to service. Is it running?');
      } else {
        console.error('Error:', err.message);
      }
      process.exit(1);
    }
  });

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

program.parse();
