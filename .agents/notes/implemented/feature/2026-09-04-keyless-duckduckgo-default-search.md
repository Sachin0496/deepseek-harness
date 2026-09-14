# Agent Note: Keyless DuckDuckGo default search

Status: implemented

English | [中文](2026-09-04-keyless-duckduckgo-default-search.zh.md)

## Problem

The shipped base composition pinned `web_search` to the DeepSeek search provider, so every search cost a full auxiliary model turn and failed without a `DEEPSEEK_API_KEY` credential — a model-visible tool that only works after key setup. Users arriving from CLIs with parallel multi-query search expect fan-out to work with no account and no per-search model cost.

## Decision

The base bundle (`packages/bundle/base/cordis.patch.yml`) pins `searchProvider: duckduckgo` and mounts `@deepseek-ai/dsh-web-search-duckduckgo`, a keyless provider over DuckDuckGo's HTML endpoint. `dsh-web-search-deepseek` remains a working package but leaves the default composition; its config, tests, and docs are unchanged. The provider exposes only `baseURL` config (with a `$DUCKDUCKGO_BASE_URL` fallback); `available()` is a local URL parse, never a network call. The parallel multi-query fan-out in `dsh-tool-web` is untouched — each query becomes one seam request through whichever provider is selected, so parallel search runs against the free backend with no tool change.

## Request and mapping

`search()` issues a keyless `GET {baseURL}/html/?q=...` with `redirect: 'error'`, splits the HTML on result containers, unwraps `/l/?uddg=` hrefs to canonical URLs, and returns `{ sources, truncated: false }` with no `content`. Tags strip before entities decode so a decoded literal never reads as markup; duplicate URLs collapse to first occurrence; a no-results page resolves to an empty source list that `dsh-tool-web` renders as `No results found.`

## Alternatives considered

**Keep DeepSeek as the default and add DuckDuckGo as opt-in.** Rejected: the default path still needs a key and spends a model turn per search, leaving the free backend unused in most deployments.

**Default to Exa or Perplexity.** Rejected: both need paid API keys, so the default composition still fails without credentials — the same setup cliff under a different vendor.

**Drive search through ego-browser automation.** Rejected: a browser tab per search is slower, flakier, and borrows user browsing state; HTTP retrieval is the right default while the installed browser stays available for automation the provider cannot do.

**Drop snippet-less results like Exa does.** Rejected: Exa drops them because highlights are its portability contract; DuckDuckGo excerpts are best-effort text, so dropping would discard citeable URLs for no fidelity gain.

## Consequences

`web_search` works in a fresh checkout with no credentials and no per-search model cost. The trade costs a generated answer (`content` unset), publication dates, and recency/retrieval controls, and parsing tracks DuckDuckGo's HTML class names — a markup redesign empties results until the parser follows. Deployments holding Exa, Perplexity, or DeepSeek keys pin `searchProvider` to that backend; the removed 60s base timeout override returns `tool-web` to its 30s default now that search is no longer a full model turn.

## Testing

`packages/web/web-search-duckduckgo/tests/duckduckgo.spec.ts` pins redirect unwrapping, entity decoding, dedupe, the keyless GET shape, `WEB_ABORTED`/`WEB_PROVIDER_ERROR` routing, and HMR-safe registration. The base-bundle, `dsh-tool-web`, and `dsh-web` suites cover the rewiring.
