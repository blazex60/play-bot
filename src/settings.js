import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_SETTINGS_PATH = join(__dirname, '..', 'data', 'guild-settings.json')

let settingsPath = process.env.MUSIC_BOT_SETTINGS_FILE ?? DEFAULT_SETTINGS_PATH
let guildSettings = new Map()
let loaded = false
let writeChain = Promise.resolve()

const AUTOPLAY_MODES = new Set(['off', 'auto', 'recommend'])
const PERMISSION_VALUES = new Set(['allow', 'deny'])
const VISIBILITY_VALUES = new Set(['public', 'personal'])

function normalizeCommandPermissions(value) {
  const defaults = {}
  if (value?.defaults && typeof value.defaults === 'object') {
    for (const [command, permission] of Object.entries(value.defaults)) {
      if (PERMISSION_VALUES.has(permission)) defaults[command] = permission
    }
  }
  const overrides = {}
  if (value?.overrides && typeof value.overrides === 'object') {
    for (const [userId, commandMap] of Object.entries(value.overrides)) {
      if (!commandMap || typeof commandMap !== 'object') continue
      const normalized = {}
      for (const [command, permission] of Object.entries(commandMap)) {
        if (PERMISSION_VALUES.has(permission)) normalized[command] = permission
      }
      if (Object.keys(normalized).length > 0) overrides[userId] = normalized
    }
  }
  return { defaults, overrides }
}

function normalizeCommandVisibility(value) {
  const visibility = {}
  if (value && typeof value === 'object') {
    for (const [command, setting] of Object.entries(value)) {
      if (VISIBILITY_VALUES.has(setting)) visibility[command] = setting
    }
  }
  return visibility
}

function normalizeRecord(record) {
  return {
    normalize: record?.normalize === true,
    autoplayMode: AUTOPLAY_MODES.has(record?.autoplayMode) ? record.autoplayMode : 'off',
    personalize: record?.personalize === true,
    autoNotify: record?.autoNotify === true,
    commandPermissions: normalizeCommandPermissions(record?.commandPermissions),
    commandVisibility: normalizeCommandVisibility(record?.commandVisibility),
  }
}

function ensureLoaded() {
  if (!loaded) loadSettings()
}

export function loadSettings() {
  mkdirSync(dirname(settingsPath), { recursive: true })

  if (!existsSync(settingsPath)) {
    guildSettings = new Map()
    loaded = true
    return guildSettings
  }

  const raw = readFileSync(settingsPath, 'utf8')
  const parsed = raw.trim() ? JSON.parse(raw) : {}
  guildSettings = new Map(
    Object.entries(parsed).map(([guildId, record]) => [guildId, normalizeRecord(record)])
  )
  loaded = true
  return guildSettings
}

function defaultGuildSettings() {
  return {
    normalize: false,
    autoplayMode: 'off',
    personalize: false,
    autoNotify: false,
    commandPermissions: { defaults: {}, overrides: {} },
    commandVisibility: {},
  }
}

export function getGuildSettings(guildId) {
  ensureLoaded()
  const settings = guildSettings.get(guildId)
  return structuredClone(settings ?? defaultGuildSettings())
}

async function writeSettings() {
  await mkdir(dirname(settingsPath), { recursive: true })
  const serializable = Object.fromEntries(guildSettings)
  const tmpPath = `${settingsPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmpPath, `${JSON.stringify(serializable, null, 2)}\n`, 'utf8')
  await rename(tmpPath, settingsPath)
}

async function updateGuildSettings(guildId, patch) {
  ensureLoaded()
  guildSettings.set(guildId, { ...getGuildSettings(guildId), ...patch })
  writeChain = writeChain.then(() => writeSettings())
  await writeChain
  return getGuildSettings(guildId)
}

export function setNormalize(guildId, enabled) {
  return updateGuildSettings(guildId, { normalize: enabled === true })
}

export function setAutoplayMode(guildId, mode) {
  return updateGuildSettings(guildId, { autoplayMode: AUTOPLAY_MODES.has(mode) ? mode : 'off' })
}

export function setPersonalize(guildId, enabled) {
  return updateGuildSettings(guildId, { personalize: enabled === true })
}

export function setAutoNotify(guildId, enabled) {
  return updateGuildSettings(guildId, { autoNotify: enabled === true })
}

export function getCommandPermissions(guildId) {
  return getGuildSettings(guildId).commandPermissions
}

export function setDefaultCommandPermission(guildId, commandName, value) {
  if (!PERMISSION_VALUES.has(value)) throw new Error(`Invalid command permission: ${value}`)
  const commandPermissions = getCommandPermissions(guildId)
  commandPermissions.defaults[commandName] = value
  return updateGuildSettings(guildId, { commandPermissions })
}

export function setUserCommandPermission(guildId, userId, commandName, value) {
  if (value !== null && !PERMISSION_VALUES.has(value)) throw new Error(`Invalid command permission: ${value}`)
  const commandPermissions = getCommandPermissions(guildId)
  const userOverrides = commandPermissions.overrides[userId] ?? {}
  if (value === null) {
    delete userOverrides[commandName]
  } else {
    userOverrides[commandName] = value
  }
  if (Object.keys(userOverrides).length > 0) {
    commandPermissions.overrides[userId] = userOverrides
  } else {
    delete commandPermissions.overrides[userId]
  }
  return updateGuildSettings(guildId, { commandPermissions })
}

export function resolveCommandPermission(guildId, userId, commandName) {
  const { defaults, overrides } = getCommandPermissions(guildId)
  return overrides[userId]?.[commandName] ?? defaults[commandName] ?? 'allow'
}

export function getCommandVisibilitySettings(guildId) {
  return getGuildSettings(guildId).commandVisibility
}

export function setCommandVisibility(guildId, commandName, value) {
  if (!VISIBILITY_VALUES.has(value)) throw new Error(`Invalid command visibility: ${value}`)
  const commandVisibility = getCommandVisibilitySettings(guildId)
  commandVisibility[commandName] = value
  return updateGuildSettings(guildId, { commandVisibility })
}

/** Returns the current settings file path so tests can restore shared state. */
export function getSettingsPathForTest() {
  return settingsPath
}

export function configureSettingsPathForTest(filePath) {
  settingsPath = filePath
  guildSettings = new Map()
  loaded = false
  writeChain = Promise.resolve()
}
