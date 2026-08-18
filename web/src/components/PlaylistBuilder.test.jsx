import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, mock } from 'bun:test'

import { PlaylistBuilder } from './PlaylistBuilder.jsx'

// Overrides are keyed exactly like the old flat props object was, but split
// into PlaylistBuilder's current { state, actions } shape based on which
// half of the component's props each key belongs to.
function baseProps(overrides = {}) {
  const state = {
    playlists: [],
    selectedPlaylist: null,
    newPlaylistName: '',
    renameValue: '',
    trackUrl: '',
    trackSearchQuery: '',
    generatePrompt: '',
    generateCount: 10,
    searchResults: [],
    canQueue: false,
    busy: false,
  }
  const actions = {
    onNewPlaylistNameChange: mock(),
    onCreate: mock(),
    onSelect: mock(),
    onRenameValueChange: mock(),
    onRename: mock(),
    onDelete: mock(),
    onTrackUrlChange: mock(),
    onAddByUrl: mock(),
    onTrackSearchQueryChange: mock(),
    onSearchTracks: mock(),
    onGeneratePromptChange: mock(),
    onGenerateCountChange: mock(),
    onGenerateFromPrompt: mock(),
    onAddFromSearchResult: mock(),
    onMoveTrack: mock(),
    onRemoveTrack: mock(),
    onQueueToGuild: mock(),
  }
  const stateRecord = /** @type {Record<string, unknown>} */ (state)
  const actionsRecord = /** @type {Record<string, unknown>} */ (actions)
  for (const [key, value] of Object.entries(overrides)) {
    if (key in state) stateRecord[key] = value
    else actionsRecord[key] = value
  }
  return { state, actions }
}

describe('PlaylistBuilder create flow', () => {
  it('shows an empty state and disables create while the name is blank', () => {
    render(<PlaylistBuilder {...baseProps()} />)

    expect(screen.getByText('プレイリストはまだありません。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '作成' }).hasAttribute('disabled')).toBe(true)
  })

  it('calls onCreate with the current name when the create form is submitted', async () => {
    const onCreate = mock()
    render(<PlaylistBuilder {...baseProps({ newPlaylistName: '作業用BGM', onCreate })} />)

    await userEvent.click(screen.getByRole('button', { name: '作成' }))
    expect(onCreate).toHaveBeenCalled()
  })

  it('lists saved playlists and selects one on click', async () => {
    const onSelect = mock()
    const playlist = { id: 1, name: '作業用BGM', trackCount: 3 }
    render(<PlaylistBuilder {...baseProps({ playlists: [playlist], onSelect })} />)

    await userEvent.click(screen.getByRole('option', { name: /作業用BGM/ }))
    expect(onSelect).toHaveBeenCalledWith(playlist)
  })
})

describe('PlaylistBuilder selected playlist detail', () => {
  const selectedPlaylist = {
    id: 1,
    name: '作業用BGM',
    tracks: [
      { id: 10, title: 'Track A', webpageUrl: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
      { id: 11, title: 'Track B', webpageUrl: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' },
    ],
  }

  it('renders tracks and calls onMoveTrack/onRemoveTrack', async () => {
    const onMoveTrack = mock()
    const onRemoveTrack = mock()
    render(<PlaylistBuilder {...baseProps({ selectedPlaylist, onMoveTrack, onRemoveTrack })} />)

    expect(screen.getByText('Track A')).toBeTruthy()
    expect(screen.getByText('Track B')).toBeTruthy()

    const downButtons = screen.getAllByRole('button', { name: 'Down' })
    await userEvent.click(/** @type {HTMLElement} */ (downButtons[0]))
    expect(onMoveTrack).toHaveBeenCalledWith(0, 1)

    const removeButtons = screen.getAllByRole('button', { name: 'Remove' })
    await userEvent.click(/** @type {HTMLElement} */ (removeButtons[0]))
    expect(onRemoveTrack).toHaveBeenCalledWith(10)
  })

  it('disables the up button for the first track and the down button for the last', () => {
    render(<PlaylistBuilder {...baseProps({ selectedPlaylist })} />)

    const upButtons = screen.getAllByRole('button', { name: 'Up' })
    const downButtons = screen.getAllByRole('button', { name: 'Down' })
    expect(/** @type {HTMLElement} */ (upButtons[0]).hasAttribute('disabled')).toBe(true)
    expect(/** @type {HTMLElement} */ (downButtons[downButtons.length - 1]).hasAttribute('disabled')).toBe(true)
  })

  it('renders search results and adds one via onAddFromSearchResult', async () => {
    const onAddFromSearchResult = mock()
    const searchResults = [{ title: 'Track C', webpageUrl: 'https://www.youtube.com/watch?v=ccccccccccc', videoId: 'ccccccccccc' }]
    render(<PlaylistBuilder {...baseProps({ selectedPlaylist, searchResults, onAddFromSearchResult })} />)

    expect(screen.getByText('Track C')).toBeTruthy()
    const addButtons = screen.getAllByRole('button', { name: '追加' })
    await userEvent.click(/** @type {HTMLElement} */ (addButtons[addButtons.length - 1]))
    expect(onAddFromSearchResult).toHaveBeenCalledWith(searchResults[0])
  })

  it('disables the queue button when there is no guild selected or no tracks', () => {
    const { rerender } = render(<PlaylistBuilder {...baseProps({ selectedPlaylist, canQueue: false })} />)
    expect(screen.getByRole('button', { name: 'このサーバーのキューに追加' }).hasAttribute('disabled')).toBe(true)

    rerender(<PlaylistBuilder {...baseProps({ selectedPlaylist, canQueue: true })} />)
    expect(screen.getByRole('button', { name: 'このサーバーのキューに追加' }).hasAttribute('disabled')).toBe(false)

    rerender(<PlaylistBuilder {...baseProps({ selectedPlaylist: { ...selectedPlaylist, tracks: [] }, canQueue: true })} />)
    expect(screen.getByRole('button', { name: 'このサーバーのキューに追加' }).hasAttribute('disabled')).toBe(true)
  })
})
