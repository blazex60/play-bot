import { SlashCommandBuilder, PermissionFlagsBits, InteractionContextType, MessageFlags } from 'discord.js'
import { getAdminRoleId, setAdminRoleId, resolveAdminRoleId } from '../settings.js'

export default {
  data: new SlashCommandBuilder()
    .setName('adminrole')
    .setDescription('Webダッシュボードの管理者権限を持つロールをこのサーバー専用に設定します')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand(sub =>
      sub
        .setName('set')
        .setDescription('管理者ロールをこのサーバー専用に設定します')
        .addRoleOption(opt => opt.setName('role').setDescription('管理者として扱うロール').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('clear').setDescription('このサーバー専用の管理者ロール設定を解除します')
    )
    .addSubcommand(sub =>
      sub.setName('show').setDescription('現在の管理者ロール設定を表示します')
    ),

  // Always ephemeral: this command is excluded from the reply-visibility
  // matrix (see MATRIX_EXCLUDED_COMMANDS) because exposing admin-role
  // changes publicly would leak privileged configuration.
  async execute(interaction, sessions) {
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({ content: '❌ このコマンドは管理者権限が必要です', flags: MessageFlags.Ephemeral })
      return false
    }

    const subcommand = interaction.options.getSubcommand()

    if (subcommand === 'set') {
      const role = interaction.options.getRole('role', true)
      await setAdminRoleId(interaction.guildId, role.id)
      await interaction.reply({
        content: `✅ 管理者ロールを <@&${role.id}> に設定しました`,
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    if (subcommand === 'clear') {
      await setAdminRoleId(interaction.guildId, null)
      const fallbackRoleId = resolveAdminRoleId(interaction.guildId)
      const content = fallbackRoleId
        ? `✅ このサーバー専用の管理者ロール設定を解除しました（環境変数のデフォルト <@&${fallbackRoleId}> にフォールバックします）`
        : '✅ このサーバー専用の管理者ロール設定を解除しました（環境変数のデフォルトも未設定のため管理者ロールは未設定になります）'
      await interaction.reply({ content, flags: MessageFlags.Ephemeral })
      return
    }

    // show
    const effectiveRoleId = resolveAdminRoleId(interaction.guildId)
    let source
    if (getAdminRoleId(interaction.guildId)) {
      source = 'このサーバー専用設定'
    } else if (process.env.ADMIN_ROLE_ID) {
      source = '環境変数のデフォルト'
    } else {
      source = '未設定'
    }
    const content = effectiveRoleId
      ? `現在の管理者ロール: <@&${effectiveRoleId}>（${source}）`
      : `現在の管理者ロール: 未設定（${source}）`
    await interaction.reply({ content, flags: MessageFlags.Ephemeral })
  },
}
