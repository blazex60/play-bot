import { z } from 'zod';

const OrderSchema = z.object({
  order: z.array(z.number().int().nonnegative()),
});

/** Keep under bot webClient's 5s abort so algorithm order still returns. */
export const REFINE_TIMEOUT_MS = 3_500;
/** Per-guild cooldown between paid Gemini refine attempts. */
export const REFINE_COOLDOWN_MS = 15_000;

const DEFAULT_MODEL = 'gemini-2.5-pro';

/**
 * Prompt uses only disclosed metadata: title, channel, duration.
 * Do not include BPM/key/analysis — see legal/privacy.html §5.
 */
function buildPrompt(tracks, algorithmOrder) {
  const lines = algorithmOrder.map((idx, position) => {
    const track = tracks[idx];
    const meta = [
      track?.title,
      track?.channel ? `(${track.channel})` : null,
      track?.duration ? `${Math.round(track.duration)}s` : null,
    ].filter(Boolean).join(' ');
    return `${position + 1}. [${idx}] ${meta}`;
  });
  return [
    'You reorder a DJ queue for smooth transitions in J-POP vocal mixes.',
    'Return ONLY JSON: {"order":[...]} where order is a permutation of the bracketed indices.',
    'Do NOT drop, duplicate, or invent tracks. Prefer minimal changes unless a clear improvement exists.',
    'Use title/channel/duration only; favor gradual mood flow.',
    '',
    'Algorithm proposal:',
    ...lines,
  ].join('\n');
}

/**
 * In-memory per-key gate: one in-flight refine + cooldown between starts.
 * Fail-soft callers skip Gemini and keep the algorithm order when limited.
 * @param {{ cooldownMs?: number }} [options]
 */
export function createRefineRateLimiter({ cooldownMs = REFINE_COOLDOWN_MS } = {}) {
  /** @type {Map<string, number>} */
  const lastStarted = new Map();
  /** @type {Set<string>} */
  const inFlight = new Set();

  return {
    /**
     * @param {string | null | undefined} key
     * @returns {boolean}
     */
    tryBegin(key) {
      const id = key || 'global';
      if (inFlight.has(id)) return false;
      const last = lastStarted.get(id) ?? 0;
      if (Date.now() - last < cooldownMs) return false;
      inFlight.add(id);
      lastStarted.set(id, Date.now());
      return true;
    },
    /**
     * @param {string | null | undefined} key
     */
    end(key) {
      inFlight.delete(key || 'global');
    },
  };
}

/**
 * @param {{
 *   apiKey: string,
 *   model?: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} config
 */
export function createGeminiClient({
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = REFINE_TIMEOUT_MS,
} = {}) {
  if (!apiKey) {
    return {
      async refineOrder() {
        return null;
      },
    };
  }

  async function generateJson(prompt, callTimeoutMs = timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), callTimeoutMs);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
          },
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message = payload?.error?.message ?? response.statusText;
        throw new Error(message);
      }
      const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('empty gemini response');
      return JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Optional polish pass; returns null on any failure.
     * @param {{ tracks: object[], algorithmOrder: number[], timeoutMs?: number }} args
     * @returns {Promise<number[] | null>}
     */
    async refineOrder({ tracks, algorithmOrder, timeoutMs: callTimeoutMs = timeoutMs }) {
      try {
        const prompt = buildPrompt(tracks, algorithmOrder);
        const parsed = OrderSchema.safeParse(await generateJson(prompt, callTimeoutMs));
        if (!parsed.success) return null;
        return parsed.data.order;
      } catch (err) {
        console.error('[gemini] refineOrder failed:', err.message);
        return null;
      }
    },
  };
}

export { OrderSchema, buildPrompt };
