import {
  checkForUpdate,
  formatUpdateNotice,
  readCachedUpdate,
  type UpdateInfo,
} from '../services/update-check.js';
import { VERSION } from '../version.js';

/**
 * Telling an MCP user that their install is stale.
 *
 * stdout is the JSON-RPC transport, so the server cannot print; stderr reaches a
 * log file nobody opens; and MCP has no notification a client is obliged to show
 * a person. That leaves two channels that pass through the model: the
 * `instructions` returned by the handshake, and the text of a tool result.
 *
 * Both are used, and at most one of them fires per process:
 *
 *   - `initUpdateNotice()` reads the cache synchronously while `instructions`
 *     are still being built. No network, no added handshake latency, and the
 *     model knows before the first tool call. Empty on a first ever run.
 *   - `startUpdateWatch()` runs the real check after the transport is connected,
 *     and arms a one-shot trailer on the next tool result -- but only if the
 *     handshake did not already say it.
 *
 * One line, once. A server that repeats itself on every tool call is adware, and
 * the trailer is a separate content block so the data block stays byte-identical
 * to what the CLI prints for the same query.
 */

let pending: string | null = null;
let announced = false;

/** Records a notice for the next tool result, unless it has already been said. */
export function armUpdateNotice(info: UpdateInfo | null): void {
  if (!info?.isOutdated || announced) return;
  announced = true;
  pending = formatUpdateNotice(info);
  // stderr as well as the model-facing channel: it costs nothing, and it gives a
  // bug report something to point at.
  process.stderr.write(`${pending}\n`);
}

/**
 * The notice, if one is waiting -- and never again after that.
 *
 * Called on the tool result path, so it must stay synchronous and cheap.
 */
export function takeUpdateNotice(): string | null {
  const notice = pending;
  pending = null;
  return notice;
}

/**
 * The sentence to fold into the server's `instructions`, or null.
 *
 * Marks the notice as said: the trailer will not repeat it later in the session.
 */
export function initUpdateNotice(current: string = VERSION): string | null {
  const info = readCachedUpdate({ current });
  if (!info?.isOutdated) return null;
  const notice = formatUpdateNotice(info);
  process.stderr.write(`${notice}\n`);
  announced = true;
  return notice;
}

/**
 * Checks the registry in the background and arms the trailer.
 *
 * Call after `server.connect()`: nothing here may sit on the handshake or on a
 * tool response. A failure is not worth reporting -- an unknown version is the
 * same as no notice.
 */
export function startUpdateWatch(
  check: typeof checkForUpdate = checkForUpdate,
  current: string = VERSION,
): Promise<void> {
  return check({ current }).then(armUpdateNotice, () => {});
}

/** Tests only: the module-level state is per process by design. */
export function resetUpdateNotice(): void {
  pending = null;
  announced = false;
}
