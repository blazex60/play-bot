import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { PermissionMatrix } from './PermissionMatrix.jsx'

/** @param {Element | null | undefined} el @returns {Element} */
function assertElement(el) {
  if (!el) throw new Error('expected element to exist')
  return el
}

function baseProps(overrides = {}) {
  return {
    commands: ['skip', 'play'],
    defaults: {},
    overrides: {},
    knownUsers: [{ discordId: 'u1', username: 'someone' }],
    busy: false,
    onSetDefault: vi.fn(),
    onSetUserOverride: vi.fn(),
    ...overrides,
  }
}

describe('PermissionMatrix', () => {
  it('renders a default row and calls onSetDefault when changed', async () => {
    const onSetDefault = vi.fn()
    render(<PermissionMatrix {...baseProps({ onSetDefault })} />)

    const defaultRow = assertElement(screen.getByText('デフォルト').closest('tr'))
    const select = assertElement(defaultRow.querySelectorAll('select')[0])
    await userEvent.selectOptions(select, 'deny')

    expect(onSetDefault).toHaveBeenCalledWith('skip', 'deny')
  })

  it('renders an override row for users with existing overrides', () => {
    render(
      <PermissionMatrix
        {...baseProps({
          overrides: { u1: { skip: 'deny' } },
        })}
      />
    )

    expect(screen.getByText('someone')).toBeTruthy()
  })

  it('calls onSetUserOverride with null when switching an override back to inherit', async () => {
    const onSetUserOverride = vi.fn()
    render(
      <PermissionMatrix
        {...baseProps({
          overrides: { u1: { skip: 'deny' } },
          onSetUserOverride,
        })}
      />
    )

    const userRow = assertElement(screen.getByText('someone').closest('tr'))
    const select = assertElement(userRow.querySelectorAll('select')[0])
    await userEvent.selectOptions(select, 'inherit')

    expect(onSetUserOverride).toHaveBeenCalledWith('u1', 'skip', null)
  })

  it('adds a known user row showing "inherit" for every command, without granting any permission', async () => {
    const onSetUserOverride = vi.fn()
    render(<PermissionMatrix {...baseProps({ onSetUserOverride })} />)

    const addSelect = assertElement(assertElement(screen.getByText('ユーザーを追加').parentElement).querySelector('select'))
    await userEvent.selectOptions(addSelect, 'u1')

    expect(screen.getByText('someone')).toBeTruthy()
    expect(onSetUserOverride).not.toHaveBeenCalled()

    const userRow = assertElement(screen.getByText('someone').closest('tr'))
    for (const select of userRow.querySelectorAll('select')) {
      expect(/** @type {HTMLSelectElement} */ (select).value).toBe('inherit')
    }
  })

  it('persists a permission only once the admin picks a value for the newly added row', async () => {
    const onSetUserOverride = vi.fn()
    render(<PermissionMatrix {...baseProps({ onSetUserOverride })} />)

    const addSelect = assertElement(assertElement(screen.getByText('ユーザーを追加').parentElement).querySelector('select'))
    await userEvent.selectOptions(addSelect, 'u1')

    const userRow = assertElement(screen.getByText('someone').closest('tr'))
    const playSelect = assertElement(userRow.querySelectorAll('select')[1])
    await userEvent.selectOptions(playSelect, 'deny')

    expect(onSetUserOverride).toHaveBeenCalledWith('u1', 'play', 'deny')
  })
})
