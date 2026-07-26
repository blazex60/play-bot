import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api/client.js', () => ({
  api: {
    mySavedPlaylists: vi.fn(),
    createSavedPlaylist: vi.fn(),
    savedPlaylist: vi.fn(),
    renameSavedPlaylist: vi.fn(),
    deleteSavedPlaylist: vi.fn(),
    addSavedPlaylistTrack: vi.fn(),
    searchSavedPlaylistTrack: vi.fn(),
    removeSavedPlaylistTrack: vi.fn(),
    moveSavedPlaylistTrack: vi.fn(),
    queueSavedPlaylist: vi.fn(),
  },
}))

import { api } from '../api/client.js'
import { usePageActions } from './usePageActions.js'
import { useSavedPlaylists } from './useSavedPlaylists.js'

function renderSavedPlaylists() {
  return renderHook(() => {
    const pageActions = usePageActions()
    const savedPlaylists = useSavedPlaylists({ guildId: 'g1', runAction: pageActions.runAction })
    return { pageActions, savedPlaylists }
  })
}

describe('useSavedPlaylists — refresh-after-mutation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('reports the create mutation as successful even when the follow-up refresh fails', async () => {
    vi.mocked(api.createSavedPlaylist).mockResolvedValue({ id: 1 })
    vi.mocked(api.mySavedPlaylists).mockRejectedValue(new Error('network down'))

    const { result } = renderSavedPlaylists()

    act(() => {
      result.current.savedPlaylists.actions.onNewPlaylistNameChange('My Mix')
    })
    await act(async () => {
      await result.current.savedPlaylists.actions.onCreate()
    })

    expect(api.createSavedPlaylist).toHaveBeenCalledWith('My Mix')
    expect(result.current.pageActions.message).toBe('プレイリストを作成しました')
    expect(console.error).toHaveBeenCalled()
  })

  it('still applies the refreshed list when the follow-up refresh succeeds', async () => {
    vi.mocked(api.createSavedPlaylist).mockResolvedValue({ id: 1 })
    vi.mocked(api.mySavedPlaylists).mockResolvedValue({ playlists: [{ id: 1, name: 'My Mix' }] })

    const { result } = renderSavedPlaylists()

    act(() => {
      result.current.savedPlaylists.actions.onNewPlaylistNameChange('My Mix')
    })
    await act(async () => {
      await result.current.savedPlaylists.actions.onCreate()
    })

    expect(result.current.pageActions.message).toBe('プレイリストを作成しました')
    expect(result.current.savedPlaylists.state.playlists).toEqual([{ id: 1, name: 'My Mix' }])
  })

  it('reports the delete mutation as successful even when the follow-up refresh fails', async () => {
    vi.mocked(api.savedPlaylist).mockResolvedValue({ id: 1, name: 'My Mix', tracks: [] })
    vi.mocked(api.deleteSavedPlaylist).mockResolvedValue({})
    vi.mocked(api.mySavedPlaylists).mockRejectedValue(new Error('network down'))

    const { result } = renderSavedPlaylists()

    await act(async () => {
      await result.current.savedPlaylists.actions.onSelect({ id: 1, name: 'My Mix' })
    })

    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => {
      await result.current.savedPlaylists.actions.onDelete()
    })

    expect(api.deleteSavedPlaylist).toHaveBeenCalledWith(1)
    expect(result.current.pageActions.message).toBe('プレイリストを削除しました')
    expect(result.current.savedPlaylists.state.selectedPlaylist).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })
})
