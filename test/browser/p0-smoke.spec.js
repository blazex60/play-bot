import { expect, test } from '@playwright/test'

test('P0 Chromium harness launches, asserts, and closes a real page', async ({ browser }) => {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.setContent(`
    <!doctype html>
    <html lang="en">
      <body><main data-testid="p0-browser-status">P0 Chromium ready</main></body>
    </html>
  `)

  await expect(page.getByTestId('p0-browser-status')).toHaveText('P0 Chromium ready')
  await context.close()
})
