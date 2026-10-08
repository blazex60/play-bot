// Message-id-keyed store for still-answerable choice prompts (search results,
// per-user recommendation picks). Generic over the entry shape — the Discord
// adapter and the playback session hub both use it, so it lives in shared/
// rather than in a Discord-specific module.
export class PendingChoiceStore {
  #map = new Map();

  set(messageId, entry) {
    this.#map.set(messageId, entry);
  }

  get(messageId) {
    return this.#map.get(messageId) ?? null;
  }

  delete(messageId) {
    this.#map.delete(messageId);
  }

  entries() {
    return this.#map.entries();
  }
}
