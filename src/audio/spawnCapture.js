import { spawn } from 'node:child_process';

/**
 * Spawn a process and capture stdout/stderr. `spawnFn` should come from
 * the analysis queue (`spawnNice`) so MixStream underruns can SIGSTOP it.
 */
export function spawnCapture(spawnFn, cmd, args, { timeoutMs = 120_000 } = {}) {
  const run = spawnFn ?? spawn;
  return new Promise((resolve, reject) => {
    const proc = run(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout?.on('data', (d) => { stdout += d; });
    proc.stderr?.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
