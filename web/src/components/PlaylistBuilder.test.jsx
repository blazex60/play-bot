import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PlaylistBuilder } from './PlaylistBuilder.jsx'

function baseProps(overrides = {}) {
  return {
    playlists: [],
    selectedPlaylist: null,
    newPlaylistName: '',
    onNewPlaylistNameChange: vi.fn(),
    onCreate: vi.fn(),
    onSelect: vi.fn(),
    renameValue: '',
    onRenameValueChange: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    trackUrl: '',
    onTrackUrlChange: vi.fn(),
    onAddByUrl: vi.fn(),
    trackSearchQuery: '',
    onTrackSearchQueryChange: vi.fn(),
    onSearchTracks: vi.fn(),
    searchResults: [],
    onAddFromSearchResult: vi.fn(),
    onMoveTrack: vi.fn(),
    onRemoveTrack: vi.fn(),
    onQueueToGuild: vi.fn(),
    canQueue: false,
    busy: false,
    ...overrides,
  }
}

describe('PlaylistBuilder create flow', () => {
  it('shows an empty state and disables create while the name is blank', () => {
    render(<PlaylistBuilder {...baseProps()} />)

    expect(screen.getByText('プレイリストはまだありません。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '作成' }).hasAttribute('disabled')).toBe(true)
  })

  it('calls onCreate with the current name when the create form is submitted', async () => {
    const onCreate = vi.fn()
    render(<PlaylistBuilder {...baseProps({ newPlaylistName: '作業用BGM', onCreate })} />)

    await userEvent.click(screen.getByRole('button', { name: '作成' }))
    expect(onCreate).toHaveBeenCalled()
  })

  it('lists saved playlists and selects one on click', async () => {
    const onSelect = vi.fn()
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
    const onMoveTrack = vi.fn()
    const onRemoveTrack = vi.fn()
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
    const onAddFromSearchResult = vi.fn()
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
