/** @typedef {{ code: string, number: number, mode: 'A' | 'B' } | null} CamelotCode */

const PITCH_TO_NUMBER = {
  C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
  'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
};

/** Major/minor pitch class → Camelot code (Mixed In Key). */
const MAJOR_CAMELOT = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B'];
const MINOR_CAMELOT = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A'];

/**
 * @param {string | null | undefined} keyText e.g. "C major", "8B", "5A"
 * @returns {CamelotCode}
 */
export function parseCamelot(keyText) {
  if (!keyText || typeof keyText !== 'string') return null;
  const trimmed = keyText.trim();
  const direct = trimmed.match(/^(\d{1,2})([AB])$/i);
  if (direct) {
    const number = Number.parseInt(direct[1], 10);
    const mode = direct[2].toUpperCase();
    if (number >= 1 && number <= 12 && (mode === 'A' || mode === 'B')) {
      return { code: `${number}${mode}`, number, mode };
    }
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const pitch = parts[0].replace(/♯/g, '#').replace(/♭/g, 'b');
  const scale = parts[1].toLowerCase();
  const pitchClass = PITCH_TO_NUMBER[pitch];
  if (pitchClass == null) return null;

  if (scale.startsWith('maj')) {
    const code = MAJOR_CAMELOT[pitchClass];
    return { code, number: Number.parseInt(code, 10), mode: 'B' };
  }
  if (scale.startsWith('min')) {
    const code = MINOR_CAMELOT[pitchClass];
    return { code, number: Number.parseInt(code, 10), mode: 'A' };
  }
  return null;
}

/**
 * Camelot wheel distance (0 = same, 1 = adjacent, higher = farther).
 * @param {string | null | undefined} fromKey
 * @param {string | null | undefined} toKey
 * @returns {number | null} null when either key is unknown
 */
export function camelotDistance(fromKey, toKey) {
  const a = parseCamelot(fromKey);
  const b = parseCamelot(toKey);
  if (!a || !b) return null;

  const ring = Math.min(
    Math.abs(a.number - b.number),
    12 - Math.abs(a.number - b.number),
  );
  const modePenalty = a.mode === b.mode ? 0 : 1;
  return ring + modePenalty * 0.5;
}
