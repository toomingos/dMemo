// Shared "running setup twice is not an error" helpers.
//
// WHY THIS EXISTS. Every host CLI we drive is a package manager underneath,
// and package managers refuse to clobber something they already track:
//
//   openclaw  plugin already exists: ~/.openclaw/npm/projects/… (delete it
//             first) / Use 'openclaw plugins update …', or rerun install with
//             '--force' to replace it.
//   claude    marketplace/plugin already added or installed
//
// A non-zero exit for that reason is not a broken install — it is the host
// telling us the end state we wanted is already true. Reporting it as a
// failed step (which is what a bare try/catch does) makes `dmemo setup` look
// broken on exactly the run where nothing is wrong, and re-running setup is
// the single most common thing a user does after a partial one.
//
// So: every installer classifies its failures, and "already there" either
// short-circuits to success or retries with the host's own documented
// replace/update flag. Both halves of that live here so the classification
// cannot drift per host.

/**
 * Everything a failed child process said — message, stdout and stderr.
 *
 * `execFileSync` puts the reason on `err.stderr` and only a generic "Command
 * failed: <argv>" on `err.message`, so matching `err.message` alone misses
 * the sentence that actually names the problem.
 */
export function failureText(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);
  const e = err as { message?: unknown; stdout?: unknown; stderr?: unknown };
  return [e.message, e.stdout, e.stderr]
    .map((part) => (typeof part === 'string' ? part : Buffer.isBuffer(part) ? part.toString('utf8') : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * True when a host refused because what we are installing is already
 * installed.
 *
 * Deliberately phrase-based rather than exit-code based: none of these CLIs
 * distinguishes "already present" from "genuinely broken" by exit status, and
 * a false positive here would silently swallow a real failure. Every pattern
 * is a phrase one of the hosts actually emits — "package not found" and other
 * real failures must not match.
 */
export function alreadyInstalled(text: string): boolean {
  return /already (exists|installed|added|present|up to date)|is already|delete it first|EEXIST/i.test(
    text
  );
}
