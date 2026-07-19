import { SlashCommandBuilder, MessageFlags } from 'discord.js'
import { setAutoplayMode, setPersonalize } from '../settings.js'
import { bumpPlanToken } from '../sessions.js'

const MODE_LABELS = { off: 'オフ', auto: '自動', recommend: 'おすすめ' }

export default {
  data: new SlashCommandBuilder()
    .setName('autoplay')
    .setDescription('キューが空になった時の自動再生を設定します')
    .addSubcommand((sub) =>
      sub
        .setName('mode')
        .setDescription('自動再生モードを切り替えます')
        .addStringOption((opt) =>
          opt
            .setName('value')
            .setDescription('モード')
            .setRequired(true)
            .addChoices(
              { name: 'オフ', value: 'off' },
              { name: '自動', value: 'auto' },
              { name: 'おすすめ', value: 'recommend' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('personalize')
        .setDescription('パーソナライズ機能を切り替えます')
        .addBooleanOption((opt) =>
          opt.setName('value').setDescription('パーソナライズを有効にするか').setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand()

    if (subcommand === 'mode') {
      const mode = interaction.options.getString('value', true)
      await setAutoplayMode(interaction.guildId, mode)
      // Queue-exhaustion planning already in flight read the old mode before
      // its first await; invalidate it so it can't act on a setting the user
      // just changed (e.g. finishing an "auto" pick after switching to off).
      bumpPlanToken(interaction.guildId)
      await interaction.reply({
        content: `✅ 自動再生モードを **${MODE_LABELS[mode]}** にしました`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (subcommand === 'personalize') {
      const enabled = interaction.options.getBoolean('value', true)
      await setPersonalize(interaction.guildId, enabled)
      bumpPlanToken(interaction.guildId)
      await interaction.reply({
        content: `✅ パーソナライズを **${enabled ? '有効' : '無効'}** にしました`,
        flags: MessageFlags.Ephemeral,
      })
    }
  },
}
