/**
 * All of stdin, or '' when there is none to read.
 *
 * Claude Code writes the payload and closes the pipe at once. Run by hand from a
 * terminal there is no pipe, and run from something that leaves stdin open
 * without writing to it there would be nothing to wait for -- so a TTY reads
 * nothing, and a pipe that stays silent is given up on.
 */
export async function readStdin(timeoutMs = 1000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
