import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

mock.module('../api/client.js', () => ({
  api: {
    mySavedPlaylists: mock(),
    createSavedPlaylist: mock(),
    savedPlaylist: mock(),
    renameSavedPlaylist: mock(),
    deleteSavedPlaylist: mock(),
    addSavedPlaylistTrack: mock(),
    searchSavedPlaylistTrack: mock(),
    removeSavedPlaylistTrack: mock(),
    moveSavedPlaylistTrack: mock(),
    queueSavedPlaylist: mock(),
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
    mock.clearAllMocks()
    spyOn(console, 'error').mockImplementation(() => {})
  })

  it('reports the create mutation as successful even when the follow-up refresh fails', async () => {
    api.createSavedPlaylist.mockResolvedValue({ id: 1 })
    api.mySavedPlaylists.mockRejectedValue(new Error('network down'))

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
    api.createSavedPlaylist.mockResolvedValue({ id: 1 })
    api.mySavedPlaylists.mockResolvedValue({ playlists: [{ id: 1, name: 'My Mix' }] })

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
    api.savedPlaylist.mockResolvedValue({ id: 1, name: 'My Mix', tracks: [] })
    api.deleteSavedPlaylist.mockResolvedValue({})
    api.mySavedPlaylists.mockRejectedValue(new Error('network down'))

    const { result } = renderSavedPlaylists()

    await act(async () => {
      await result.current.savedPlaylists.actions.onSelect({ id: 1, name: 'My Mix' })
    })

    spyOn(window, 'confirm').mockReturnValue(true)
    await act(async () => {
      await result.current.savedPlaylists.actions.onDelete()
    })

    expect(api.deleteSavedPlaylist).toHaveBeenCalledWith(1)
    expect(result.current.pageActions.message).toBe('プレイリストを削除しました')
    expect(result.current.savedPlaylists.state.selectedPlaylist).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })
})
