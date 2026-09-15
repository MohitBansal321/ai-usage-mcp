import { describe, expect, it } from 'vitest';
import { normaliseProjectPath } from '../../src/models/usage-record.js';

/**
 * The rule has to be identical on every platform, because a database written on
 * one machine may be read on another. So none of this is conditioned on
 * `process.platform`, and these assertions hold on Windows, Linux and macOS
 * alike.
 */
describe('normaliseProjectPath', () => {
  it('uppercases the drive letter of a Windows absolute path', () => {
    expect(normaliseProjectPath('d:\\repo')).toBe('D:\\repo');
    expect(normaliseProjectPath('c:/Users/me/repo')).toBe('C:/Users/me/repo');
  });

  it('preserves the case of everything after the drive letter', () => {
    // Windows is case-INSENSITIVE but case-PRESERVING: the recorded spelling is
    // what the user sees in their own shell, so only the drive letter is touched.
    expect(normaliseProjectPath('d:\\Prep-Refresh\\dsa-patterns')).toBe(
      'D:\\Prep-Refresh\\dsa-patterns',
    );
    expect(normaliseProjectPath('d:\\AskAide AI')).toBe('D:\\AskAide AI');
  });

  it('is idempotent, so re-running it can never drift', () => {
    const once = normaliseProjectPath('d:\\repo');
    expect(normaliseProjectPath(once)).toBe(once);
    expect(normaliseProjectPath('D:\\repo')).toBe('D:\\repo');
  });

  /**
   * The assertion that matters most. POSIX filesystems are case-SENSITIVE, so
   * `/home/x` and `/home/X` are genuinely different directories. Folding case
   * there would merge two real projects into one and invent a number -- the exact
   * failure this change exists to remove, reintroduced in the other direction.
   */
  it('never touches a POSIX path, in either case', () => {
    for (const p of [
      '/home/user/repo',
      '/home/User/Repo',
      '/Users/me/src/project',
      '/var/tmp/x',
      '/',
    ]) {
      expect(normaliseProjectPath(p)).toBe(p);
    }
    // Two POSIX paths differing only by case must stay distinct.
    expect(normaliseProjectPath('/home/x')).not.toBe(normaliseProjectPath('/home/X'));
  });

  it('leaves anything that is not a Windows absolute path alone', () => {
    for (const p of [
      'relative/path',
      './x',
      '../x',
      'd:relative-to-drive', // no separator: not an absolute path
      '\\\\server\\share', // UNC: no drive letter to normalise
      '(unknown)',
      '',
    ]) {
      expect(normaliseProjectPath(p)).toBe(p);
    }
  });
});
