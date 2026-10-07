import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SEARCH_TIMEOUT_MS,
  buildSearchQuery,
  clampTargetCount,
  defaultPlaylistName,
  generatePlaylistFromPrompt,
  resolveGeneratedTracks,
} from './playlistGenerate.js';

test('buildSearchQuery combines title and artist', () => {
  assert.equal(buildSearchQuery({ title: '夜に駆ける', artist: 'YOASOBI' }), '夜に駆ける YOASOBI');
  assert.equal(buildSearchQuery({ title: '  Solo  ' }), 'Solo');
  assert.equal(buildSearchQuery({ title: '' }), null);
});

test('clampTargetCount bounds 3..25', () => {
  assert.equal(clampTargetCount(1), 3);
  assert.equal(clampTargetCount(10), 10);
  assert.equal(clampTargetCount(99), 25);
});

test('defaultPlaylistName truncates long prompts', () => {
  const long = 'あ'.repeat(60);
  assert.equal(defaultPlaylistName(long).length, 48);
});

test('resolveGeneratedTracks skips misses and dedupes videoId', async () => {
  const tracks = await resolveGeneratedTracks({
    suggestions: [
      { title: 'A' },
      { title: 'B' },
      { title: 'A-dup' },
    ],
    searchYoutubeFn: async (query) => [{ id: query === 'A' ? 'vid-a' : 'vid-b', title: query }],
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.title, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    requestedBy: 'tester',
  });
  assert.equal(tracks.length, 2);
  assert.deepEqual(tracks.map((t) => t.videoId), ['vid-a', 'vid-b']);
});

test('resolveGeneratedTracks passes a per-search timeout to searchYoutubeFn', async () => {
  let options;
  await resolveGeneratedTracks({
    suggestions: [{ title: 'A' }],
    searchYoutubeFn: async (_query, opts) => {
      options = opts;
      return [{ id: 'a', title: 'A' }];
    },
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.title, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    requestedBy: 'tester',
  });
  assert.equal(options.timeoutMs, SEARCH_TIMEOUT_MS);
});

test('resolveGeneratedTracks skips a search that rejects on timeout', async () => {
  const tracks = await resolveGeneratedTracks({
    suggestions: [{ title: 'slow' }, { title: 'fast' }],
    searchYoutubeFn: async (query) => {
      if (query === 'slow') {
        const err = new Error('yt-dlp timed out after 12ms');
        throw err;
      }
      return [{ id: 'fast', title: query }];
    },
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.title, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    requestedBy: 'tester',
  });
  assert.deepEqual(tracks.map((t) => t.videoId), ['fast']);
});

test('generatePlaylistFromPrompt retries when too few tracks resolve', async () => {
  let calls = 0;
  const result = await generatePlaylistFromPrompt({
    prompt: '夏っぽいJ-POP',
    targetCount: 4,
    gemini: {
      async generateTrackList({ excludeTitles }) {
        calls += 1;
        if (excludeTitles.length === 0) {
          return {
            playlistName: 'Summer MIX',
            tracks: [
              { title: 'miss-1' },
              { title: 'miss-2' },
              { title: 'hit' },
            ],
          };
        }
        return {
          tracks: [
            { title: 'hit' },
            { title: 'hit-2' },
          ],
        };
      },
    },
    searchYoutubeFn: async (query) => (query.startsWith('hit') ? [{ id: query }] : []),
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.id, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    optimizeTrackOrderFn: ({ tracks }) => tracks.map((_, i) => i),
    probeTempoBackendFn: async () => null,
    requestedBy: 'tester',
  });

  assert.equal(calls, 2);
  assert.ok(result);
  assert.equal(result.playlistName, 'Summer MIX');
  assert.equal(result.tracks.length, 2);
});

test('generatePlaylistFromPrompt keeps first-attempt hits and retries below full count', async () => {
  let calls = 0;
  const result = await generatePlaylistFromPrompt({
    prompt: '夜ドライブ',
    targetCount: 4,
    gemini: {
      async generateTrackList({ excludeTitles }) {
        calls += 1;
        if (excludeTitles.length === 0) {
          return {
            playlistName: 'Night Drive',
            tracks: [{ title: 'keep-a' }, { title: 'miss-a' }],
          };
        }
        return {
          tracks: [{ title: 'keep-b' }, { title: 'keep-c' }],
        };
      },
    },
    searchYoutubeFn: async (query) => (query.startsWith('keep') ? [{ id: query }] : []),
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.id, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    optimizeTrackOrderFn: ({ tracks }) => tracks.map((_, i) => i),
    probeTempoBackendFn: async () => null,
    requestedBy: 'tester',
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.tracks.map((t) => t.videoId), ['keep-a', 'keep-b', 'keep-c']);
});

test('generatePlaylistFromPrompt retries even when the 50% floor is already met', async () => {
  let calls = 0;
  const result = await generatePlaylistFromPrompt({
    prompt: 'full count',
    targetCount: 4,
    gemini: {
      async generateTrackList() {
        calls += 1;
        return {
          tracks: calls === 1
            ? [{ title: 'a' }, { title: 'b' }]
            : [{ title: 'c' }, { title: 'd' }],
        };
      },
    },
    searchYoutubeFn: async (query) => [{ id: query }],
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.id, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    optimizeTrackOrderFn: ({ tracks }) => tracks.map((_, i) => i),
    probeTempoBackendFn: async () => null,
    requestedBy: 'tester',
  });

  assert.equal(calls, 2);
  assert.equal(result.tracks.length, 4);
});

test('generatePlaylistFromPrompt probes the tempo backend once and passes it to optimizeTrackOrderFn', async () => {
  // Codex round-6 on PR #35: ordering's beatmix term can only gate on
  // tempo-filter availability if callers actually probe and pass it
  // through — this verifies generatePlaylistFromPrompt does its part.
  let probeCalls = 0;
  let receivedTempoBackend;
  const result = await generatePlaylistFromPrompt({
    prompt: 'probe check',
    targetCount: 3,
    gemini: {
      async generateTrackList() {
        return { tracks: [{ title: 'x' }, { title: 'y' }, { title: 'z' }] };
      },
    },
    searchYoutubeFn: async (query) => [{ id: query }],
    resolveYoutubeTrackFn: (entry) => ({
      status: 'matched',
      track: { title: entry.id, videoId: entry.id, webpageUrl: `https://youtu.be/${entry.id}` },
    }),
    optimizeTrackOrderFn: ({ tracks, tempoBackend }) => {
      receivedTempoBackend = tempoBackend;
      return tracks.map((_, i) => i);
    },
    probeTempoBackendFn: async () => {
      probeCalls += 1;
      return 'atempo';
    },
    requestedBy: 'tester',
  });

  assert.ok(result);
  assert.equal(probeCalls, 1, 'expected the tempo backend to be probed exactly once per generation call');
  assert.equal(receivedTempoBackend, 'atempo', 'expected the probed backend to reach optimizeTrackOrderFn');
});
