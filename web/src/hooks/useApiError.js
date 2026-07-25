import { useCallback } from 'react'
import { ApiError } from '../api/client.js'

/** @param {(message: string) => void} setMessage */
export function useApiError(setMessage) {
  return useCallback((/** @type {unknown} */ error) => {
    if (error instanceof ApiError && error.status === 401) {
      window.location.assign('/login')
      return
    }
    setMessage(error instanceof Error ? error.message : '操作に失敗しました')
  }, [setMessage])
}
