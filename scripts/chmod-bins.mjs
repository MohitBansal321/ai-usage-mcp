import { chmodSync, existsSync } from 'node:fs';
for (const f of ['dist/mcp/server.js', 'dist/cli/index.js']) {
  if (existsSync(f)) chmodSync(f, 0o755);
}
