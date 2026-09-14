# Agent Note：无需密钥的 DuckDuckGo 默认搜索

Status: implemented

[English](2026-09-04-keyless-duckduckgo-default-search.md) | 中文

## 问题

随附的 base 组合把 `web_search` 固定在 DeepSeek 搜索提供方上，因此每次搜索都消耗一个完整的辅助模型轮次，且在没有 `DEEPSEEK_API_KEY` 凭据时直接失败——一个需要先配置密钥才能工作的面向模型工具。从带有并行多查询搜索的 CLI 过来的用户，期望扇出无需账号、无需单次搜索的模型成本即可工作。

## 决策

base bundle（`packages/bundle/base/cordis.patch.yml`）固定 `searchProvider: duckduckgo` 并挂载 `@deepseek-ai/dsh-web-search-duckduckgo`，即构建于 DuckDuckGo HTML 端点之上的无密钥提供方。`dsh-web-search-deepseek` 仍是可用的包，但退出默认组合；其配置、测试与文档保持不变。本提供方只暴露 `baseURL` 配置（带 `$DUCKDUCKGO_BASE_URL` 回退）；`available()` 只是本地 URL 解析，绝不发起网络调用。`dsh-tool-web` 中的并行多查询扇出保持不动——每个查询对应一次经过所选提供方的 seam 请求，因此并行搜索无需任何工具改动即可跑在免费后端上。

## 请求与映射

`search()` 以无密钥 `GET {baseURL}/html/?q=...` 请求并带 `redirect: 'error'`，按结果容器切分 HTML，把 `/l/?uddg=` href 还原为规范 URL，并返回 `{ sources, truncated: false }` 且无 `content`。标签先剥离、实体后解码，因此解码后的字面量不会被误读为标记；重复 URL 折叠为首现位置；无结果页面解析为空来源列表，`dsh-tool-web` 把它渲染为 `No results found.`。

## 曾考虑的替代方案

**保留 DeepSeek 为默认，把 DuckDuckGo 作为可选项。** 已拒绝：默认路径仍然需要密钥且每次搜索消耗一个模型轮次，免费后端在多数部署中会被闲置。

**默认使用 Exa 或 Perplexity。** 已拒绝：两者都需要付费 API 密钥，默认组合在没有凭据时依然失败——只是换了厂商的同一道配置门槛。

**用 ego-browser 自动化驱动搜索。** 已拒绝：每次搜索占用一个浏览器标签页更慢、更不可靠，还会借用用户的浏览状态；HTTP 检索是正确的默认，而已安装的浏览器仍可用于提供方做不到的自动化。

**像 Exa 那样丢弃无摘录结果。** 已拒绝：Exa 丢弃它们是因为高亮是其可移植性约定；DuckDuckGo 摘录只是尽力而为的文本，丢弃只会白白丢掉可引用的 URL，没有任何保真度收益。

## 后果

`web_search` 在全新 checkout 中无需凭据即可工作，且没有单次搜索的模型成本。代价是没有生成答案（`content` 未设置）、没有发布日期、没有时效／检索控制，且解析跟踪 DuckDuckGo 的 HTML 类名——标记改版会使结果为空，直到解析器跟进。持有 Exa、Perplexity 或 DeepSeek 密钥的部署把 `searchProvider` 固定到对应后端即可；移除 base 的 60s 超时覆盖后，`tool-web` 回到 30s 默认值，因为搜索不再是一个完整的模型轮次。

## 测试

`packages/web/web-search-duckduckgo/tests/duckduckgo.spec.ts` 锁定跳转还原、实体解码、去重、无密钥 GET 形态、`WEB_ABORTED`／`WEB_PROVIDER_ERROR` 路由与 HMR 安全注册。base bundle、`dsh-tool-web` 与 `dsh-web` 套件覆盖本次接线变更。
