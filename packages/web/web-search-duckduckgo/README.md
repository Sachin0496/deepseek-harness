---
description: "The DuckDuckGo-backed keyless search provider for ctx.web: how deployments mount free web search with no credential."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-duckduckgo

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-duckduckgo`, the harness searches the web through DuckDuckGo's HTML endpoint with no API key and no credential wiring. Choose it when a deployment wants web search that works out of the box: every query is one keyless `GET` against the configured HTML endpoint, and the multi-query parallel fan-out in `dsh-tool-web` runs unchanged on top of it — each query becomes one seam request through this provider and the results merge round-robin. DuckDuckGo returns no generated answer, so results carry no `content` — only citeable sources. The model-facing `web_search` tool lives in `dsh-tool-web`.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `duckduckgo` search provider, so `ctx.web.search()` resolves it automatically when it is the only usable search backend — or pin it with `searchProvider: duckduckgo`.

### When to choose it

Choose this backend when a deployment wants free search with no credential to manage. The provider is always available — every search call works unless the endpoint base does not parse, the network fails, or DuckDuckGo changes its markup.

### Minimal configuration

Load the web service and the provider; there is no key to configure, and the endpoint has a safe default.

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://html.duckduckgo.com` | Endpoint base; `/html/` is appended. An unparseable value makes the provider unavailable. `$DUCKDUCKGO_BASE_URL` overrides the default when config omits it |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-duckduckgo) is the exhaustive source for every accepted field and its JSDoc.

### What a search returns

Each DuckDuckGo result maps to a `WebSearchSource`: `url` (the `/l/?uddg=` redirect href unwrapped to its canonical target), `title`, and the `result__snippet` excerpt as `snippet` when one is present. A result without an excerpt is kept with its URL rather than dropped, because the excerpt is best-effort text rather than a portability requirement. DuckDuckGo returns no generated answer, so the result carries no `content`.

### Failures and recovery

Provider failures — HTTP errors, network failures, unparseable bodies — surface as `WebError` `WEB_PROVIDER_ERROR`; an aborted request surfaces as `WEB_ABORTED`. HTTP redirects are rejected before the `Location` target is contacted and surface as `WEB_PROVIDER_ERROR`. A page with no parseable results resolves to an empty source list, not an error — `dsh-tool-web` renders that as `No results found.` Callers route on the code; the model-facing `web_search` tool surfaces failures to the model under its own error wrapper.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is a thin adapter over DuckDuckGo's HTML endpoint with two deliberate rules:

- **No credential, no generated answer.** There is nothing to provision and nothing to invent: `content` is omitted rather than fabricating provider prose the model might trust.
- **Keep what cites.** A source gains a `snippet` only from a real excerpt, but a missing excerpt drops no source — the URL itself is the citeable fact.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, environment fallback, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `DuckDuckGoSearchProvider`: request dispatch, abort classification, HTML parsing |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; contracts are enforced at the service) |

### Request and mapping flow

`search()` issues a keyless `GET` to `{baseURL}/html/?q=<encoded-query>` with `redirect: 'error'`, so a redirect fails the request without contacting the target. The response HTML is split on result containers; each block contributes its first `result__a` anchor (the redirect href unwrapped via its `uddg` parameter, the anchor text as title) with the block's `result__snippet` excerpt when present. Tags are stripped before entities are decoded so a decoded literal never reads as markup; duplicate URLs collapse to first occurrence. The service applies the final `maxResults` bound on the way back. An abort — a `DOMException` named `AbortError`, or an already-aborted signal at entry — becomes `WEB_ABORTED`; anything else becomes `WEB_PROVIDER_ERROR`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive search request/result vocabulary and error codes.
- [Web package map](../README.md) — the family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_search` tool that renders this provider's sources, including its parallel multi-query fan-out.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-search-duckduckgo) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which retains this provider's `maxResults`-bounded URLs, titles, and excerpts or its exact `DuckDuckGo search aborted`, `DuckDuckGo search request failed: <error>`, and `DuckDuckGo API error (HTTP <status>)` failures under the consumer's error wrapper.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is a poor fit. They are current package constraints.

- **Result parsing tracks DuckDuckGo's HTML class names** (`result`, `result__a`, `result__snippet`) — a markup redesign can empty every result until the parser follows it.
- **No generated answer, no dates, no relevance controls** — the HTML endpoint exposes no answer text, publication dates, recency filter, or retrieval mode, so `content` and `publishedAt` stay unset.
- **A missing excerpt drops no source** — unlike highlight-backed providers, snippet-less results are kept URL-only, so sources can carry no context beyond the title.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (such as `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above and the linked Agent Notes.

#### Future: structured controls need seam fields first

Recency, region, and safe-search controls stay unexposed. Exposing them needs provider-neutral service fields first, so the family adds one coordinated control rather than a vendor-specific argument.

</details>
