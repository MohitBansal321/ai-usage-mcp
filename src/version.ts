import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads the version from package.json at runtime.
 *
 * Deliberately not a hardcoded constant: a literal here silently goes stale the
 * first time `npm version` bumps the package, and the MCP handshake would then
 * advertise a version that does not exist.
 */
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.version && pkg.name === 'ai-usage-mcp') return pkg.version;
    } catch {
      /* keep walking up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0-unknown';
}

export const VERSION = readVersion();
