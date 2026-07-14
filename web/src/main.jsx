import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { P0Smoke } from './p0-smoke.jsx'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('P0 harness root element is missing')
}

createRoot(rootElement).render(
  <StrictMode>
    <P0Smoke />
  </StrictMode>
)
