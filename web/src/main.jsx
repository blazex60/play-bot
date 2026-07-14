import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.jsx'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Music Bot Web UI root element is missing')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
