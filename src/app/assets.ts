/**
 * Static files the service needs at runtime: the dashboard, the icon, the
 * sql.js WebAssembly binary, the example config and the two Windows helpers.
 *
 * In the single-file exe they are embedded as Node SEA assets. Everywhere else
 * (`npm run dev`, tsc output, the POS's copied install) they are read from the
 * project tree, so nothing about the exe build is needed to run from source.
 */

import * as fs from 'fs';
import * as path from 'path';

interface SeaModule {
  isSea(): boolean;
  getAsset(key: string): ArrayBuffer;
}

let sea: SeaModule | null = null;
try {
  // Present from Node 20.12 / 21.7. Older runtimes simply have no SEA.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sea = require('node:sea') as SeaModule;
} catch {
  sea = null;
}

export function isSea(): boolean {
  try {
    return !!sea && sea.isSea();
  } catch {
    return false;
  }
}

export type AssetName =
  | 'dashboard.html'
  | 'icon.ico'
  | 'sql-wasm.wasm'
  | 'config.example.json'
  | 'ThermalBridgeTray.exe'
  | 'ThermalBridgeService.exe';

/** Relative locations in the repository, tried against each candidate root. */
const SOURCE_PATHS: Record<AssetName, string[]> = {
  'dashboard.html': ['public/dashboard.html'],
  'icon.ico': ['assets/icon.ico', 'public/assets/icon.ico'],
  'sql-wasm.wasm': ['node_modules/sql.js/dist/sql-wasm.wasm'],
  'config.example.json': ['config.example.json'],
  'ThermalBridgeTray.exe': ['build/helpers/ThermalBridgeTray.exe'],
  'ThermalBridgeService.exe': ['build/helpers/ThermalBridgeService.exe']
};

/**
 * Candidate roots: the working directory (flat installs), and the folders
 * above this file (dist/app → dist → repo, or src/app → src → repo).
 */
function candidateRoots(): string[] {
  return [
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '..', '..'),
    path.resolve(__dirname, '..', '..', '..')
  ];
}

/** Read an asset, or null if this build does not carry it. */
export function readAsset(name: AssetName): Buffer | null {
  if (isSea()) {
    try {
      return Buffer.from(sea!.getAsset(name));
    } catch {
      return null;
    }
  }

  for (const root of candidateRoots()) {
    for (const rel of SOURCE_PATHS[name]) {
      const file = path.join(root, rel);
      try {
        if (fs.existsSync(file)) return fs.readFileSync(file);
      } catch {
        // Unreadable candidate; try the next.
      }
    }
  }

  if (name === 'sql-wasm.wasm') {
    try {
      return fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Write an asset to disk if it is missing or different, and return its path.
 * Used for the helper executables, which Windows can only run from a file.
 */
export function extractAsset(name: AssetName, targetDir: string): string | null {
  const data = readAsset(name);
  if (!data) return null;

  const target = path.join(targetDir, name);
  try {
    const current = fs.existsSync(target) ? fs.readFileSync(target) : null;
    if (!current || !current.equals(data)) {
      fs.mkdirSync(targetDir, { recursive: true });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, data);
      fs.renameSync(tmp, target);
    }
    return target;
  } catch {
    // A running copy holds the file open; the version on disk is still usable
    // unless it never existed.
    return fs.existsSync(target) ? target : null;
  }
}
