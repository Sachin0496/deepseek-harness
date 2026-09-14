---
description: "dsh 的浏览器 GUI：交互式聊天、模型与设置管理、会话历史，供用户运行 dsh web 表层。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-web-app

[English](README.md) | 中文

## 概述

运行 `dsh --profile web`，界面会在你的默认浏览器中打开，即可与 agent（智能体）交互式聊天。你会获得会话视图、模型与设置管理以及会话历史，背后与其他表层相同的模型访问、工具与安全默认值。该命令会打印带 token 的启动 URL；浏览器用该 token 换取签名会话 cookie，再重定向到干净的根 URL。你可以从命令行更改端口、关闭浏览器交接并允许额外主机；有意不支持绑定所有网络接口。需要浏览器中的交互式工作时选择它；`dsh-headless` 是一次性的命令行兄弟表层。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

启动 GUI、打开浏览器，然后开始与 agent（智能体）对话。flag 用于微调本次调用。

### 启动 Web GUI

```sh
dsh --profile web
dsh --profile web --no-open --port 8080
```

启动后你会看到 `dsh web:` 行，其根 URL 携带新的进程 token。除非 `--no-open` 或 SSH 会话抑制，否则默认浏览器会打开该 URL、取得签名 cookie，再重定向到干净的根页面。页面加载且你可以与 agent（智能体）对话，就说明成功了。两种可预期的失败：前端未构建时，启动会以构建提示停止（checkout 中运行 `pnpm run build`）；浏览器无法打开时，stderr 会打印不含凭据的诊断，但服务器会继续运行——请自行打开已打印的启动 URL。

### 配置

大多数用户不需要设置这些；命令行 flag 会提供给下面的设置——`--host`、`--port`、`--trusted-host`、`--remote`、`--cloudflared` 与 `--no-qr` 来自本次调用，`--no-open` 仅对本次调用关闭浏览器交接：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `openBrowser` | `true` | 启动后用默认浏览器打开；SSH 启动会抑制它 |
| `printUrl` | `true` | 启动时打印 `dsh web:` URL 行 |
| `surfaceContext` | `true` | 给 agent（智能体）提供 GUI 定位上下文，并把 `DSH_WEB_URL` 暴露给其 shell 命令 |
| `trustedHosts` | `[]` | 允许从网络访问 GUI 的额外主机 |
| `remote` | `false` | 通过 Cloudflare 快速隧道发布回环 GUI |
| `cloudflared` | `cloudflared` | `remote` 运行的连接器可执行文件 |
| `printQr` | `true` | 为公网远程 URL 打印二维码 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)是每个受支持字段及其 JSDoc 的穷尽式真源。

### LAN 访问与可信主机

默认情况下 GUI 只接受本机的连接。绑定所有网络接口的部署也会允许 LAN 内的浏览器访问，此时打印的 URL 会附带一个 LAN 地址；`--trusted-host` 在两种情况下都能添加额外主机。Host 与 Origin 检查控制可达性，token 交换则认证每个 Host API 方法与 WebSocket stream。LAN 地址只在启动时采样一次，因此之后的网络变化不会被感知——重启 GUI 以重新公告。

### 从其他网络访问 GUI

`--remote` 通过 Cloudflare 快速隧道发布回环监听，使蜂窝网络上的手机也能访问会话，而无需 GUI 绑定公网接口，也无需开放端口。隧道连接后，启动输出会多出一行 `dsh web: remote https://<分配的主机>/?token=...`；除非用 `--no-qr` 关闭，还会打印编码该 URL 的二维码。扫码即可打开会话，令牌交换已经完成。

```sh
dsh --profile web --remote
```

这两行都只在连接器报出主机名之后经过一小段宽限期才出现，而不是它刚打印时。Cloudflare 会在数秒之后才为全新的快速隧道主机名创建边缘记录，在这个窗口内显示的二维码扫出来是浏览器的 DNS 失败（`DNS address could not be found`），而不是会话。这段等待刻意用计时器而非可达性探测：`trycloudflare.com` 的否定 TTL 为 1800 秒，因此在记录存在之前发出的 DNS 查询会被本机自己的解析器缓存为 NXDOMAIN，并在它所错误否认的记录之后仍然存续——这会让扫码的浏览器彻底连不上。若连接器在这段窗口内退出，启动会报告该情况并继续在回环上提供服务。

该 URL 的行为由三点决定：

- **URL 就是凭据。** 它携带本进程的启动令牌，该令牌按进程铸造且从不持久化，因此任何持有该 URL 的人都能在进程退出前驱动会话。请谨慎分享，并把打印出的二维码视作同一份密钥。
- **它随进程失效。** 隧道（以及公网主机名）属于本次调用；Cloudflare 快速隧道每次启动都会分配新的随机主机名，因此上一次运行的 URL 无法接入新的进程。
- **GUI 仍然只绑定回环。** 连接器拨号 `127.0.0.1`，因此公网名称只作为单个权威被 `/api` 栅栏接纳，其他所有非回环 Host 仍被拒绝。`--remote` 因此不需要 `--host 0.0.0.0`，后者依旧被拒绝，因为它会刻意暴露原始端口。

连接器必须已安装（`brew install cloudflared`，或 `PATH` 中任意 `cloudflared`；`--cloudflared <path>` 可指定明确的路径）。如果它缺失或连接失败，运行会在 stderr 上说明原因，并继续以回环方式服务，而不是拒绝启动。

### 通过 SSH 运行

通过 SSH 启动 `dsh --profile web` 时，URL 行仍会打印，但不会为你打开浏览器：本地转发地址由 SSH 客户端或编辑器持有。请在自己的机器上打开转发后的 URL；打印出的 URL 指向远端宿主机 loopback 端点。在 SSH 场景下，`--remote` 正是让无法使用该转发的设备访问 GUI 的方式。

### 按会话的 agent 设置

每个浏览器会话都从随发行版交付的 preset（默认 `standard`）组合自己的 agent（智能体），而不是共享一套进程级工具集。你可以更改默认 preset，或在 `$DSH_HOME/.agent-presets` 下添加自己的 preset。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本组合包是一份 patch 加一个运行时粘合插件。patch 重述 base 刻意省略的表层专属值，插入仅 Web 使用的宿主行与浏览器名录，然后把 agent 层移到 preset 之后；粘合插件负责 dist 服务、信任采样、提示词段落、bash 变量与就绪宣告。

### patch 语义

patch 会替换目标行的整个 `config`，因此每个 Web 行都重述自己拥有的每个键：基础行上的 persona、`DSH_TOOLS_MODE` PTC mode 开关与 `session-query-sqlite` 值，随后 `insert` 添加 Web 宿主行、传输层与浏览器名录。base 以进程级挂载的按 agent 工具行在这里被禁用，由 preset 名录接管；每项宿主层与 preset 层归属决策的理由以行内注释写在 patch 里。

### 就绪宣告

URL 行与浏览器交接都是就绪信号：监督方一观察到该行就发起 RPC，浏览器一打开就请求页面，因此两者只在 Loader 配置树结算且 Connection 认证可用后运行——在没有 Loader 的手工构建树中则立即运行。启动中途被释放的树不会宣告任何内容。

### LAN 信任采样

`resolveLanTrust` 在启动时只采样一次网络：loopback 绑定（`127.0.0.1`）不派生任何 LAN 地址，绑定所有网卡则会加入每个非 internal IPv4 字面量。派生字面量加上显式的 `--trusted-host` 权威标识组成 `/api` 浏览器信任栅栏，打印的 LAN URL 始终与该栅栏一致。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `web-app` 粘合插件：dist 解析、LAN 信任采样、提示词段落、bash 变量、URL 行、浏览器交接、远程隧道 |
| [`src/startup.ts`](src/startup.ts) | `web-startup` 提供方：`--host`、`--port`、`--trusted-host`、`--no-open`、`--remote`、`--no-qr`、`--cloudflared`、`--help` |
| [`src/remote-access.ts`](src/remote-access.ts) | Cloudflare 快速隧道连接器与终端二维码渲染 |
| [`cordis.patch.yml`](cordis.patch.yml) | Web patch：重述的基础值、Web 宿主行、浏览器名录、preset 之后的 agent 层 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件：无运行时不变式；每项贡献都由 registry 释放 |
| [`tests/web-app.spec.ts`](tests/web-app.spec.ts) | dist 解析、fallback 席位、提示词段落、就绪宣告 |
| [`tests/web-app-remote.spec.ts`](tests/web-app-remote.spec.ts) | 远程发布、栅栏准入与隧道失败处理 |
| [`tests/startup.spec.ts`](tests/startup.spec.ts) | 在真实 Loader 树上的命令行解析 |
| [`tests/trusted-hosts.spec.ts`](tests/trusted-hosts.spec.ts) | LAN 信任采样 |
| [`tests/remote-access.spec.ts`](tests/remote-access.spec.ts) | 隧道连接器生命周期、源捕获与失败路径 |
| [`tests/browser-open.spec.ts`](tests/browser-open.spec.ts) | 页面可达后的默认浏览器交接 |

### 不变式归属

不变式伴生插件注册一个空安装器，因为每项贡献——frontend-static 子插件、提示词段落与 bash 变量注册——都会随 fiber 由 registry 释放，且每个所属 registry 的包负责该关系的不变式。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当你想深入了解共享核心、浏览器重载流水线或已构建的前端时，阅读以下页面。

- [组合包包映射](../README.zh.md)——基于同一核心构建的表层。
- [dsh-base](../base/README.zh.md)——GUI 运行其上的共享核心。
- [dsh-client-hmr](../../client/hmr/README.zh.md)——开发期间客户端插件变更如何重载。
- [frontend-static](../../host/frontend-static/README.zh.md)——已构建的前端如何被服务。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-app)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### Harness 源码与 Web 表层上下文

#### 模型看到什么

当 `surfaceContext` 为 true 时，`harness:source` 段落标明磁盘上的 Harness 实现，但不会声称它就是工作目录；全局段落 `app:web-surface`（first-party 顺序 −800）则向模型说明 GUI：规范的本地 URL、「this page」指代什么、更新约定（重载接收端始终开启；无刷新重载还需要 `pnpm run dev:web` watcher），以及不要启动替代服务器的指令。`DSH_WEB_URL` 还会连同描述出现在受管 bash 环境中，每次调用时从运行中的服务器解析。当它为 false 时，这两个段落和该变量都不会注册。

#### Token 影响

每个会话一行源码说明和一段提示词，外加两行受管环境变量；每个进程内保持恒定。

#### KV Cache 影响

该提示词段落位于系统提示词靠前位置，且在进程整个生命周期内稳定（端口是启动期事实），因此不会使跨轮次缓存失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制告诉你在不常见的环境下会遇到什么——源码 checkout、SSH 会话或严格网络。它们是当前包约束，不是通用的浏览器对比或任务积压。

- **前端必须已构建**——源码 checkout 需要先运行 `pnpm run build`；dist 缺失时启动会以构建提示停止，且没有从源码直接服务的回退路径。
- **LAN 地址只在启动时采样一次**——启动后的网卡变化不会重新公告；打印的 LAN URL 始终与采样结果一致。
- **只能观察到交接的启动**——GUI 只报告浏览器被请求打开，而不是它确实打开了；之后的浏览器退出永远不会上报，打印的 URL 是你的手动回退路径。
- **SSH 会话保留 URL 但跳过浏览器交接**——打印的 URL 指向远端宿主机 loopback 端点；SSH 客户端或编辑器必须暴露并打开本地转发地址。
- **`BROWSER` 覆盖只能来自环境**——被发现的 `.env` 不能设置 `BROWSER`；只有继承值能为自动交接选择可执行文件。
- **不支持绑定所有网络接口**——出于安全考虑，`--host 0.0.0.0` 会在启动时被拒绝；请使用默认 loopback 主机，或用 `--remote` 发布一个经 TLS 终结的公网 URL。
- **远程 URL 是持有者凭据**——它携带进程启动令牌，因此任何持有它的人都能在进程退出前驱动会话。它不是按设备发放的凭据，GUI 也无法在不结束本次运行的情况下撤销某个 URL。
- **快速隧道在边缘是公开且未经认证的**——Cloudflare 的快速隧道主机名随机且短命，但守护会话的只有 URL 中的令牌；需要更强控制的部署应使用自带认证的隧道或反向代理挡住回环监听，并用 `--trusted-host` 声明该主机名。
- **快速隧道每次启动都分配新主机名**——一次运行得到的 URL 与二维码无法接入下一次运行的隧道。
- **隧道的可用性取决于连接器**——`cloudflared` 退出，或网络封锁隧道，都会使公网 URL 失效，而回环 GUI 仍在服务。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
