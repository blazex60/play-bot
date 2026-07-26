import { useEffect, useState } from 'react'

function initialGuildId() {
  const params = new URLSearchParams(window.location.search)
  return params.get('guildId') ?? window.localStorage.getItem('musicbot:guildId') ?? ''
}

/** @returns {[string, (value: string) => void]} */
export function useGuildId() {
  const [guildId, setGuildId] = useState(initialGuildId)

  useEffect(() => {
    if (!guildId) return
    window.localStorage.setItem('musicbot:guildId', guildId)
  }, [guildId])

  return [guildId, setGuildId]
}
