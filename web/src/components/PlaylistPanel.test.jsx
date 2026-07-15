import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PlaylistPanel } from './PlaylistPanel.jsx'

function baseProps(overrides = {}) {
  return {
    links: [],
    playlists: [],
    selectedService: 'youtube',
    selectedPlaylistId: undefined,
    busy: false,
    onSelectService: vi.fn(),
    onLoadPlaylists: vi.fn(),
    onSelectPlaylist: vi.fn(),
    onImport: vi.fn(),
    onRelink: vi.fn(),
    ...overrides,
  }
}

describe('PlaylistPanel link state', () => {
  it('prompts to link and disables playlist actions when unlinked', async () => {
    const onRelink = vi.fn()
    render(
      <PlaylistPanel
        {...baseProps({
          links: [{ service: 'youtube', status: 'unlinked' }],
          onRelink,
        })}
      />
    )

    expect(screen.getByText('youtube と連携していません。')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'プレイリストを取得' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'キューに追加' }).hasAttribute('disabled')).toBe(true)

    await userEvent.click(screen.getByRole('button', { name: '連携する' }))
    expect(onRelink).toHaveBeenCalledWith('youtube')
  })

  it('prompts to re-link when the token needs a relink', () => {
    render(
      <PlaylistPanel
        {...baseProps({
          links: [{ service: 'youtube', status: 'needs_relink' }],
        })}
      />
    )

    expect(screen.getByText('youtube の認証が切れています。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '再連携' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'プレイリストを取得' }).hasAttribute('disabled')).toBe(true)
  })

  it('enables playlist actions and hides the warning when linked', () => {
    render(
      <PlaylistPanel
        {...baseProps({
          links: [{ service: 'youtube', status: 'active' }],
        })}
      />
    )

    expect(screen.queryByText(/連携していません|認証が切れています/)).toBeNull()
    expect(screen.getByRole('button', { name: 'プレイリストを取得' }).hasAttribute('disabled')).toBe(false)
  })
})
