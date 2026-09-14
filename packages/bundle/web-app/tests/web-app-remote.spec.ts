/**
 * The Web runtime's remote-access flow: `--remote` publishes the loopback GUI
 * through a tunnel, admits the assigned authority to the /api fence, and
 * prints the public URL with its QR code. The tunnel module is mocked, so
 * these tests exercise the runtime's own publication and failure handling
 * rather than the connector.
 *
 * Readiness publication is asynchronous and unbounded by design (a real
 * connector takes seconds), so every test waits on the outcome it asserts
 * instead of on a fixed number of ticks: a fixed flush would let one test's
 * publication land inside the next test's captured output.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, internals } from '../src/index.ts'
import { startQuickTunnel } from '../src/remote-access.ts'

vi.mock('../src/remote-access.ts', () => ({
  startQuickTunnel: vi.fn(),
  renderTerminalQr: vi.fn((text: string) => `QR[${text}]`),
}))

const originalResolve = internals.resolveDistIndex
const originalOpenBrowser = internals.openBrowser
let dist: string | undefined
const mounted: Context[] = []

beforeEach(() => {
  vi.stubEnv('SSH_CONNECTION', '')
  vi.stubEnv('SSH_TTY', '')
  vi.mocked(startQuickTunnel).mockReset()
})

afterEach(async () => {
  // Dispose before restoring the console spies: a runtime still in flight would
  // otherwise publish into the next test's captured output.
  for (const ctx of mounted.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  internals.resolveDistIndex = originalResolve
  internals.openBrowser = originalOpenBrowser
  if (dist !== undefined) rmSync(dist, { recursive: true, force: true })
  dist = undefined
})

/** Stage a dist the runtime can resolve without the real frontend build. */
function stageDist(): void {
  dist = mkdtempSync(join(tmpdir(), 'dsh-web-remote-'))
  mkdirSync(join(dist, 'dist'))
  const index = join(dist, 'dist', 'index.html')
  writeFileSync(index, '<head></head><body>shell</body>')
  internals.resolveDistIndex = () => index
}

/** A fake webServer; the runtime only reads host, port, and the fallback seat. */
function fakeHttpServer(): WebServer {
  return {
    host: '127.0.0.1',
    port: 4567,
    registerFallback: () => () => {},
    renderIndex: (html: string) => html,
  } as unknown as WebServer
}

/** A running tunnel as {@link startQuickTunnel} resolves it. */
function fakeTunnel(origin = 'https://brave-river.trycloudflare.com') {
  const close = vi.fn(async () => {})
  return { origin, authority: new URL(origin).host, close }
}

/** Deterministic Connection face recording the authorities the runtime admits. */
function provideConnection(ctx: Context, admitted: string[]): void {
  ctx.provide('connection', {
    authenticatedUrl(baseUrl: string) {
      const url = new URL(baseUrl)
      url.pathname = '/'
      url.searchParams.set('token', 'test-token')
      return url.href
    },
    authorizeIndex: () => true,
    requestRejection: () => undefined,
    addTrustedAuthority(authority: string) {
      admitted.push(authority)
      return () => {}
    },
    rpc: {},
  } as never)
}

/** One mounted runtime plus its captured output. */
interface Runtime {
  ctx: Context
  lines: string[]
  errors: string[]
  admitted: string[]
  /** Wait until an assertion about captured output holds. */
  waitFor(assertion: () => void): Promise<void>
}

/**
 * Mount the runtime without waiting for its readiness publication.
 * @param overrides - runtime config values this test varies.
 * @returns the context, captured output, and the waiting helper.
 */
function mount(overrides: Partial<Config>): Runtime {
  stageDist()
  const ctx = new Context()
  mounted.push(ctx)
  const admitted: string[] = []
  ctx.provide('webServer', fakeHttpServer())
  provideConnection(ctx, admitted)
  ctx.provide('loader', { await: async () => {} } as never)
  internals.openBrowser = vi.fn(async () => {})
  const lines: string[] = []
  const errors: string[] = []
  vi.spyOn(console, 'log').mockImplementation((message) => { lines.push(String(message)) })
  vi.spyOn(console, 'error').mockImplementation((message) => { errors.push(String(message)) })
  apply(ctx, new Config({
    openBrowser: false,
    printUrl: true,
    surfaceContext: false,
    trustedHosts: [],
    remote: false,
    cloudflared: 'cloudflared',
    printQr: true,
    ...overrides,
  }))
  return {
    ctx,
    lines,
    errors,
    admitted,
    waitFor: async (assertion) => { await vi.waitFor(assertion, { timeout: 10_000 }) },
  }
}

describe('web runtime remote access', () => {
  it('publishes the tunnel URL, admits its authority, and prints the QR code', async () => {
    const tunnel = fakeTunnel()
    vi.mocked(startQuickTunnel).mockResolvedValue(tunnel)
    const runtime = mount({ remote: true })
    await runtime.waitFor(() => { expect(runtime.admitted).toHaveLength(1) })

    expect(vi.mocked(startQuickTunnel)).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'http://127.0.0.1:4567', executable: 'cloudflared' }),
    )
    // The loopback URL still prints first: the tunnel is additive.
    expect(runtime.lines).toContain('dsh web: http://127.0.0.1:4567/?token=test-token')
    expect(runtime.lines).toContain('dsh web: remote https://brave-river.trycloudflare.com/?token=test-token')
    expect(runtime.lines).toContain('QR[https://brave-river.trycloudflare.com/?token=test-token]')
    expect(runtime.lines).toContain('dsh web: scan to open this session on another device')
    expect(runtime.admitted).toEqual(['brave-river.trycloudflare.com'])
    expect(runtime.errors).toEqual([])
  })

  it('omits the QR code under --no-qr but still publishes the URL', async () => {    vi.mocked(startQuickTunnel).mockResolvedValue(fakeTunnel())
    const runtime = mount({ remote: true, printQr: false })
    await runtime.waitFor(() => { expect(runtime.admitted).toHaveLength(1) })
    expect(runtime.lines).toContain('dsh web: remote https://brave-river.trycloudflare.com/?token=test-token')
    expect(runtime.lines.some(line => line.startsWith('QR['))).toBe(false)
  })

  it('still announces when the URL line is off but remote access is on', async () => {
    vi.mocked(startQuickTunnel).mockResolvedValue(fakeTunnel())
    const runtime = mount({ remote: true, printUrl: false })
    await runtime.waitFor(() => { expect(runtime.admitted).toHaveLength(1) })
    expect(runtime.lines.some(line => line.startsWith('dsh web: http://127.0.0.1'))).toBe(false)
    expect(runtime.lines).toContain('dsh web: remote https://brave-river.trycloudflare.com/?token=test-token')
  })

  it('keeps serving locally and reports why when the tunnel cannot start', async () => {
    vi.mocked(startQuickTunnel).mockRejectedValue(new Error('cloudflared was not found'))
    const runtime = mount({ remote: true })
    await runtime.waitFor(() => { expect(runtime.errors).toHaveLength(1) })

    expect(runtime.lines).toContain('dsh web: http://127.0.0.1:4567/?token=test-token')
    expect(runtime.lines.some(line => line.startsWith('dsh web: remote '))).toBe(false)
    expect(runtime.admitted).toEqual([])
    expect(runtime.errors).toEqual([
      'web-app: cloudflared was not found; continuing without remote access',
    ])
    // The failure must not take the local server down with it.
    expect(runtime.ctx.get('webRuntime')).toBeDefined()
  })

  it('reports a non-Error rejection reason verbatim', async () => {
    vi.mocked(startQuickTunnel).mockRejectedValue('connector refused')
    const runtime = mount({ remote: true })
    await runtime.waitFor(() => { expect(runtime.errors).toHaveLength(1) })
    expect(runtime.errors).toEqual([
      'web-app: connector refused; continuing without remote access',
    ])
  })

  it('closes the tunnel when the runtime is disposed', async () => {
    const tunnel = fakeTunnel()
    vi.mocked(startQuickTunnel).mockResolvedValue(tunnel)
    const runtime = mount({ remote: true })
    await runtime.waitFor(() => { expect(runtime.admitted).toHaveLength(1) })
    expect(tunnel.close).not.toHaveBeenCalled()
    await runtime.ctx.fiber.dispose()
    expect(tunnel.close).toHaveBeenCalled()
  })

  it('does not start a tunnel unless remote access was requested', async () => {
    const runtime = mount({})
    await runtime.waitFor(() => { expect(runtime.lines).toHaveLength(1) })
    expect(vi.mocked(startQuickTunnel)).not.toHaveBeenCalled()
    expect(runtime.lines).toEqual(['dsh web: http://127.0.0.1:4567/?token=test-token'])
  })

  it('passes the configured connector executable through', async () => {
    vi.mocked(startQuickTunnel).mockResolvedValue(fakeTunnel())
    const runtime = mount({ remote: true, cloudflared: '/opt/bin/cloudflared' })
    await runtime.waitFor(() => { expect(runtime.admitted).toHaveLength(1) })
    expect(vi.mocked(startQuickTunnel)).toHaveBeenCalledWith(
      expect.objectContaining({ executable: '/opt/bin/cloudflared' }),
    )
  })

  it('warns on the tunnel exit and keeps the announced authority usable', async () => {
    const tunnel = fakeTunnel()
    let onExit: ((code: number | null) => void) | undefined
    vi.mocked(startQuickTunnel).mockImplementation(async (options) => {
      onExit = options.onExit
      return tunnel
    })
    const runtime = mount({ remote: true })
    await runtime.waitFor(() => { expect(runtime.admitted).toHaveLength(1) })
    expect(onExit).toBeDefined()
    onExit?.(7)
    expect(runtime.errors).toEqual([
      'web-app: the remote tunnel exited with code 7; its public URL is no longer reachable',
    ])
    expect(runtime.admitted).toEqual(['brave-river.trycloudflare.com'])
  })
})
