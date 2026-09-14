/**
 * `DuckDuckGoSearchProvider`: a keyless `WebSearchProvider` over DuckDuckGo's HTML
 * endpoint (`GET {baseURL}/html/?q=...`). It unwraps `/l/?uddg=` redirect hrefs to
 * canonical URLs, keeps snippet-less results (the excerpt is best-effort text, not a
 * portability requirement), and omits `content` because the endpoint returns no
 * generated answer.
 * @module @deepseek-ai/dsh-web-search-duckduckgo/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under. */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'

/** Default HTML endpoint base; `/html/` is the operation. */
export const DUCKDUCKGO_DEFAULT_BASE_URL = 'https://html.duckduckgo.com'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/** Resolved provider options (the plugin's `apply` supplies env-var and constant defaults). */
export interface DuckDuckGoSearchProviderOptions {
  /** Endpoint base; `/html/` is appended. */
  baseURL: string
}

/**
 * Strip markup tags from an HTML fragment. Runs before entity decoding so a
 * decoded literal (for example `&lt;b&gt;`) survives as text.
 *
 * @param fragment - raw inner HTML.
 * @returns the fragment with every `<...>` tag removed.
 */
function stripTags(fragment: string): string {
  return fragment.replace(/<[^>]*>/g, '')
}

/**
 * Decode the entities DuckDuckGo emits in titles and excerpts: the five named
 * references plus decimal and hexadecimal numeric references.
 *
 * @param text - tag-free text possibly containing entity references.
 * @returns the decoded text.
 */
function decodeEntities(text: string): string {
  return text
    .replace(/&(amp|lt|gt|quot|nbsp);/gi, (match) => {
      switch (match.toLowerCase()) {
        case '&amp;': return '&'
        case '&lt;': return '<'
        case '&gt;': return '>'
        case '&quot;': return '"'
        case '&nbsp;': return ' '
        default: return match
      }
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
}

/**
 * Normalize one `result__a` href to a citeable absolute URL. DuckDuckGo serves
 * redirect hrefs (`/l/?uddg=<percent-encoded-target>&...` or protocol-relative
 * variants); the `uddg` parameter is the actual result URL. Returns `undefined`
 * for hrefs that do not resolve to an `http(s)` URL.
 *
 * @param href - the raw anchor href.
 * @returns the canonical result URL, or `undefined` when unusable.
 */
function normalizeResultHref(href: string): string | undefined {
  const raw = href.trim()
  if (raw.length === 0) return undefined
  try {
    const parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com')
    const target = parsed.searchParams.get('uddg') ?? parsed.toString()
    const final = new URL(target)
    if (final.protocol !== 'http:' && final.protocol !== 'https:') return undefined
    return final.toString()
  } catch {
    // A malformed href or a non-absolute unwrapped target: the block carries no
    // citeable URL, so the caller drops it.
    return undefined
  }
}

/**
 * Parse a DuckDuckGo HTML response into normalized sources. The page is split on
 * result containers and each block contributes its first `result__a` anchor (the
 * citeable URL plus title) with the block's `result__snippet` excerpt when one is
 * present. Blocks without a usable URL are dropped; duplicates collapse to first
 * occurrence.
 *
 * @param html - the raw HTML response body.
 * @returns the parsed sources in page order.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const seen = new Set<string>()
  const blocks = html.split(/<div[^>]*class="result[\s"]/i)
  for (const block of blocks) {
    const anchor = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (anchor?.[1] === undefined) continue
    const url = normalizeResultHref(anchor[1])
    if (url === undefined || seen.has(url)) continue
    const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block)
    const title = decodeEntities(stripTags(anchor[2] ?? '')).replace(/\s+/g, ' ').trim()
    const snippet = snippetMatch?.[1] === undefined
      ? ''
      : decodeEntities(stripTags(snippetMatch[1])).replace(/\s+/g, ' ').trim()
    seen.add(url)
    sources.push({
      url,
      ...title.length > 0 ? { title } : {},
      ...snippet.length > 0 ? { snippet } : {},
    })
  }
  return sources
}

/** The DuckDuckGo-backed search provider; HTTP redirects fail as `WEB_PROVIDER_ERROR`. */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  constructor(private readonly options: DuckDuckGoSearchProviderOptions) {}

  available(): boolean {
    return URL.canParse(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    if (signal?.aborted === true) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: signal.reason })
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/html/?q=${encodeURIComponent(request.query)}`, {
        method: 'GET',
        redirect: 'error',
        headers: {
          'accept': 'text/html',
          'user-agent': USER_AGENT,
        },
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`DuckDuckGo search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw new WebError(`DuckDuckGo API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }

    try {
      const html = await response.text()
      // DuckDuckGo returns no generated answer, so `content` is omitted. The web
      // service owns the final `maxResults` truncation, so this provider reports
      // `truncated: false`.
      return { sources: parseDuckDuckGoHtml(html), truncated: false }
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`DuckDuckGo returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

/* jscpd:ignore-start */
/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
/* jscpd:ignore-end */
