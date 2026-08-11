export function isMixerEnabled() {
  return process.env.MIXER_ENABLED === 'true';
}

export const MAX_UNDERRUN_MS = 8000;
