import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

const CLIENT_DIR = path.resolve(import.meta.dirname, '../../client')

test.describe('SPA shell', () => {
  test('no errors in browser console on load', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))

    await page.goto('/repos', { waitUntil: 'networkidle' })
    await page.waitForTimeout(1_000)

    expect(errors).toEqual([])
  })

  test('no errors after HMR update', async ({ page }) => {
    const errors: string[] = []
    const overlayErrors: string[] = []

    page.on('pageerror', (err) => errors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text())
    })

    await page.goto('/repos', { waitUntil: 'networkidle' })

    const appVue = path.join(CLIENT_DIR, 'App.vue')
    const original = fs.readFileSync(appVue, 'utf-8')

    try {
      const touched = original.replace('</template>', '<!-- hmr-test -->\n</template>')
      fs.writeFileSync(appVue, touched)
      await page.waitForTimeout(3_000)

      const overlay = await page.locator('vite-error-overlay').count()
      if (overlay > 0) {
        const text = await page.locator('vite-error-overlay').textContent()
        overlayErrors.push(text ?? 'vite overlay present')
      }

      expect(errors.filter((e) => !e.includes('[vite]'))).toEqual([])
      expect(overlayErrors).toEqual([])
      await expect(page.getByRole('banner')).toContainText('lfs-admin')
    } finally {
      fs.writeFileSync(appVue, original)
    }
  })

  test('/ redirects to /repos via vue-router', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL('**/repos')
    expect(page.url()).toContain('/repos')
  })

  test('/repos renders Repositories heading', async ({ page }) => {
    await page.goto('/repos')
    await expect(page.locator('h2')).toHaveText('Repositories')
  })

  test('AppHeader shows lfs-admin branding and Repos link', async ({ page }) => {
    await page.goto('/repos')
    const header = page.getByRole('banner')
    await expect(header).toContainText('lfs-admin')
    await expect(header).toContainText('Repos')
  })

  test('admin username "dev" appears in header (localhost bypass)', async ({ page }) => {
    await page.goto('/repos')
    await expect(page.getByRole('banner')).toContainText('dev', { timeout: 5_000 })
  })

  test('page reload on /repos does not break SPA', async ({ page }) => {
    await page.goto('/repos')
    await expect(page.locator('h2')).toHaveText('Repositories')

    await page.reload()
    await expect(page.locator('h2')).toHaveText('Repositories')
    await expect(page.getByRole('banner')).toContainText('lfs-admin')
  })

  test('Tailwind CSS is applied', async ({ page }) => {
    await page.goto('/repos')
    const bg = await page.evaluate(() =>
      window.getComputedStyle(document.documentElement).backgroundColor,
    )
    expect(bg).not.toBe('')
    expect(bg).not.toBe('rgba(0, 0, 0, 0)')
  })

  test('direct navigation to /repos works (SPA fallthrough)', async ({ page }) => {
    await page.goto('/repos', { waitUntil: 'networkidle' })
    await expect(page.getByRole('banner')).toContainText('lfs-admin')
    await expect(page.locator('h2')).toHaveText('Repositories')
  })
})
