import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createLocalPlayerCli } from './cli.js';

function makeCli({ searchFn } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString(); });
  const sink = { name: 'mem', write() { return true; }, async close() {} };
  const cli = createLocalPlayerCli({ sink, decode: (p) => p, input, output, searchFn });
  return { cli, input, out: () => text };
}

const SEARCH_RESULTS = [
  { id: 'a', title: 'Track A', duration: 60, channel: 'ch1' },
  { id: 'b', title: 'Track B', duration: 120, channel: 'ch2' },
  { id: 'c', title: 'Track C', duration: 180, channel: 'ch3' },
];

async function resolvesWithin(promise, ms) {
  return Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

test('keyword-search pick answer resolves while a command is still running', async () => {
  const { cli, input, out } = makeCli({ searchFn: async () => SEARCH_RESULTS });
  const done = cli.run();
  input.write('play some song\nc\nquit\n');
  // stdin intentionally left open: the pick answer and quit must be consumed
  // while cmdPlay is still awaiting ask() — the old for-await loop deadlocked.
  assert.equal(await resolvesWithin(done, 5000), true, 'REPL did not settle');
  assert.match(out(), /番号を選択/);
  assert.match(out(), /キャンセルしました/);
  assert.doesNotMatch(out(), /不明なコマンド: c/);
});

test('stdin EOF with a pick still open cancels it and exits cleanly', async () => {
  const { cli, input, out } = makeCli({ searchFn: async () => SEARCH_RESULTS });
  const done = cli.run();
  input.write('play some song\n');
  input.end();
  assert.equal(await resolvesWithin(done, 5000), true, 'REPL did not settle');
  assert.match(out(), /番号を選択/);
  assert.match(out(), /キャンセルしました/);
});

test('commands buffered before stdin EOF still run after rl closes', async () => {
  const { cli, input, out } = makeCli();
  const done = cli.run();
  input.write('status\n');
  input.end();
  assert.equal(await resolvesWithin(done, 5000), true, 'REPL did not settle');
  // say() after rl.close() must not throw ERR_USE_AFTER_CLOSE.
  assert.match(out(), /接続: なし/);
});

test('commands run serially in input order', async () => {
  const { cli, input, out } = makeCli();
  const done = cli.run();
  input.write('bogus\nstatus\n');
  input.end();
  assert.equal(await resolvesWithin(done, 5000), true, 'REPL did not settle');
  const text = out();
  assert.ok(text.indexOf('不明なコマンド: bogus') < text.indexOf('接続:'), 'order flipped');
});

test('parseSeekArg: absolute seconds, mm:ss, hh:mm:ss, relative ±N', async () => {
  const { parseSeekArg } = await import('./cli.js');
  assert.deepEqual(parseSeekArg('90'), { sec: 90, relative: false });
  assert.deepEqual(parseSeekArg('1:30'), { sec: 90, relative: false });
  assert.deepEqual(parseSeekArg('1:02:30'), { sec: 3750, relative: false });
  assert.deepEqual(parseSeekArg('+10'), { sec: 10, relative: true });
  assert.deepEqual(parseSeekArg('-10'), { sec: -10, relative: true });
  assert.deepEqual(parseSeekArg('+1:30'), { sec: 90, relative: true });
  assert.equal(parseSeekArg('abc'), null);
  assert.equal(parseSeekArg(''), null);
  assert.equal(parseSeekArg('1:2:3:4'), null);
});

test('progressBar renders proportional fill, empty without duration', async () => {
  const { progressBar } = await import('./cli.js');
  assert.equal(progressBar(0, 60, 10), '[░░░░░░░░░░]');
  assert.equal(progressBar(30, 60, 10), '[█████░░░░░]');
  assert.equal(progressBar(60, 60, 10), '[██████████]');
  assert.equal(progressBar(120, 60, 10), '[██████████]', 'clamped at 100%');
  assert.equal(progressBar(10, null, 10), '');
});

test('seek command requires a session', async () => {
  const { cli, input, out } = makeCli();
  const done = cli.run();
  input.write('seek 30\n');
  input.end();
  assert.equal(await resolvesWithin(done, 5000), true, 'REPL did not settle');
  assert.match(out(), /再生中の曲がありません/);
});

test('seek rejects malformed arguments', async () => {
  const { cli, input, out } = makeCli();
  const done = cli.run();
  input.write('seek\n');
  input.end();
  assert.equal(await resolvesWithin(done, 5000), true, 'REPL did not settle');
  assert.match(out(), /再生中の曲がありません|使い方: seek/);
});

test('stdin EOF while a keyword search is still running cancels the pick it posts', async () => {
  let resolveSearch;
  const searchFn = () => new Promise((resolve) => { resolveSearch = resolve; });
  const { cli, input, out } = makeCli({ searchFn });
  const done = cli.run();
  input.write('play some song\n');
  input.end();
  // EOF lands before the search resolves — the pick is posted mid-drain and
  // only the drain loop can still answer it (Codex: unconditional commandChain
  // await deadlocked here).
  await new Promise((resolve) => setTimeout(resolve, 50));
  resolveSearch(SEARCH_RESULTS);
  assert.equal(await resolvesWithin(done, 5000), true, 'REPL did not settle');
  assert.match(out(), /番号を選択/);
  assert.match(out(), /キャンセルしました/);
});
