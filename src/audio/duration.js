import { spawn } from 'node:child_process';

function spawnCapture(cmd, args, { timeoutMs = 30_000, spawnFn = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `${cmd} exited with ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * @param {string} filePath
 * @param {{ spawnFn?: Function }} [options] Codex review (PR #44, P1): an
 *   optional raw-ChildProcess-returning spawn override (e.g.
 *   analysisQueue.js's spawnNice), so this probe's ffprobe subprocess gets
 *   registered into the same queue pause/kill machinery as every other
 *   subprocess in a queued job, instead of always running untracked via the
 *   module-level spawn. Defaults to real node:child_process spawn.
 * @returns {Promise<number|null>} seconds
 */
export async function probeDurationSec(filePath, { spawnFn } = {}) {
  if (!filePath) return null;
  const stdout = await spawnCapture('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { spawnFn });
  const duration = Number(stdout.trim());
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}
