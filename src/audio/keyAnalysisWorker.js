import { parentPort } from 'node:worker_threads';

function formatKey(key, scale) {
  if (!key) return null;
  const pitch = String(key).trim();
  const mode = String(scale ?? '').toLowerCase().startsWith('min') ? 'minor' : 'major';
  return `${pitch} ${mode}`;
}

parentPort.on('message', async ({ head, tail }) => {
  const empty = { headKey: null, tailKey: null, harmonicConfidence: 0 };
  try {
    const mod = await import('essentia.js');
    const Essentia = mod.Essentia;
    const EssentiaWASM = mod.EssentiaWASM;
    if (!Essentia || !EssentiaWASM) {
      parentPort.postMessage(empty);
      return;
    }
    const essentia = new Essentia(EssentiaWASM);
    const extract = (samples) => {
      if (!samples || samples.length < 44100) return { key: null, strength: 0 };
      const vec = essentia.arrayToVector(samples);
      const result = essentia.KeyExtractor(vec);
      return {
        key: formatKey(result.key, result.scale),
        strength: Number(result.strength) || 0,
      };
    };
    const headResult = extract(head);
    const tailResult = extract(tail);
    parentPort.postMessage({
      headKey: headResult.key,
      tailKey: tailResult.key,
      harmonicConfidence: Math.min(headResult.strength || 0, tailResult.strength || 0),
    });
  } catch {
    parentPort.postMessage(empty);
  }
});
