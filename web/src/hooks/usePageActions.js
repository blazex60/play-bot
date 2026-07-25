import { useState } from 'react'
import { useApiError } from './useApiError.js'

/**
 * Shared busy/message/error-handling shape for a page's mutating actions.
 * `runAction` is intentionally generic (no forced refresh side effect) so
 * each page composes whatever follow-up (e.g. re-fetching playback state)
 * it actually needs around it.
 */
export function usePageActions() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const showError = useApiError(setMessage)

  /** @param {() => Promise<void>} work @param {string} successMessage */
  async function runAction(work, successMessage) {
    setBusy(true)
    setMessage('')
    try {
      await work()
      setMessage(successMessage)
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  return { busy, setBusy, message, setMessage, showError, runAction }
}
