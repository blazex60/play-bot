import { spawn } from 'node:child_process';

/**
 * Spawn a process and capture stdout/stderr. `spawnFn` should come from
 * the analysis queue (`spawnNice`) so MixStream underruns can SIGSTOP it.
 * `signal`, when given an already-aborted or later-aborting AbortSignal,
 * kills the process and rejects — lets a long-running spawn (e.g. Demucs)
 * actually stop when its caller's job is cancelled, instead of running to
 * completion orphaned.
 */
export function spawnCapture(spawnFn, cmd, args, { timeoutMs = 120_000, signal } = {}) {
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
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      cleanup();
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
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
