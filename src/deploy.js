import 'dotenv/config'
import { REST, Routes } from 'discord.js'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const { DISCORD_TOKEN, CLIENT_ID } = process.env

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('DISCORD_TOKEN and CLIENT_ID must be set in .env')
  process.exit(1)
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const commandsPath = join(__dirname, 'commands')

const commands = []
for (const file of readdirSync(commandsPath).filter(f => f.endsWith('.js'))) {
  const mod = await import(join(commandsPath, file))
  commands.push(mod.default.data.toJSON())
}

const rest = new REST().setToken(DISCORD_TOKEN)

try {
  console.log(`Registering ${commands.length} slash commands...`)
  const data = await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands })
  console.log(`Successfully registered ${data.length} commands.`)
} catch (err) {
  console.error(err)
  process.exit(1)
}
