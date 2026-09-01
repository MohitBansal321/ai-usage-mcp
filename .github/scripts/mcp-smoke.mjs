// Speaks raw MCP over stdio to the globally installed binary, the same way a
// client launches it. Fails the build if the handshake or a tool call breaks.
import { spawn } from 'node:child_process';

const child = spawn('ai-usage-mcp', [], { stdio: ['pipe', 'pipe', 'inherit'], shell: true });
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

const EXPECTED = [
  'client_usage',
  'model_usage',
  'project_usage',
  'recent_sessions',
  'session_usage',
  'usage_summary',
];
const list = await send('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name).sort();
if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) fail(`tools mismatch: ${names.join(', ')}`);
console.log('tools/list ok:', names.join(', '));

for (const name of [
  'usage_summary',
  'client_usage',
  'model_usage',
  'project_usage',
  'recent_sessions',
]) {
  const res = await send('tools/call', { name, arguments: {} });
  if (res.error) fail(`${name} returned an error: ${JSON.stringify(res.error)}`);
  if (!res.result?.content?.[0]?.text) fail(`${name} returned no text content`);
  console.log(`tools/call ${name} ok`);
}

child.kill();
console.log('MCP smoke test passed');
