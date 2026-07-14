import { expect, test } from '@playwright/test'

const statePayload = {
  active: true,
  current: {
    title: 'Lo-fi Study',
    webpageUrl: 'https://youtube.example/watch?v=1',
    requestedBy: 'user-1',
  },
  upcoming: [
    { title: 'Queue One', webpageUrl: 'https://youtube.example/watch?v=2', requestedBy: 'user-2' },
    { title: 'Queue Two', webpageUrl: 'https://youtube.example/watch?v=3', requestedBy: 'user-3' },
  ],
  playerStatus: 'playing',
  loopMode: 'OFF',
}

async function json(route, payload, status = 200) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  })
}

async function installDashboardMocks(page, { relink = false } = {}) {
  await page.route('**/api/me', (route) => json(route, { user: { discordId: 'user-1', username: 'lemitsu' } }))
  await page.route('**/api/state/guild-1', (route) => json(route, statePayload))
  await page.route('**/api/links', (route) => json(route, {
    services: [
      { service: 'spotify', linked: !relink, status: relink ? 'needs_relink' : 'active' },
      { service: 'youtube', linked: true, status: 'active' },
    ],
  }))
  await page.route('**/api/links/spotify/playlists', (route) => json(route, {
    playlists: [{ id: 'playlist-1', name: 'Focus Mix', trackCount: 12 }],
  }))
  await page.route('**/api/links/spotify/relink', (route) => json(route, { redirectUrl: '/auth/spotify' }))
  await page.route('**/api/guilds/guild-1/control/**', (route) => json(route, { ok: true, state: statePayload }))
  await page.route('**/api/guilds/guild-1/queue/**', (route) => json(route, { ok: true, state: statePayload }))
  await page.route('**/api/import/guild-1', (route) => json(route, {
    jobId: 42,
    status: 'completed',
    matchedCount: 1,
    failedCount: 0,
  }))
  await page.route('**/api/import/jobs/42/tracks', (route) => json(route, {
    tracks: [{
      id: 7,
      source_title: 'Focus Track',
      matched_title: 'Focus Track on YouTube',
      match_status: 'matched',
    }],
  }))
  await page.route('**/api/import/tracks/7/search', (route) => json(route, {
    results: [{ title: 'Replacement Track', webpageUrl: 'https://youtube.example/watch?v=4' }],
  }))
  await page.route('**/api/import/tracks/7/replace', (route) => json(route, { track: { title: 'Replacement Track' } }))
}

test('dashboard drives playback, queue, import, and match review flows', async ({ page }) => {
  await installDashboardMocks(page)

  await page.goto('/?guildId=guild-1')

  await expect(page.getByRole('heading', { name: 'Music Dashboard' })).toBeVisible()
  await expect(page.getByText('Lo-fi Study')).toBeVisible()
  await expect(page.getByRole('button', { name: /Apple Music/ })).toBeDisabled()

  await page.getByRole('button', { name: 'Pause' }).click()
  await expect(page.getByRole('status')).toHaveText('操作を送信しました')

  await page.getByRole('button', { name: 'Down' }).first().click()
  await expect(page.getByRole('status')).toHaveText('キューを並べ替えました')

  await page.getByRole('button', { name: 'Remove' }).first().click()
  await expect(page.getByRole('status')).toHaveText('キューから削除しました')

  await page.getByRole('button', { name: 'プレイリストを取得' }).click()
  await page.getByRole('option', { name: /Focus Mix/ }).click()
  await page.getByRole('button', { name: 'キューに追加' }).click()
  await expect(page.getByTestId('import-summary')).toContainText('completed')

  await page.getByPlaceholder('曲名 アーティスト').fill('replacement query')
  await page.getByRole('button', { name: 'Search' }).click()
  await page.getByRole('button', { name: 'Replace' }).click()
  await expect(page.getByRole('status')).toHaveText('曲を差し替えました')
})

test('dashboard surfaces expired provider tokens as relink action', async ({ page }) => {
  await installDashboardMocks(page, { relink: true })

  await page.goto('/?guildId=guild-1')

  await expect(page.getByText('spotify の認証が切れています。')).toBeVisible()
  await page.getByRole('button', { name: '再連携' }).click()
  await expect(page).toHaveURL(/\/auth\/spotify$/)
})

test('login route exposes Discord OAuth entry point', async ({ page }) => {
  await page.goto('/login')

  await expect(page.getByRole('heading', { name: 'Discord ログイン' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Discord でログイン' })).toHaveAttribute('href', '/auth/discord')
})
