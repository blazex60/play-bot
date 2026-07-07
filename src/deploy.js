import 'dotenv/config'
import { REST, Routes } from 'discord.js'
import { readdirSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { DISCORD_TOKEN, CLIENT_ID } = process.env

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be set in .env')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsPath = join(__dirname, 'commands')
const commandHashPath = process.env.MUSIC_BOT_COMMAND_HASH_FILE ?? join(__dirname, '..', 'data', 'slash-command-hash.json')
const skipIfUnchanged = process.argv.includes('--if-changed')

const commands = []
for (const file of readdirSync(commandsPath).filter(f => f.endsWith('.js')).sort()) {
  const mod = await import(join(commandsPath, file))
  commands.push(mod.default.data.toJSON())
}

function commandHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

async function readPreviousHash() {
  try {
    const raw = await readFile(commandHashPath, 'utf8')
    return JSON.parse(raw).hash ?? null
  } catch (err) {
    if (err.code === 'ENOENT') return null
    if (err instanceof SyntaxError) {
      console.warn(`Ignoring invalid command hash file: ${commandHashPath}`)
      return null
    }
    throw err
  }
}

async function writeCurrentHash(hash) {
  await mkdir(dirname(commandHashPath), { recursive: true })
  await writeFile(commandHashPath, `${JSON.stringify({ hash }, null, 2)}\n`, 'utf8')
}

const rest = new REST().setToken(DISCORD_TOKEN)

try {
  const hash = commandHash(commands)
  if (skipIfUnchanged) {
    const previousHash = await readPreviousHash()
    if (previousHash === hash) {
      console.log(`Slash commands unchanged (${commands.length} commands); skipping registration.`)
      process.exit(0)
    }
  }

  console.log(`Registering ${commands.length} slash commands...`)
  const data = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands })
  await writeCurrentHash(hash)
  console.log(`Successfully registered ${data.length} commands.`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
