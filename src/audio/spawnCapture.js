import { spawn } from 'node:child_process';

/**
 * Spawn a process and capture stdout/stderr. `spawnFn` should come from
 * the analysis queue (`spawnNice`) so MixStream underruns can SIGSTOP it.
 * `signal`, when given an already-aborted or later-aborting AbortSignal,
 * kills the process and rejects — lets a long-running spawn (e.g. Demucs)
 * actually stop when its caller's job is cancelled, instead of running to
 * completion orphaned. Time the queue keeps the process SIGSTOP'd (reported
 * via `getPausedMs`) is not charged against `timeoutMs`.
 */
export function spawnCapture(spawnFn, cmd, args, { timeoutMs = 120_000, signal, getPausedMs } = {}) {
  const run = spawnFn ?? spawn;
  if (signal?.aborted) {
    return Promise.reject(new Error(`${cmd} aborted before spawn`));
  }
  return new Promise((resolve, reject) => {
    const proc = run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error(`${cmd} aborted`));
    };
    signal?.addEventListener('abort', onAbort);
    // `getPausedMs` (from analysisQueue's job context) reports how long the
    // queue has kept this job SIGSTOP'd; that frozen time does not count
    // against the timeout, so the deadline is pushed out by it on expiry.
    const pausedAtStart = getPausedMs?.() ?? 0;
    let credited = 0;
    let timer;
    const onTimeout = () => {
      const pausedSince = (getPausedMs?.() ?? 0) - pausedAtStart;
      const extendMs = pausedSince - credited;
      if (extendMs > 0) {
        credited += extendMs;
        timer = setTimeout(onTimeout, extendMs);
        return;
      }
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    };
    timer = setTimeout(onTimeout, timeoutMs);
    proc.stdout?.on('data', (d) => { stdout += d; });
    proc.stderr?.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      cleanup();
      reject(err);
    });
    proc.on('close', (code) => {
      cleanup();
      resolve({ code, stdout, stderr });
    });
  });
}
