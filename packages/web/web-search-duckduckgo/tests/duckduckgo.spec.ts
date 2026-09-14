import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import { DuckDuckGoSearchProvider, DUCKDUCKGO_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-duckduckgo'
import * as duckduckgoPlugin from '@deepseek-ai/dsh-web-search-duckduckgo'
import { parseDuckDuckGoHtml } from '../src/provider.ts'

const options = { baseURL: 'https://html.duckduckgo.test' }

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

const FIXTURE = `
<html><body>
<div class="result results_links">
<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage&amp;rut=abc">A <b>Title</b></a></h2>
<a class="result__snippet" href="https://a.test/page">first &amp; salient excerpt</a>
</div>
<div class="result results_links">
<h2 class="result__title"><a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fb.test%2F">B Title</a></h2>
</div>
<div class="result results_links">
<h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.test%2Fpage&amp;rut=abc">A Title again</a></h2>
<a class="result__snippet" href="https://a.test/page">duplicate</a>
</div>
</body></html>
`

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('DuckDuckGo HTML parsing', () => {
  it('unwraps redirect hrefs and pairs titles with excerpts', () => {
    expect(parseDuckDuckGoHtml(FIXTURE)).toEqual([
      { url: 'https://a.test/page', title: 'A Title', snippet: 'first & salient excerpt' },
      { url: 'https://b.test/', title: 'B Title' },
    ])
  })

  it('keeps snippet-less results (the excerpt is best-effort, not a portability rule)', () => {
    expect(parseDuckDuckGoHtml(FIXTURE)[1]).toEqual({ url: 'https://b.test/', title: 'B Title' })
  })

  it('deduplicates by URL to first occurrence', () => {
    const urls = parseDuckDuckGoHtml(FIXTURE).map(source => source.url)
    expect(urls).toEqual([...new Set(urls)])
  })

  it('drops blocks without a usable http(s) URL', () => {
    const html = `
      <div class="result"><a class="result__a" href="javascript:void(0)">Nope</a></div>
      <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=ftp%3A%2F%2Ffiles.test%2F">Files</a></div>
      <div class="result"><a class="result__a" href="https://ok.test/">Ok</a></div>
    `
    expect(parseDuckDuckGoHtml(html)).toEqual([{ url: 'https://ok.test/', title: 'Ok' }])
  })

  it('decodes entities without letting decoded literals read as markup', () => {
    const html = `
      <div class="result">
        <a class="result__a" href="https://e.test/">a &lt;b&gt; &amp; &#x41;&#66;</a>
        <a class="result__snippet" href="https://e.test/">x&nbsp;y</a>
      </div>
    `
    expect(parseDuckDuckGoHtml(html)).toEqual([
      { url: 'https://e.test/', title: 'a <b> & AB', snippet: 'x y' },
    ])
  })

  it('returns no sources for a no-results page', () => {
    expect(parseDuckDuckGoHtml('<html><body><div class="no-results">No results.</div></body></html>')).toEqual([])
  })
})

describe('DuckDuckGoSearchProvider availability', () => {
  it('is available without any credential', () => {
    expect(new DuckDuckGoSearchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(new DuckDuckGoSearchProvider({ baseURL: 'not a url' }).available()).toBe(false)
  })
})

describe('DuckDuckGoSearchProvider request mapping', () => {
  it('issues a keyless GET with redirect rejection', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(FIXTURE))
    vi.stubGlobal('fetch', fetchMock)

    const result = await new DuckDuckGoSearchProvider(options).search({ query: 'hello world', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://html.duckduckgo.test/html/?q=hello%20world')
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(init.headers).toMatchObject({ accept: 'text/html' })
    expect(init.headers).not.toHaveProperty('authorization')
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test/page', title: 'A Title', snippet: 'first & salient excerpt' },
        { url: 'https://b.test/', title: 'B Title' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(''))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new DuckDuckGoSearchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('throws WEB_ABORTED when already aborted before dispatch', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(''))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('gone'))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('DuckDuckGoSearchProvider error handling', () => {
  it('maps an HTTP error to WEB_PROVIDER_ERROR with the status line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 429 })))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'DuckDuckGo API error (HTTP 429)' }))
  })

  it('rejects a redirect without contacting the target', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 302, headers: { location: 'https://evil.test/' } }))
    vi.stubGlobal('fetch', fetchMock)
    // The harness client fails `redirect: 'error'` responses before following them;
    // a provider that receives one surfaces it as a provider error, never a fetch of `evil.test`.
    await expect(new DuckDuckGoSearchProvider({ baseURL: 'https://html.duckduckgo.test' }).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-duckduckgo plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('')))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(duckduckgoPlugin, {})
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in duckduckgoPlugin).toBe(false)
  })

  it('honors a baseURL override from config', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(''))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(duckduckgoPlugin, { baseURL: 'https://ddg.mirror.test' })
    await ctx.web.search({ query: 'q' })
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe('https://ddg.mirror.test/html/?q=q')
    await fiber.dispose()
  })
})
