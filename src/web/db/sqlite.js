export default process.versions.bun
  ? (await import('./sqlite-bun.js')).default
  : (await import('better-sqlite3')).default
