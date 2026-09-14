// Web e2e scenario: the printed launch URL must open the GUI when it arrives
// from outside the browser, which is what scanning the `dsh web --remote`
// terminal QR code does. That navigation is cross-site, so the session cookie's
// SameSite attribute decides whether the browser sends it on the token
// exchange's redirect to clean `/`; a `Strict` cookie is stored and then
// withheld, leaving the operator on the 401 page after scanning a correct code.
// Zero model calls.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

/** Foreign origin standing in for the camera app that hands a scanned URL over. */
const SCANNER_ORIGIN = 'https://scanner.example'

describe('web e2e: launch URL opened from outside the browser', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    // Fulfilled locally: the origin only has to be foreign to the GUI, and the
    // lane must not reach the network.
    await page.route(`${SCANNER_ORIGIN}/**`, (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: `<a id="scan" href="${scaffold.authenticatedUrl}">open</a>`,
    }))
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('authenticates the token exchange and renders the GUI', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-launch-url-handoff'))

    await page.goto(`${SCANNER_ORIGIN}/scan`, { waitUntil: 'load' })
    await page.click('#scan')

    // The exchange redirects to clean `/`, so the token must be gone from the
    // address bar once the GUI is up.
    try {
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    } catch (error) {
      const body = await page.locator('body').innerText().catch(() => '<no body>')
      throw new Error(
        `the GUI did not render after a cross-site launch-URL hand-off; landed on ${page.url()} with body: ${body.trim().slice(0, 200)}`,
        { cause: error },
      )
    }
    const landed = new URL(page.url())
    expect(landed.pathname).toBe('/')
    expect(landed.searchParams.get('token')).toBeNull()
    expect(await page.locator('body').innerText()).not.toContain('authentication required')
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)
})
