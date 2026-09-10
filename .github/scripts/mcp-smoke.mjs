// Speaks raw MCP over stdio to the globally installed binary, the same way a
// client launches it. Fails the build if the handshake or a tool call breaks.
import { spawn } from 'node:child_process';

// Defaults to the globally installed binary, which is the point of this test.
// AI_USAGE_MCP_BIN lets it be pointed at dist/mcp/server.js locally, so a tool
// added to the server can be checked here before CI is the one to notice.
const BIN = process.env.AI_USAGE_MCP_BIN ?? 'ai-usage-mcp';
const child = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
const pending = new Map();
let buf = '';
let nextId = 0;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const send = (method, params) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 60_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  child.kill();
  process.exit(1);
};

const init = await send('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'ci-smoke', version: '1.0.0' },
});
if (init.result?.serverInfo?.name !== 'ai-usage') fail('unexpected serverInfo');
console.log('initialize ok:', JSON.stringify(init.result.serverInfo));

child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

// The full tool surface, asserted exactly: an unregistered tool and an
// accidentally-registered one are both build failures.
//
// This list is deliberately independent of the server's own registration, so it
// has to be updated by hand when a tool is added. It is the THIRD place the tool
// surface is written down -- the others are the registerX calls in
// src/mcp/server.ts and the assertions in tests/mcp/server.test.ts. If you are
// adding a tool and CI failed here, that is this list doing its job.
const EXPECTED = [
  'client_usage',
  'counterfactual_cost',
  'daily_usage',
  'model_usage',
  'project_usage',
  'recent_sessions',
  'session_usage',
  'usage_summary',
];

// Tools that cannot be called with no arguments. Everything else is exercised
// below, derived from tools/list rather than a second hardcoded list, so a new
// tool gets smoke-tested without editing two places.
const NEEDS_ARGS = new Set(['session_usage']);
const list = await send('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) fail(`tools mismatch: ${names.join(', ')}`);
console.log('tools/list ok:', names.join(', '));

for (const name of names.filter((n) => !NEEDS_ARGS.has(n))) {
  const res = await send('tools/call', { name, arguments: {} });
  if (res.error) fail(`${name} returned an error: ${JSON.stringify(res.error)}`);
  if (!res.result?.content?.[0]?.text) fail(`${name} returned no text content`);
  console.log(`tools/call ${name} ok`);
}

child.kill();
console.log('MCP smoke test passed');
