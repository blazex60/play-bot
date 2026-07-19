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

function normalizeRecord(record) {
  return {
    normalize: record?.normalize === true,
    autoplayMode: AUTOPLAY_MODES.has(record?.autoplayMode) ? record.autoplayMode : 'off',
    personalize: record?.personalize === true,
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

export function getGuildSettings(guildId) {
  ensureLoaded()
  const settings = guildSettings.get(guildId)
  return settings ? { ...settings } : { normalize: false, autoplayMode: 'off', personalize: false }
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

export function configureSettingsPathForTest(filePath) {
  settingsPath = filePath
  guildSettings = new Map()
  loaded = false
  writeChain = Promise.resolve()
}
