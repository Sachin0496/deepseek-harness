/**
 * Remote-access behavior: the terminal QR renderer, the connector spawn
 * arguments, and the quick-tunnel lifecycle including its failure and
 * disposal paths. A fake connector stands in for cloudflared, so no test
 * needs the binary or the network.
 */

import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { internals, renderTerminalQr, startQuickTunnel } from '../src/remote-access.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}))

const realSpawnTunnel = internals.spawnTunnel

afterEach(() => {
  internals.spawnTunnel = realSpawnTunnel
  vi.mocked(spawn).mockReset()
  vi.restoreAllMocks()
})

/** A connector stand-in whose streams and exit this test drives. */
interface FakeConnector {
  readonly child: ChildProcess
  readonly kill: ReturnType<typeof vi.fn>
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  emitOut(text: string): void
  emitErr(text: string): void
  exit(code: number | null): void
}

function fakeConnector(): FakeConnector {
  const emitter = new EventEmitter() as EventEmitter & {
    stdout: PassThrough
    stderr: PassThrough
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
    signalCode: string | null
  }
  emitter.stdout = new PassThrough()
  emitter.stderr = new PassThrough()
  emitter.exitCode = null
  emitter.signalCode = null
  emitter.kill = vi.fn(() => {
    emitter.exitCode = 0
    emitter.emit('exit', 0)
    return true
  })
  return {
    child: emitter as unknown as ChildProcess,
    kill: emitter.kill,
    stdout: emitter.stdout,
    stderr: emitter.stderr,
    emitOut: (text) => { emitter.stdout.write(text) },
    emitErr: (text) => { emitter.stderr.write(text) },
    exit: (code) => {
      emitter.exitCode = code
      emitter.emit('exit', code)
    },
  }
}

/**
 * Install one fake connector, returning it and the in-flight start. The
 * publication grace is zero: the wait itself is covered by its own test, and
 * every other test wants the resolution to follow publication directly.
 */
function begin(): { fake: FakeConnector; started: Promise<Awaited<ReturnType<typeof startQuickTunnel>>> } {
  const fake = fakeConnector()
  internals.spawnTunnel = () => fake.child
  const started = startQuickTunnel({
    target: 'http://127.0.0.1:3080', executable: 'cloudflared', publicationGraceMs: 0,
  })
  // Mark the rejection handled up front: some tests settle it from a timer or
  // an event long after this point, and an unhandled rejection would fail the run.
  started.catch(() => {})
  return { fake, started }
}

describe('renderTerminalQr', () => {
  it('renders a scannable code as uniform-width text rows', () => {
    const url = `https://example-tunnel.trycloudflare.com/?token=${'a'.repeat(43)}`
    const rows = renderTerminalQr(url).split('\n')
    expect(rows.length).toBeGreaterThan(10)
    expect(rows[0]).toMatch(/^[▀▄█ ]+$/u)
    // A ragged code would not scan.
    expect(new Set(rows.map(row => row.length)).size).toBe(1)
  })

  it('encodes different URLs differently', () => {
    expect(renderTerminalQr('https://a.example/')).not.toBe(renderTerminalQr('https://b.example/'))
  })
})

describe('connector spawn', () => {
  it('runs cloudflared against the target with auto-update disabled and no inherited secrets', () => {
    vi.mocked(spawn).mockReturnValue(fakeConnector().child)
    internals.spawnTunnel('/opt/bin/cloudflared', 'http://127.0.0.1:3080')
    const [executable, args, options] = vi.mocked(spawn).mock.calls[0] ?? []
    expect(executable).toBe('/opt/bin/cloudflared')
    expect(args).toEqual(['tunnel', '--url', 'http://127.0.0.1:3080', '--no-autoupdate'])
    expect(options?.stdio).toEqual(['ignore', 'pipe', 'pipe'])
    expect(options?.env).toBeTypeOf('object')
  })
})

describe('startQuickTunnel', () => {
  it('resolves the public origin and authority once the connector publishes them', async () => {
    const { fake, started } = begin()
    fake.emitOut('INF Requesting new quick Tunnel on trycloudflare.com...\n')
    fake.emitOut('INF |  https://brave-river-quiet-moon.trycloudflare.com  |\n')
    const tunnel = await started
    expect(tunnel.origin).toBe('https://brave-river-quiet-moon.trycloudflare.com')
    expect(tunnel.authority).toBe('brave-river-quiet-moon.trycloudflare.com')
    await tunnel.close()
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('reads the origin from stderr too', async () => {
    const { fake, started } = begin()
    fake.emitErr('INF https://stderr-side-tunnel.trycloudflare.com\n')
    expect((await started).origin).toBe('https://stderr-side-tunnel.trycloudflare.com')
  })

  it('ignores output that carries no origin until one appears', async () => {
    const { fake, started } = begin()
    let settled = false
    void started.finally(() => { settled = true })
    fake.emitOut('INF no url in this line\n')
    await Promise.resolve()
    expect(settled).toBe(false)
    fake.emitOut('INF https://finally-appeared.trycloudflare.com\n')
    expect((await started).origin).toBe('https://finally-appeared.trycloudflare.com')
  })

  it('stops the connector and names a missing executable', async () => {
    const { fake, started } = begin()
    fake.child.emit('error', Object.assign(new Error('spawn cloudflared ENOENT'), { code: 'ENOENT' }))
    await expect(started).rejects.toThrow(
      'remote access could not start because the "cloudflared" executable was not found; install cloudflared or pass --cloudflared <path>',
    )
  })

  it('reports a spawn failure that is not a missing executable', async () => {
    const { fake, started } = begin()
    fake.child.emit('error', new Error('EACCES: permission denied'))
    await expect(started).rejects.toThrow('remote access could not start because EACCES: permission denied')
  })

  it('reports an early exit with the diagnostics that explain it', async () => {
    const { fake, started } = begin()
    fake.emitOut('ERR Failed to create tunnel\n')
    fake.exit(1)
    await expect(started).rejects.toThrow(
      'cloudflared exited with code 1 before publishing a URL: ERR Failed to create tunnel',
    )
  })

  it('reports an early exit that produced no diagnostics', async () => {
    const { fake, started } = begin()
    fake.exit(3)
    await expect(started).rejects.toThrow('cloudflared exited with code 3 before publishing a URL')
  })

  it('gives up on its own deadline and stops the connector', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConnector()
      internals.spawnTunnel = () => fake.child
      const started = startQuickTunnel({ target: 'http://127.0.0.1:3080', executable: 'cloudflared', timeoutMs: 50 })
      started.catch(() => {})
      const assertion = expect(started).rejects.toThrow('cloudflared published no URL within 50ms')
      await vi.advanceTimersByTimeAsync(60)
      await assertion
      expect(fake.kill).toHaveBeenCalledWith('SIGTERM')
    } finally {
      vi.useRealTimers()
    }
  })

  it('quotes drained diagnostics on the deadline', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConnector()
      internals.spawnTunnel = () => fake.child
      const started = startQuickTunnel({ target: 'http://127.0.0.1:3080', executable: 'cloudflared', timeoutMs: 5 })
      started.catch(() => {})
      const assertion = expect(started).rejects.toThrow(/published no URL within 5ms: .*still connecting/u)
      fake.emitOut('INF still connecting\n')
      await vi.advanceTimersByTimeAsync(10)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a post-start exit to the caller', async () => {
    const fake = fakeConnector()
    internals.spawnTunnel = () => fake.child
    const onExit = vi.fn()
    const started = startQuickTunnel({
      target: 'http://127.0.0.1:3080', executable: 'cloudflared', onExit, publicationGraceMs: 0,
    })
    fake.emitOut('INF https://late-exit-tunnel.trycloudflare.com\n')
    const tunnel = await started
    expect(onExit).not.toHaveBeenCalled()
    fake.exit(7)
    expect(onExit).toHaveBeenCalledWith(7)
    await tunnel.close()
  })

  it('tolerates a post-start exit with no observer installed', async () => {
    const { fake, started } = begin()
    fake.emitOut('INF https://unobserved-exit.trycloudflare.com\n')
    await started
    expect(() => { fake.exit(0) }).not.toThrow()
  })

  it('stops reading output after the tunnel is live', async () => {
    const { fake, started } = begin()
    fake.emitOut('INF https://first-origin-wins.trycloudflare.com\n')
    const tunnel = await started
    // A later line must not replace the resolved origin or throw.
    fake.emitOut('INF https://second-origin-ignored.trycloudflare.com\n')
    expect(tunnel.origin).toBe('https://first-origin-wins.trycloudflare.com')
  })

  it('ignores a late spawn error once the tunnel is live', async () => {
    const { fake, started } = begin()
    fake.emitOut('INF https://error-after-live.trycloudflare.com\n')
    await started
    expect(() => { fake.child.emit('error', new Error('late')) }).not.toThrow()
  })

  it('holds the published URL for the publication grace period', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConnector()
      internals.spawnTunnel = () => fake.child
      const started = startQuickTunnel({
        target: 'http://127.0.0.1:3080', executable: 'cloudflared', publicationGraceMs: 8_000,
      })
      started.catch(() => {})
      fake.emitOut('INF https://fresh-hostname.trycloudflare.com\n')

      // Cloudflare creates the edge record seconds after the connector names the
      // host, so answering immediately would print a QR code that resolves to
      // nothing. The wait is a timer and not a DNS probe: trycloudflare.com's
      // 1800s negative TTL would cache NXDOMAIN in the operator's own resolver
      // for half an hour and outlive the record it wrongly denies.
      let settled = false
      void started.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(7_900)
      expect(settled).toBe(false)

      await vi.advanceTimersByTimeAsync(200)
      const tunnel = await started
      expect(tunnel.origin).toBe('https://fresh-hostname.trycloudflare.com')
      expect(tunnel.authority).toBe('fresh-hostname.trycloudflare.com')
      expect(fake.kill).not.toHaveBeenCalled()
      await tunnel.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves after the grace period even when the origin never answers', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConnector()
      internals.spawnTunnel = () => fake.child
      const started = startQuickTunnel({
        target: 'http://127.0.0.1:3080', executable: 'cloudflared', publicationGraceMs: 40,
      })
      started.catch(() => {})
      fake.emitOut('INF https://slow-to-publish.trycloudflare.com\n')
      await vi.advanceTimersByTimeAsync(50)
      const tunnel = await started

      // The connector created the tunnel, so the URL is real. Reporting no
      // tunnel because an origin check failed would be strictly worse than
      // reporting one that is a few seconds from resolving.
      expect(tunnel.origin).toBe('https://slow-to-publish.trycloudflare.com')
      expect(fake.kill).not.toHaveBeenCalled()
      await tunnel.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects when the connector dies during the grace period', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConnector()
      internals.spawnTunnel = () => fake.child
      const started = startQuickTunnel({
        target: 'http://127.0.0.1:3080', executable: 'cloudflared', publicationGraceMs: 5_000,
      })
      started.catch(() => {})
      fake.emitOut('INF https://dies-during-grace.trycloudflare.com\n')
      const assertion = expect(started).rejects.toThrow(
        'cloudflared exited with code 4 before publishing a URL',
      )
      fake.exit(4)

      // The grace period is not a report of success: the tunnel dies with its
      // connector, so a caller handed that URL would get nothing. Rejecting
      // lets the runtime report the failure and keep serving on loopback.
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not resolve when a spawn error settles the start during the grace period', async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConnector()
      internals.spawnTunnel = () => fake.child
      const started = startQuickTunnel({
        target: 'http://127.0.0.1:3080', executable: 'cloudflared', publicationGraceMs: 5_000,
      })
      started.catch(() => {})
      fake.emitOut('INF https://raced-by-error.trycloudflare.com\n')
      fake.child.emit('error', new Error('connector died'))

      // The failure owns the settlement, so the pending grace timer must find
      // the promise already claimed instead of resolving a dead tunnel.
      const assertion = expect(started).rejects.toThrow('remote access could not start because connector died')
      await vi.advanceTimersByTimeAsync(6_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes idempotently without signalling an already-exited connector', async () => {
    const { fake, started } = begin()
    fake.emitOut('INF https://already-gone-tunnel.trycloudflare.com\n')
    const tunnel = await started
    fake.exit(0)
    await tunnel.close()
    expect(fake.kill).not.toHaveBeenCalled()
  })
})
