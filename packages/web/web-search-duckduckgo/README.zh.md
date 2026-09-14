---
description: "基于 DuckDuckGo、无需密钥的 ctx.web 搜索提供方：部署方如何挂载开箱即用的免费 web 搜索。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-duckduckgo

[English](README.md) | 中文

## Summary

有了 `dsh-web-search-duckduckgo`，harness 可以通过 DuckDuckGo 的 HTML 端点搜索 web，无需 API 密钥、无需凭据接线。当部署希望开箱即用、无需申请任何密钥的 web 搜索时选择它：每个查询都是对已配置 HTML 端点的一次无密钥 `GET`，`dsh-tool-web` 中的多查询并行扇出在其之上原样运行——每个查询对应一次经过本提供方的 seam 请求，结果按轮询顺序合并。DuckDuckGo 不返回生成答案，因此结果不携带 `content`——只产出可引用的来源。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

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

在已加载 web 服务的组合中挂载本提供方；它以 `duckduckgo` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: duckduckgo` 固定。

### When to choose it

当部署希望使用免费、无需管理任何凭据的搜索时选择本后端。本提供方始终可用——除非端点 base 无法解析、网络失败，或 DuckDuckGo 更改了页面标记，每次搜索调用都会正常工作。

### Minimal configuration

加载 web 服务与本提供方即可；无需配置任何密钥，端点自带安全的默认值。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `https://html.duckduckgo.com` | 端点 base；会追加 `/html/`。无法解析的值会使提供方不可用。配置省略时 `$DUCKDUCKGO_BASE_URL` 覆盖默认值 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-duckduckgo)是每个受支持字段及其 JSDoc 的穷尽式真源。

### What a search returns

每项 DuckDuckGo 结果映射为 `WebSearchSource`：`url`（把 `/l/?uddg=` 跳转 href 还原为规范目标）、`title`，以及存在时的 `result__snippet` 摘录作为 `snippet`。没有摘录的结果会保留其 URL 而不是被丢弃，因为摘录只是尽力而为的文本，而非可移植性要求。DuckDuckGo 不返回生成答案，因此结果不携带 `content`。

### Failures and recovery

提供方失败——HTTP 错误、网络失败、响应体无法解析——以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。没有可解析结果的页面会解析为空来源列表，而不是错误——`dsh-tool-web` 会把它渲染为 `No results found.`。调用方按 code 路由；面向模型的 `web_search` 工具会在自己的错误包装层内把失败呈现给模型。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

本节解释本提供方背后的设计决策；可观察行为已在[Use this package](#use-this-package)中完整覆盖。

### Design philosophy

本提供方是 DuckDuckGo HTML 端点的薄适配层，有两条刻意的规则：

- **无凭据，无生成答案。** 无需置备任何东西，也不编造任何东西：`content` 直接省略，而不是伪造模型可能轻信的提供方文本。
- **保留可引用的内容。** 来源的 `snippet` 只来自真实摘录，但缺少摘录不会丢弃来源——URL 本身就是可引用的事实。

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、环境回退、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `DuckDuckGoSearchProvider`：请求派发、中止分类、HTML 解析 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴随件（无运行时不变式；契约由所属服务强制执行） |

### Request and mapping flow

`search()` 以无密钥 `GET` 请求 `{baseURL}/html/?q=<编码后查询>`，并带 `redirect: 'error'`，因此重定向会在访问目标之前使请求失败。响应 HTML 按结果容器切分；每个块贡献其首个 `result__a` 锚点（跳转 href 经 `uddg` 参数还原，锚文本作为标题），以及存在时的块内 `result__snippet` 摘录。标签先剥离、实体后解码，因此解码后的字面量不会被误读为标记；重复 URL 折叠为首现位置。最终 `maxResults` 上限由服务在返回途中执行。中止——名为 `AbortError` 的 `DOMException`，或入口处已中止的信号——成为 `WEB_ABORTED`；其他一律成为 `WEB_PROVIDER_ERROR`。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

当包级契约不够用时阅读这些页面。它们从共享词汇出发，通向服务、面向模型的工具与设计依据。

- [Web subsystem](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [Web package map](../README.zh.md)——家族与各自角色。
- [dsh-web](../web/README.zh.md)——本提供方注册到的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具，包括其并行多查询扇出。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-duckduckgo)——每个受支持配置字段及其源声明。
- [Web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共享一个提供方选择服务。

-----

<a id="model-experience"></a>
## Model Experience

通过 `dsh-tool-web` 间接作用于模型：它保留本提供方受 `maxResults` 约束的 URL、标题与摘录，或在消费者的错误包装层内保留其确切的 `DuckDuckGo search aborted`、`DuckDuckGo search request failed: <error>` 与 `DuckDuckGo API error (HTTP <status>)` 失败。

#### KV Cache effect

无直接失效；命名消费者拥有任何请求前缀变更。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了本提供方不适用的场景。它们是当前包约束。

- **结果解析跟踪 DuckDuckGo 的 HTML 类名**（`result`、`result__a`、`result__snippet`）——标记改版会使所有结果为空，直到解析器跟进。
- **无生成答案、无日期、无相关性控制**——HTML 端点不提供答案文本、发布日期、时效过滤或检索模式，因此 `content` 与 `publishedAt` 保持未设置。
- **缺少摘录不会丢弃来源**——与基于高亮的提供方不同，无摘录结果以纯 URL 保留，因此来源除了标题可能没有任何上下文。
- **中止分类基于错误形态**——只有名为 `AbortError` 的 `DOMException` 映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）以 `WEB_PROVIDER_ERROR` 呈现。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

本 Dev Note 是维护者的工作上下文：开放问题与未定方向。它明确非权威——已发布行为、限制与依据位于以上各节与链接的 Agent Notes。

#### Future: 结构化控制需要先有 seam 字段

时效、区域与安全搜索控制暂不暴露。暴露它们需要先有提供方中立的服务字段，以便家族一次增加一个协同控制，而不是厂商专有参数。

</details>
