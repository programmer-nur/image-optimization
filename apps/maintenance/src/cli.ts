/**
 * Command-line entry point for reclamation.
 *
 * Run as a scheduled container on the control-plane host rather than as a Lambda, for
 * the reasons in `handler.ts`. That change is what makes the exit code and the lock
 * below matter: a Lambda invocation is tracked by the platform, a cron job is not.
 */

import { closeSync, openSync, unlinkSync, readFileSync, writeSync } from 'node:fs';
import { runMaintenance, shutdown, logger } from './handler.js';

/**
 * Where the run lock lives.
 *
 * Overridable so the container can point it at a volume shared across runs — the
 * default is per-container and would make the lock a no-op under Docker.
 */
const LOCK_PATH = process.env['MAINTENANCE_LOCK_PATH'] ?? '/tmp/imgopt-maintenance.lock';

/**
 * Refuses to start while another run holds the lock.
 *
 * A full pass walks the whole bucket and can outlast its own interval on a large
 * deployment. Two overlapping runs would each delete up to `MAX_DELETIONS_PER_RUN`,
 * which is the number that exists specifically to bound how much one mistake can
 * destroy — so the cap has to be per *wall-clock window*, not per process.
 *
 * `wx` is the whole mechanism: an atomic create-if-absent, so two containers starting
 * in the same second cannot both win. A stale lock from a killed run is detected by
 * age rather than by checking a pid, because the pid in the file belongs to a
 * different container's namespace and is meaningless here.
 */
function acquireLock(staleAfterMs: number): boolean {
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    // The acquisition time, which is what the staleness check below reads back.
    writeSync(fd, String(Date.now()));
    closeSync(fd);
    return true;
  } catch (error) {
    /*
     * "Cannot write here" is not "someone else is running".
     *
     * Conflating them is how reclamation stops forever without anyone noticing: an
     * unwritable lock directory — a root-owned Docker volume under an unprivileged
     * container, say — makes every run report "already in progress" and exit 0. The
     * schedule keeps firing, the log keeps looking calm, and nothing is ever
     * reclaimed. Thrown rather than returned, so the run exits non-zero.
     */
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined && code !== 'EEXIST') {
      throw new Error(
        `Cannot write the reclamation lock at ${LOCK_PATH} (${code}). This is a ` +
          'permissions or path problem, not a concurrent run — refusing to treat it ' +
          'as one, because that would silently stop reclamation.',
      );
    }

    // Held. Break it only if it is old enough that the holder cannot still be running.
    try {
      const age = Date.now() - Number(readFileSync(LOCK_PATH, 'utf8').trim() || 0);
      if (Number.isFinite(age) && age > staleAfterMs) {
        unlinkSync(LOCK_PATH);
        return acquireLock(staleAfterMs);
      }
    } catch {
      // Vanished between the failed create and the read — another run finished. Retry
      // once; a second failure means someone else took it, which is the correct answer.
      try {
        const fd = openSync(LOCK_PATH, 'wx');
        writeSync(fd, String(Date.now()));
        closeSync(fd);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

function releaseLock(): void {
  try {
    unlinkSync(LOCK_PATH);
  } catch {
    // Already gone. Nothing to do, and nothing worth failing the run over.
  }
}

async function main(): Promise<void> {
  // Two hours: comfortably longer than a full pass, short enough that a container
  // killed mid-run does not block reclamation for a day.
  if (!acquireLock(2 * 60 * 60 * 1000)) {
    logger.warn({ lock: LOCK_PATH }, 'a reclamation run is already in progress; skipping');
    return;
  }

  try {
    const report = await runMaintenance();
    logger.info({ report }, 'reclamation complete');
  } finally {
    releaseLock();
    await shutdown();
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'reclamation failed');
  // Non-zero so a supervisor, a cron mail, or a CI step notices. Reclamation failing
  // silently is how a deployment discovers months later that nothing was ever cleaned.
  process.exitCode = 1;
});
