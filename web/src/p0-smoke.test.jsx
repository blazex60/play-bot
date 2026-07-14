import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { P0Smoke } from './p0-smoke.jsx'

describe('P0 React DOM harness', () => {
  it('renders the deterministic ready selector', () => {
    render(<P0Smoke />)

    expect(screen.getByTestId('p0-smoke-status').textContent).toBe('P0 harness ready')
  })
})
