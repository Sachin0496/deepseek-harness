/**
 * Public-URL remote access for the Web GUI: a Cloudflare quick tunnel that
 * publishes the loopback server over HTTPS, plus the terminal QR code that
 * carries the authenticated URL to a phone.
 *
 * The tunnel dials this process's loopback listener, so the deployment keeps
 * binding `127.0.0.1` and never exposes a bare socket to the network. The
 * public hostname Cloudflare assigns is unknowable before the tunnel
 * connects, so the caller registers it on the /api Host fence once the URL is
 * known (see `HostConnectionHandle.addTrustedAuthority`). The URL is the whole
 * credential carrier: it carries this process's launch token, so anyone
 * holding it can drive the session until the process exits.
 *
 * The connector prints its assigned hostname before Cloudflare has published
 * the edge record for it, so a hostname alone is not yet an origin a phone can
 * open. {@link startQuickTunnel} therefore holds the published URL for a short
 * grace period before answering, which is what keeps the printed QR code
 * scannable. That wait is deliberately a timer rather than a reachability
 * probe: `trycloudflare.com` publishes a 1800-second negative TTL, so any DNS
 * lookup issued before the record exists is cached as NXDOMAIN by the
 * operator's own resolver and then outlives the record it wrongly denies —
 * including for the browser that scans the code. A tunnel that breaks the
 * operator's DNS is not a working tunnel, so this module never resolves the
 * public name.
 * @module @deepseek-ai/dsh-web-app/remote-access
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { renderUnicodeCompact } from 'uqr'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

/** Hostname Cloudflare assigns to an unauthenticated quick tunnel. */
const QUICK_TUNNEL_ORIGIN_PATTERN = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/u

/** Default wait for the connector to publish an assigned hostname. */
const DEFAULT_START_TIMEOUT_MS = 30_000

/**
 * Default grace between the connector publishing a hostname and this process
 * showing the URL. It covers Cloudflare creating the edge record; measured
 * gaps were 3-5s, and this leaves margin without a DNS lookup, which the
 * module header explains must not happen here.
 */
const DEFAULT_PUBLICATION_GRACE_MS = 8_000

/** Retained connector diagnostics, long enough to name a startup failure's cause. */
const DIAGNOSTIC_LIMIT = 4_000

/** Number of trailing diagnostic lines quoted in a failure message. */
const DIAGNOSTIC_LINES = 3

/** Live quick tunnel publishing one loopback origin. */
export interface QuickTunnel {
  /** Public HTTPS origin Cloudflare assigned, without a trailing slash. */
  readonly origin: string
  /** Authority for the /api Host fence: the origin's `host` (host:port). */
  readonly authority: string
  /** Stop the connector and release the public hostname; idempotent. */
  close(): Promise<void>
}

/** Startup inputs for {@link startQuickTunnel}. */
export interface QuickTunnelOptions {
  /** Loopback origin to publish, such as `http://127.0.0.1:3080`. */
  readonly target: string
  /** `cloudflared` executable name or absolute path. */
  readonly executable: string
  /** Milliseconds to wait for the connector to publish a hostname. @default 30000 */
  readonly timeoutMs?: number
  /** Milliseconds to hold the published URL for Cloudflare's edge record. @default 8000 */
  readonly publicationGraceMs?: number
  /** Observe connector termination after a successful start. */
  readonly onExit?: (code: number | null) => void
}

/**
 * Render one URL as a compact terminal QR code.
 *
 * Half-block characters keep the code two module rows per text row, so a
 * token-bearing tunnel URL stays within a normal terminal's height, and the
 * code carries no colour dependency that a differently themed terminal could
 * invert into an unscannable image.
 * @param text - the exact URL to encode.
 * @returns the QR code as newline-separated text rows.
 */
export function renderTerminalQr(text: string): string {
  return renderUnicodeCompact(text)
}

export function startQuickTunnel(options: QuickTunnelOptions): Promise<QuickTunnel> {
  const {
    target,
    executable,
    timeoutMs = DEFAULT_START_TIMEOUT_MS,
    publicationGraceMs = DEFAULT_PUBLICATION_GRACE_MS,
  } = options
  return new Promise<QuickTunnel>((resolve, reject) => {
    const child = internals.spawnTunnel(executable, target)
    // Connector output is drained for the whole run: an unread pipe would fill
    // and block cloudflared once its own logging outpaces this reader.
    let diagnostics = ''
    let settled = false
    /** Set when the connector publishes; `claim()` clears it with the deadline. */
    let graceTimer: NodeJS.Timeout | undefined

    const tail = (): string =>
      diagnostics.trim().split('\n').slice(-DIAGNOSTIC_LINES).join(' ')

    /** Claim the single settlement, cancelling every timer it no longer needs. */
    const claim = (): boolean => {
      if (settled) return false
      settled = true
      clearTimeout(timer)
      clearTimeout(graceTimer)
      return true
    }

    // Stays attached after the deadline or a successful start: Node throws when
    // an 'error' event has no listener, so detaching it would turn a later
    // connector failure into an uncaught exception in this process.
    const onError = (error: Error): void => {
      if (!claim()) return
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `the ${JSON.stringify(executable)} executable was not found; install cloudflared or pass --cloudflared <path>`
        : error.message
      reject(new Error(`remote access could not start because ${reason}`))
    }
    // Also stays attached: a connector that dies after a successful start takes
    // the public URL with it, and the caller hears about it through `onExit`.
    const onExit = (code: number | null): void => {
      if (!claim()) {
        options.onExit?.(code)
        return
      }
      const detail = tail()
      reject(new Error(
        `cloudflared exited with code ${String(code)} before publishing a URL${detail === '' ? '' : `: ${detail}`}`,
      ))
    }

    const onData = (chunk: string): void => {
      if (settled) return
      diagnostics = (diagnostics + chunk).slice(-DIAGNOSTIC_LIMIT)
      const found = QUICK_TUNNEL_ORIGIN_PATTERN.exec(diagnostics)
      if (found === null) return
      const origin = found[0]
      // Hold the answer for the publication grace period, then report the origin
      // whatever Cloudflare has done with it: the tunnel exists, and a caller
      // that showed nothing would be strictly less useful than one that shows a
      // URL which may need a moment.
      graceTimer = setTimeout(() => {
        /* v8 ignore next -- claim() clears this timer, so the callback is
        already dequeued only when settlement lands in the same tick that expires
        it; clearing cannot recall a queued callback, and without this guard that
        race would resolve a tunnel the failure already rejected. */
        if (!claim()) return
        resolve({ origin, authority: new URL(origin).host, close: () => closeTunnel(child) })
      }, publicationGraceMs)
      graceTimer.unref()
    }
    const timer = setTimeout(() => {
      /* v8 ignore next -- the deadline callback is already dequeued only when
      publication lands in the same tick that expires the deadline; clearing the
      timer cannot recall it, and without this guard that race would destroy a
      tunnel that had just become live. */
      if (!claim()) return
      const detail = tail()
      void closeTunnel(child)
      reject(new Error(
        `cloudflared published no URL within ${String(timeoutMs)}ms${detail === '' ? '' : `: ${detail}`}`,
      ))
    }, timeoutMs)
    timer.unref()

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', onError)
    child.on('exit', onExit)
  })
}

/** Stop one connector and settle when it has released its hostname. */
function closeTunnel(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    child.once('exit', () => { resolve() })
    child.kill('SIGTERM')
  })
}

/** Spawn the connector, keeping the run non-interactive and self-updating off. */
function spawnTunnel(executable: string, target: string): ChildProcess {
  // A scrubbed environment keeps Harness credentials out of the connector.
  return spawn(executable, [
    'tunnel',
    '--url', target,
    '--no-autoupdate',
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** Test hooks; production never mutates them. */
export const internals: {
  spawnTunnel: (executable: string, target: string) => ChildProcess
} = { spawnTunnel }
