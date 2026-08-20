import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { FRAME_BYTES, FRAME_MS } from './fade.js';
import { MixStream } from './mixStream.js';
import { PcmSource } from './pcmSource.js';
import { MAX_UNDERRUN_MS } from './config.js';

function silence(bytes) {
  return Buffer.alloc(bytes);
}

function collectFrames(stream, count) {
  return new Promise((resolve, reject) => {
    const frames = [];
    const onData = (chunk) => {
      frames.push(chunk);
      if (frames.length >= count) {
        stream.off('data', onData);
        resolve(frames);
      }
    };
    stream.on('data', onData);
    stream.on('error', reject);
    stream.on('end', () => {
      stream.off('data', onData);
      resolve(frames);
    });
  });
}

function pcmView(chunk) {
  return new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2));
}

function pcmContains(chunks, value) {
  for (const chunk of chunks) {
    const view = pcmView(chunk);
    for (let i = 0; i < view.length; i++) {
      if (view[i] === value) return true;
    }
  }
  return false;
}

function previewFrameSamples(chunks, max = 8) {
  const out = [];
  const step = FRAME_BYTES / 2;
  for (const chunk of chunks) {
    const view = pcmView(chunk);
    for (let i = 0; i < view.length && out.length < max; i += step) {
      out.push(view[i]);
    }
    if (out.length >= max) break;
  }
  return out;
}

async function waitForPcm(chunks, value, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!pcmContains(chunks, value) && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function fillFrame(value) {
  const buf = Buffer.alloc(FRAME_BYTES);
  pcmView(buf).fill(value);
  return buf;
}

test('MixStream pushes gapless frames from a PCM source', async () => {
  const mix = new MixStream();
  try {
    const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 3)]);
    mix.setCurrent(source);

    const frames = await collectFrames(mix, 3);
    assert.equal(frames.length, 3);
    assert.equal(frames[0].length, FRAME_BYTES);
  } finally {
    mix.endMixer();
  }
});

test('MixStream emits trackend when the current source ends', async () => {
  const mix = new MixStream();
  try {
    const source = PcmSource.fromBuffers([silence(FRAME_BYTES)]);
    let ended = false;
    mix.on('trackend', () => { ended = true; });
    mix.setCurrent(source);

    await collectFrames(mix, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ended, true);
  } finally {
    mix.endMixer();
  }
});

test('MixStream dropCurrent emits trackend immediately', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 10)]);
  let ended = false;
  mix.on('trackend', () => { ended = true; });
  mix.setCurrent(source);
  mix.dropCurrent();
  assert.equal(ended, true);
  mix.endMixer();
});

test('MixStream pushes silence between tracks so the player is not starved', async () => {
  const mix = new MixStream();
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES)]);
  mix.setCurrent(source);

  // Use paused reads (like @discordjs/voice) — flowing 'data' mode would
  // spin forever on continuous between-track silence.
  const first = await new Promise((resolve) => {
    const tryRead = () => {
      const chunk = mix.read(FRAME_BYTES);
      if (chunk) return resolve(chunk);
      setImmediate(tryRead);
    };
    tryRead();
  });
  assert.equal(first.length, FRAME_BYTES);

  await new Promise(resolve => setImmediate(resolve));

  let silenceFrames = 0;
  for (let i = 0; i < 20 && silenceFrames < 3; i++) {
    const chunk = mix.read(FRAME_BYTES);
    if (chunk) silenceFrames += 1;
    else await new Promise(resolve => setTimeout(resolve, FRAME_MS));
  }
  assert.ok(silenceFrames >= 3, 'expected silence frames during between-tracks handoff');
  mix.endMixer();
});

test('MixStream.isDestroyed is true after endMixer', () => {
  const mix = new MixStream();
  assert.equal(mix.isDestroyed(), false);
  mix.endMixer();
  assert.equal(mix.isDestroyed(), true);
});

test('MixStream reports playback position in seconds', async () => {
  const mix = new MixStream();
  try {
    const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 5)]);
    mix.setCurrent(source);
    await collectFrames(mix, 2);
    assert.ok(mix.positionSec > 0);
  } finally {
    mix.endMixer();
  }
});

test('MixStream waiting for the first source does not fire the underrun watchdog', async () => {
  // createAudioResource(StreamType.Raw) used to pipeline MixStream before
  // GuildPlayer.setCurrent. Keep-alive silence must not count as an underrun:
  // after MAX_UNDERRUN_MS that used to emit sourceerror and race the real PCM.
  const mix = new MixStream();
  const errors = [];
  mix.on('sourceerror', (err) => errors.push(err.message));

  const sink = new PassThrough();
  sink.resume();
  mix.pipe(sink);

  try {
    await new Promise((resolve) => setImmediate(resolve));
    const start = Date.now();
    const originalNow = Date.now;
    Date.now = () => start + MAX_UNDERRUN_MS + 1_000;
    try {
      mix.read();
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      Date.now = originalNow;
    }

    assert.deepEqual(errors, []);
  } finally {
    mix.unpipe(sink);
    mix.endMixer();
  }
});

test('MixStream keep-alive before setCurrent never starves a 20 ms reader', async () => {
  // @discordjs/voice AudioPlayer pulls every 20 ms. Five consecutive null
  // reads (default maxMissedFrames) stop() the player and destroy MixStream.
  const mix = new MixStream();
  try {
    let consecutiveMisses = 0;
    let maxMisses = 0;
    let hits = 0;
    const deadline = Date.now() + 140;
    while (Date.now() < deadline) {
      const chunk = mix.read(FRAME_BYTES);
      if (chunk && chunk.length) {
        hits += 1;
        consecutiveMisses = 0;
      } else {
        consecutiveMisses += 1;
        if (consecutiveMisses > maxMisses) maxMisses = consecutiveMisses;
      }
      await new Promise((resolve) => setTimeout(resolve, FRAME_MS));
    }
    assert.ok(hits >= 4, `expected keep-alive frames, got ${hits}`);
    assert.ok(
      maxMisses < 5,
      `AudioPlayer would destroy MixStream after 5 missed frames; max streak was ${maxMisses}`,
    );
  } finally {
    mix.endMixer();
  }
});

test('MixStream delivers PCM after keep-alive silence while the decoder is late', async () => {
  const mix = new MixStream();
  const sink = new PassThrough();
  const received = [];
  sink.on('data', (chunk) => received.push(Buffer.from(chunk)));
  mix.pipe(sink);

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    mix.setCurrent(PcmSource.fromBuffers([fillFrame(3456), fillFrame(3456)]));
    await waitForPcm(received, 3456);
    assert.ok(pcmContains(received, 3456), `expected real PCM after keep-alive, got ${previewFrameSamples(received)}`);
  } finally {
    mix.unpipe(sink);
    mix.endMixer();
  }
});

test('MixStream delivers PCM after a flowing consumer attaches before setCurrent', async () => {
  const mix = new MixStream();
  const sink = new PassThrough();
  const received = [];
  sink.on('data', (chunk) => received.push(Buffer.from(chunk)));
  mix.pipe(sink);

  try {
    await new Promise((resolve) => setImmediate(resolve));

    mix.setCurrent(PcmSource.fromBuffers([fillFrame(1234), fillFrame(1234)]));

    // fromBuffers appends in a microtask, so MixStream may emit a brief
    // silence frame first (same as production waiting on ffmpeg). Pipe
    // backpressure can also coalesce later PCM into a chunk that does not
    // start with the tone — scan the whole buffer rather than sample[0].
    await waitForPcm(received, 1234);
    assert.ok(pcmContains(received, 1234), `expected real PCM after leading silence, got ${previewFrameSamples(received)}`);
  } finally {
    mix.unpipe(sink);
    mix.endMixer();
  }
});

test('MixStream setCurrent after a flowing between-tracks gap delivers the next track', async () => {
  const mix = new MixStream();
  const sink = new PassThrough();
  const received = [];
  sink.on('data', (chunk) => received.push(Buffer.from(chunk)));
  mix.pipe(sink);

  try {
    const ended = new Promise((resolve) => mix.once('trackend', resolve));
    mix.setCurrent(PcmSource.fromBuffers([fillFrame(111)]));
    await ended;

    mix.setCurrent(PcmSource.fromBuffers([fillFrame(2222), fillFrame(2222)]));
    await waitForPcm(received, 2222);
    assert.ok(pcmContains(received, 2222), `expected next-track PCM after the flowing gap, got ${previewFrameSamples(received)}`);
  } finally {
    mix.unpipe(sink);
    mix.endMixer();
  }
});

test('MixStream paces flowing between-track silence in real time', async () => {
  const mix = new MixStream();
  const frameTimes = [];
  mix.on('data', () => frameTimes.push(Date.now()));

  try {
    mix.dropCurrent();
    const deadline = Date.now() + 500;
    while (frameTimes.length < 4 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    assert.equal(frameTimes.length >= 4, true, 'expected four keep-alive frames');
    assert.ok(frameTimes[3] - frameTimes[0] >= 45,
      `four 20 ms frames were emitted too quickly: ${frameTimes[3] - frameTimes[0]}ms`);
  } finally {
    mix.endMixer();
  }
});

test('MixStream does not override downstream backpressure for between-track silence', async () => {
  const mix = new MixStream();
  let releaseWrite;
  const blocked = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      releaseWrite = callback;
    },
  });
  mix.pipe(blocked);

  try {
    mix.dropCurrent();
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.ok(blocked.writableLength <= FRAME_BYTES,
      `backpressured sink buffered ${blocked.writableLength} bytes of silence`);
    // At most one frame per 20 ms may accumulate while the sink is blocked;
    // allow one scheduling frame of jitter on top of the five due in 100 ms.
    assert.ok(mix.readableLength <= FRAME_BYTES * 6,
      `mixer buffered ${mix.readableLength} bytes of silence`);
  } finally {
    mix.unpipe(blocked);
    releaseWrite?.();
    blocked.destroy();
    mix.endMixer();
  }
});

test('MixStream emits underrunClear only after recovering from underrun', async () => {
  const mix = new MixStream();
  let clears = 0;
  mix.on('underrunClear', () => { clears += 1; });
  const source = PcmSource.fromBuffers([silence(FRAME_BYTES * 3)]);
  mix.setCurrent(source);
  await collectFrames(mix, 3);
  assert.equal(clears, 0, 'healthy frames must not clear another guild underrun');
  mix.endMixer();
});

// --- Phase 8 (docs/mix-transition-phase8.md): startStemCrossfade() -------

function stemSource(value, frames) {
  return PcmSource.fromBuffers(Array.from({ length: frames }, () => fillFrame(value)));
}

function makeStemPlan(fadeSec, overrides = {}) {
  return {
    fadeSec,
    curve: 'equal-power',
    baseSwap: false,
    mode: 'stem-mix',
    stems: {
      outVocal: { role: 'out', fadeSec, curve: 'equal-power', startOffsetSec: 0 },
      outInstrumental: { role: 'out', fadeSec, curve: 'equal-power', startOffsetSec: 0 },
      inInstrumental: { role: 'in', fadeSec, curve: 'equal-power', startOffsetSec: 0 },
      inVocal: { role: 'in', fadeSec, curve: 'equal-power', startOffsetSec: 0 },
      ...overrides,
    },
  };
}

test('MixStream startStemCrossfade mixes 4 stems then promotes to the incoming full-mix source', async () => {
  const mix = new MixStream();
  try {
    mix.setCurrent(stemSource(1000, 50), { durationSec: 60 });
    await new Promise((resolve) => setImmediate(resolve));

    // A couple of spare frames past fadeSec's exact frame count absorb the
    // usual +-1-frame float accumulation on `#fadeElapsedSec += 0.02` (the
    // same imprecision the plain crossfade path already has) without
    // pinning the test to an exact tick count.
    const fadeFrames = 10; // 0.2s at 20ms/frame
    const outgoing = { vocal: stemSource(2000, fadeFrames + 2), instrumental: stemSource(3000, fadeFrames + 2) };
    const incoming = {
      vocal: stemSource(4000, fadeFrames + 2),
      instrumental: stemSource(5000, fadeFrames + 2),
      full: stemSource(6000, 30), // survives past promotion
    };
    const plan = makeStemPlan(0.2);

    const ok = mix.startStemCrossfade({ outgoing, incoming }, plan);
    assert.equal(ok, true);
    assert.equal(mix.isCrossfading, true);

    // Snapshot state SYNCHRONOUSLY inside the promoted-trackend listener,
    // at the exact instant #current has just been switched to `next` —
    // asserting after `await` would race a LATER, unrelated event (this
    // synthetic fixture's incoming.full has few enough frames that a
    // flowing consumer can drain it to EOF, triggering #finishCurrent()'s
    // own plain trackend that nulls #current again, within the same
    // microtask burst as promotion, before the `await` below resumes).
    let sawCorrectPromotion = false;
    const promotedPromise = new Promise((resolve) => {
      mix.on('trackend', (info) => {
        if (info?.promoted) {
          sawCorrectPromotion = mix.isCrossfading === false && mix.currentSource === incoming.full;
          resolve();
        }
      });
    });
    mix.on('data', () => {}); // keep the stream flowing so ticks actually happen
    await promotedPromise;

    assert.equal(sawCorrectPromotion, true, 'expected #current to be exactly incoming.full immediately upon promotion');
  } finally {
    mix.endMixer();
  }
});

test('MixStream startStemCrossfade catches up incoming.full\'s read deficit before promotion', async () => {
  // Codex: #readExact(this.#incoming, ...) is a best-effort, non-blocking
  // drain each tick — if incoming.full's decoder isn't ready yet (spawn
  // startup latency), that tick's read is simply skipped while the stem
  // mix itself still advances fadeElapsedSec. Without a catch-up drain
  // right before promotion, incoming.full would permanently lag by
  // however many ticks it missed, replaying already-elapsed content once
  // promoted to #current.
  const mix = new MixStream();
  try {
    mix.setCurrent(stemSource(1000, 50), { durationSec: 60 });
    await new Promise((resolve) => setImmediate(resolve));

    const fadeFrames = 10; // 0.2s at 20ms/frame
    const outgoing = { vocal: stemSource(2000, fadeFrames + 2), instrumental: stemSource(3000, fadeFrames + 2) };

    // Simulates incoming.full not having buffered anything for its first 3
    // reads (same "not ready yet" shape #readExact() already tolerates for
    // any source — null, not ended), then serving normally.
    const readyAfterReads = 3;
    const totalFrames = 30; // finite, like test #13's stemSource(6000, 30) — must
    // eventually end so a tight synchronous push loop after promotion (this
    // fake, unlike a real PcmSource, has no I/O latency of its own) doesn't
    // spin forever instead of yielding back to the microtask queue.
    let readCount = 0;
    let served = 0;
    const fullSource = new EventEmitter();
    fullSource.ended = false;
    fullSource.error = null;
    fullSource.destroy = () => { fullSource.removeAllListeners(); fullSource.ended = true; };
    fullSource.read = () => {
      readCount += 1;
      if (readCount <= readyAfterReads) return null;
      if (served >= totalFrames) {
        fullSource.ended = true;
        return null;
      }
      served += 1;
      return fillFrame(6000);
    };

    const incoming = {
      vocal: stemSource(4000, fadeFrames + 2),
      instrumental: stemSource(5000, fadeFrames + 2),
      full: fullSource,
    };
    const plan = makeStemPlan(0.2);

    const ok = mix.startStemCrossfade({ outgoing, incoming }, plan);
    assert.equal(ok, true);

    let servedAtPromotion = null;
    const promotedPromise = new Promise((resolve) => {
      mix.on('trackend', (info) => {
        if (info?.promoted) {
          servedAtPromotion = served;
          resolve();
        }
      });
    });
    mix.on('data', () => {});
    await promotedPromise;

    // NOT Math.ceil(0.2/(FRAME_MS/1000)) (10): #fadeElapsedSec is
    // accumulated via repeated += FRAME_MS/1000, so exactly which tick it
    // first reaches fadeSec on is itself subject to float rounding — it
    // actually crosses 0.2 on tick 11 here, one past the "ideal" division's
    // result (the same reason the catch-up target compares against a live
    // tick count, not a fadeSec-derived constant — see mixStream.js). 11 is
    // the real, deterministic tick count for this exact fixture, confirmed
    // by running it; the invariant under test — zero deficit at promotion —
    // holds regardless of which tick that turns out to be.
    assert.equal(servedAtPromotion, 11,
      `expected the catch-up drain to have read all frames from incoming.full by the real promotion tick, got ${servedAtPromotion}`);
  } finally {
    mix.endMixer();
  }
});

test('MixStream startStemCrossfade catch-up target uses ceil, not round, for a non-frame-aligned fadeSec', async () => {
  // CodeRabbit: fadeSec (bar-duration derived, e.g. 4 bars at 123 BPM =
  // ~7.805s) is rarely an exact multiple of FRAME_MS — #fadeElapsedSec
  // only crosses it on the ceil()'th tick, not the round()'th. Using
  // Math.round() for the catch-up target could satisfy it ONE tick before
  // that real last tick, so a miss on that final tick would look
  // "already caught up" while incoming.full is actually still one frame
  // short at promotion — reproduced here at a fast timescale: fadeSec =
  // 0.204s → fadeSec/FRAME_SEC = 10.2, round() = 10 (buggy), ceil() = 11
  // (correct).
  const mix = new MixStream();
  try {
    mix.setCurrent(stemSource(1000, 50), { durationSec: 60 });
    await new Promise((resolve) => setImmediate(resolve));

    const fadeSec = 0.204;
    const fadeFrames = 13; // comfortably more than the 11 real ticks needed
    const outgoing = { vocal: stemSource(2000, fadeFrames), instrumental: stemSource(3000, fadeFrames) };

    // Misses exactly once, right as the 11th frame would be served —
    // simulating a transient stall on the specific tick that crosses
    // fadeSec — then recovers on retry (the catch-up loop's own re-read).
    let served = 0;
    let missedOnce = false;
    const totalFrames = 30;
    const fullSource = new EventEmitter();
    fullSource.ended = false;
    fullSource.error = null;
    fullSource.destroy = () => { fullSource.removeAllListeners(); fullSource.ended = true; };
    fullSource.read = () => {
      if (served === 10 && !missedOnce) {
        missedOnce = true;
        return null;
      }
      if (served >= totalFrames) {
        fullSource.ended = true;
        return null;
      }
      served += 1;
      return fillFrame(6000);
    };

    const incoming = {
      vocal: stemSource(4000, fadeFrames),
      instrumental: stemSource(5000, fadeFrames),
      full: fullSource,
    };
    const plan = makeStemPlan(fadeSec);

    const ok = mix.startStemCrossfade({ outgoing, incoming }, plan);
    assert.equal(ok, true);

    let servedAtPromotion = null;
    const promotedPromise = new Promise((resolve) => {
      mix.on('trackend', (info) => {
        if (info?.promoted) {
          servedAtPromotion = served;
          resolve();
        }
      });
    });
    mix.on('data', () => {});
    await promotedPromise;

    const expectedFrames = Math.ceil(fadeSec / (FRAME_MS / 1000));
    assert.equal(expectedFrames, 11, 'sanity check on the test fixture\'s own arithmetic');
    assert.equal(servedAtPromotion, expectedFrames,
      `expected the catch-up loop to have drained the frame missed right at the fadeSec boundary (${expectedFrames}), got ${servedAtPromotion}`);
  } finally {
    mix.endMixer();
  }
});

test('MixStream startStemCrossfade catch-up target grows across multiple held ticks (Codex: fixed target masks a hold-tick deficit)', async () => {
  // Codex, after the earlier Math.ceil fix: every tick spent HOLDING (this
  // very branch, waiting for incoming.full to catch up) is itself one more
  // real tick whose own #incoming frame the catch-up target must also cover
  // — a target derived once from fadeSec (a constant) doesn't grow across
  // those extra hold ticks, so a deficit that survives exactly one hold tick
  // can get satisfied one real frame short, replaying ~20ms of already-heard
  // audio right after promotion. Scripted call-by-call so the exact point of
  // divergence between the old fixed target (would promote after 10 reads,
  // with 11 real ticks elapsed) and the fix (correctly holds for a 12th
  // tick, promoting only once reads == ticks elapsed) is unambiguous.
  const mix = new MixStream();
  try {
    mix.setCurrent(stemSource(1000, 50), { durationSec: 60 });
    await new Promise((resolve) => setImmediate(resolve));

    const fadeFrames = 20;
    const outgoing = { vocal: stemSource(2000, fadeFrames), instrumental: stemSource(3000, fadeFrames) };

    // calls 1-3: not ready yet (spawn latency, as in the sibling test).
    // calls 4-9: serve normally (6 successes).
    // call 10 (tick 10's top-of-function read, crossing the fadeSec=0.2s
    // threshold): serves (7th success).
    // call 11 (tick 10's 1st catch-up attempt): serves (8th success).
    // call 12 (tick 10's 2nd catch-up attempt): misses — tick 10 ends on
    // hold with 8 real frames served for 10 ticks elapsed (both the old
    // fixed target=10 and the live target=10 agree here: still short).
    // call 13 (tick 11's top-of-function read): serves (9th success).
    // call 14 (tick 11's 1st catch-up attempt): serves (10th success) — the
    // OLD fixed target (10) would already be satisfied here and promote,
    // even though tick 11 (not tick 10) is the one in progress: only 10
    // real frames for 11 real ticks elapsed, a 1-frame deficit.
    // call 15 (tick 11's 2nd catch-up attempt, only reached by the FIX
    // since its live target is now 11, not 10): misses — tick 11 also ends
    // on hold, correctly, since 10 < 11.
    // calls 16+: serve normally, closing the gap for good at tick 12 (12
    // real frames for 12 real ticks elapsed — zero deficit).
    const script = [null, null, null, 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'ok', null];
    let served = 0;
    let callIndex = 0;
    const totalFrames = 40;
    const fullSource = new EventEmitter();
    fullSource.ended = false;
    fullSource.error = null;
    fullSource.destroy = () => { fullSource.removeAllListeners(); fullSource.ended = true; };
    fullSource.read = () => {
      const outcome = callIndex < script.length ? script[callIndex] : 'ok';
      callIndex += 1;
      if (outcome === null) return null;
      if (served >= totalFrames) {
        fullSource.ended = true;
        return null;
      }
      served += 1;
      return fillFrame(6000);
    };

    const incoming = {
      vocal: stemSource(4000, fadeFrames),
      instrumental: stemSource(5000, fadeFrames),
      full: fullSource,
    };
    const plan = makeStemPlan(0.2);

    const ok = mix.startStemCrossfade({ outgoing, incoming }, plan);
    assert.equal(ok, true);

    let servedAtPromotion = null;
    const promotedPromise = new Promise((resolve) => {
      mix.on('trackend', (info) => {
        if (info?.promoted) {
          servedAtPromotion = served;
          resolve();
        }
      });
    });
    mix.on('data', () => {});
    await promotedPromise;

    // Correct (fixed) result: promotion waits for the 12th real tick, by
    // which point exactly 12 real frames have been served — no deficit. The
    // old, now-fixed code would have promoted one tick earlier with only 10
    // frames served (a 1-frame / ~20ms repeat at promotion).
    assert.equal(servedAtPromotion, 12,
      `expected promotion to wait until incoming.full's read count caught up to the real elapsed tick count (12), got ${servedAtPromotion}`);
  } finally {
    mix.endMixer();
  }
});

test('MixStream startStemCrossfade: inVocal contributes nothing before its own startOffsetSec (delayed-envelope wiring)', async () => {
  // The core Phase 8 correctness property: during the window before inVocal
  // starts fading in, its underlying PCM content must have ZERO effect on
  // the mixed output — proving the per-stem gain envelope (not just the
  // outer crossfade envelope) actually gates it.
  async function firstMixedFrame(inVocalValue) {
    const mix = new MixStream();
    try {
      mix.setCurrent(stemSource(1000, 50), { durationSec: 60 });
      await new Promise((resolve) => setImmediate(resolve));
      const fadeFrames = 10;
      const outgoing = { vocal: stemSource(2000, fadeFrames), instrumental: stemSource(3000, fadeFrames) };
      const incoming = {
        vocal: stemSource(inVocalValue, fadeFrames),
        instrumental: stemSource(5000, fadeFrames),
        full: stemSource(6000, fadeFrames),
      };
      // inVocal starts fading in only after the whole 0.2s window (never
      // actually starts within the captured frames).
      const plan = makeStemPlan(0.2, {
        inVocal: { role: 'in', fadeSec: 0, curve: 'equal-power', startOffsetSec: 0.2 },
      });
      mix.startStemCrossfade({ outgoing, incoming }, plan);
      const [frame] = await collectFrames(mix, 1);
      return frame;
    } finally {
      mix.endMixer();
    }
  }

  const withLowInVocal = await firstMixedFrame(-32000);
  const withHighInVocal = await firstMixedFrame(32000);
  // Fail loudly if the captured frame was underrun silence rather than a
  // real mix — otherwise the deepEqual below would pass vacuously (both
  // sides all-zero regardless of whether the envelope wiring is correct).
  assert.ok(pcmView(withLowInVocal).some((s) => s !== 0),
    'expected a real mixed frame, not underrun silence');
  assert.deepEqual(withLowInVocal, withHighInVocal,
    'expected wildly different inVocal content to produce an IDENTICAL first frame, since inVocal gain is still 0 there');
});

test('MixStream startStemCrossfade substitutes silence for a stem that ends early instead of aborting the transition', async () => {
  const mix = new MixStream();
  try {
    mix.setCurrent(stemSource(1000, 50), { durationSec: 60 });
    await new Promise((resolve) => setImmediate(resolve));

    const fadeFrames = 10;
    // outVocal only has 2 frames of real content -- the remaining 8 ticks
    // must fall back to silence for that slot, not stall/abort the mix.
    const outgoing = { vocal: stemSource(2000, 2), instrumental: stemSource(3000, fadeFrames) };
    const incoming = {
      vocal: stemSource(4000, fadeFrames),
      instrumental: stemSource(5000, fadeFrames),
      full: stemSource(6000, fadeFrames),
    };
    const plan = makeStemPlan(0.2);
    mix.startStemCrossfade({ outgoing, incoming }, plan);

    let promoted = false;
    mix.on('trackend', (info) => { if (info?.promoted) promoted = true; });
    const frames = await collectFrames(mix, fadeFrames);
    assert.equal(frames.length, fadeFrames, 'expected the transition to run to completion despite the early-ending stem');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promoted, true);
  } finally {
    mix.endMixer();
  }
});

test('MixStream startStemCrossfade promotes instead of hanging when incoming.full ends before catching up', async () => {
  // Regression: #stemCrossfadeTicks (the live catch-up target, growing on
  // every tick spent holding for a deficit) can never be satisfied by a
  // #incoming that has already reached EOF — a genuinely short/exhausted
  // source can't be drained faster than it has frames. Without a guard, the
  // hold loops forever: each hold tick is itself a "processed tick" (the 4
  // stem sources keep producing silence-substituted frames once THEY end
  // too, per the sibling "substitutes silence" test), which spins the
  // synchronous internal push loop indefinitely and never yields back to
  // the event loop — this reproduces as a hang, not a rejected assertion,
  // caught only by giving this test a chance to actually finish.
  const mix = new MixStream();
  try {
    mix.setCurrent(stemSource(1000, 50), { durationSec: 60 });
    await new Promise((resolve) => setImmediate(resolve));

    const fadeFrames = 10; // 0.2s at 20ms/frame
    const outgoing = { vocal: stemSource(2000, fadeFrames), instrumental: stemSource(3000, fadeFrames) };
    const incoming = {
      vocal: stemSource(4000, fadeFrames),
      instrumental: stemSource(5000, fadeFrames),
      full: stemSource(6000, 5), // ends well before the 10-tick window does
    };
    const plan = makeStemPlan(0.2);
    mix.startStemCrossfade({ outgoing, incoming }, plan);

    let promoted = false;
    mix.on('trackend', (info) => { if (info?.promoted) promoted = true; });
    // Not hanging (collectFrames() resolving at all) IS the regression test
    // — a bounded frame count just gives it something to await.
    const frames = await collectFrames(mix, fadeFrames);
    assert.ok(frames.length > 0, 'expected the mix to keep producing frames instead of hanging');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promoted, true, 'expected promotion to proceed once incoming.full ends, rather than holding on an unreachable target');
  } finally {
    mix.endMixer();
  }
});

test('MixStream startStemCrossfade rejects and destroys every source when one already carries an error', async () => {
  const mix = new MixStream();
  try {
    mix.setCurrent(stemSource(1000, 5), { durationSec: 60 });
    await new Promise((resolve) => setImmediate(resolve));

    // PcmSource.error is a read-only getter (backed by a real internal
    // #fail() state machine) — a plain fake object stands in here, matching
    // phase2.test.js's createPendingSource() convention for pre-armed error
    // state.
    const failed = new EventEmitter();
    failed.ended = false;
    failed.error = new Error('boom');
    failed.read = () => null;
    failed.destroy = () => { failed.removeAllListeners(); failed.ended = true; };
    const destroyed = [];
    const wrap = (source, label) => {
      const originalDestroy = source.destroy.bind(source);
      source.destroy = () => { destroyed.push(label); originalDestroy(); };
      return source;
    };
    const outgoing = {
      vocal: wrap(stemSource(2000, 1), 'outVocal'),
      instrumental: wrap(stemSource(3000, 1), 'outInstrumental'),
    };
    const incoming = {
      vocal: wrap(failed, 'inVocal'),
      instrumental: wrap(stemSource(5000, 1), 'inInstrumental'),
      full: wrap(stemSource(6000, 1), 'full'),
    };

    const ok = mix.startStemCrossfade({ outgoing, incoming }, makeStemPlan(0.2));
    assert.equal(ok, false);
    assert.equal(mix.isCrossfading, false);
    assert.deepEqual(
      destroyed.sort(),
      ['full', 'inInstrumental', 'inVocal', 'outInstrumental', 'outVocal'],
      'expected every one of the 5 sources to be destroyed on rejection',
    );
  } finally {
    mix.endMixer();
  }
});
