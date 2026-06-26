import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

export function createSearchResultComponents(results) {
  const items = results.slice(0, 5);
  const buttons = items.map((entry, i) => {
    const title = entry.title || `結果 ${i + 1}`;
    return new ButtonBuilder()
      .setCustomId(`search_${i}`)
      .setLabel(title.slice(0, 80))
      .setStyle(ButtonStyle.Primary);
  });

  const rows = [];
  if (buttons.length <= 3) {
    rows.push(new ActionRowBuilder().addComponents(...buttons));
  } else {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 3)));
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(3)));
  }
  return rows;
}

export function parseSearchCustomId(customId) {
  const match = customId.match(/^search_(\d+)$/);
  if (!match) return null;
  const index = parseInt(match[1], 10);
  if (isNaN(index) || index < 0 || index > 4) return null;
  return index;
}

export class SearchPendingStore {
  #map = new Map();

  set(messageId, results, onSelect) {
    this.#map.set(messageId, { results, onSelect });
  }

  get(messageId) {
    return this.#map.get(messageId) ?? null;
  }

  delete(messageId) {
    this.#map.delete(messageId);
  }
}
