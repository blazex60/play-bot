import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const MAX_CHOICES = 5;

export function buildChoiceComponents(items, { prefix, getLabel = (item, i) => item.title || `結果 ${i + 1}` }) {
  const capped = items.slice(0, MAX_CHOICES);
  const buttons = capped.map((item, i) =>
    new ButtonBuilder()
      .setCustomId(`${prefix}_${i}`)
      .setLabel(getLabel(item, i).slice(0, 80))
      .setStyle(ButtonStyle.Primary)
  );

  const rows = [];
  if (buttons.length <= 3) {
    rows.push(new ActionRowBuilder().addComponents(...buttons));
  } else {
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(0, 3)));
    rows.push(new ActionRowBuilder().addComponents(...buttons.slice(3)));
  }
  return rows;
}

export function parseChoiceCustomId(customId, prefix) {
  const match = customId.match(new RegExp(`^${prefix}_(\\d+)$`));
  if (!match) return null;
  const index = parseInt(match[1], 10);
  if (isNaN(index) || index < 0 || index >= MAX_CHOICES) return null;
  return index;
}

export function createSearchResultComponents(results) {
  return buildChoiceComponents(results, { prefix: 'search' });
}

export function parseSearchCustomId(customId) {
  return parseChoiceCustomId(customId, 'search');
}

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
