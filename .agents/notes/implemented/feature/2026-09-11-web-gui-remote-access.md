# Agent Note: Remote access for the Web GUI

Status: implemented

English | [中文](2026-09-11-web-gui-remote-access.zh.md)

## Problem

The Web GUI serves one machine. `dsh web` binds `127.0.0.1` and prints a token-bearing URL that only a browser on that machine can open, and the one documented way to reach it from another device — `--host 0.0.0.0` — is refused at startup because a bare all-interfaces bind exposes unauthenticated remote code execution to the network. A user who wants to prompt the session from a phone, on a different network, has no supported route: SSH port forwarding needs a client on the phone, and the LAN URL that `resolveLanTrust` derives only exists for the all-interfaces bind that the CLI rejects.

The friction is not the URL itself but what surrounds it. Even with a reachable address, the user must transcribe a 400-character token-bearing URL onto a phone, and the `/api` fence refuses any Host authority the deployment did not declare before it bound.

## Decision

`dsh web` gains `--remote`, which publishes the loopback listener through a Cloudflare quick tunnel and prints the public URL with a terminal QR code.

`--remote` does not change the bind. The connector dials `http://127.0.0.1:<port>`, so the process keeps serving loopback only and the tunnel's TLS endpoint terminates the public side. This preserves the `--host 0.0.0.0` refusal rather than weakening it: the raw port is never exposed, and the only public entry point is an HTTPS origin with an authenticated edge.

The tunnel's public hostname is assigned when it connects, so no composition-time config can carry it. `HostConnectionService.addTrustedAuthority(authority)` extends the existing `/api` fence at runtime and returns a disposer. The adding path runs `assertTrustedAuthority` — the same validation the config boundary runs — so a malformed entry throws at the call instead of silently widening the grant, and added authorities pass the identical Host/Origin and browser-session rules as configured ones. They are not a weaker tier. `Client`-side `trustedHosts` stays a construction value; the runtime set lives only in the Host service.

`src/remote-access.ts` owns the connector. `startQuickTunnel` resolves after the connector prints its assigned hostname plus a publication grace period, and every failure path — missing executable, early exit, deadline — stops the connector before rejecting. Startup failure is reported on stderr and the run continues on loopback: losing the public URL must not cost the local session.

### Waiting without poisoning the operator's DNS

The connector prints its hostname before Cloudflare has an edge record for it — measured 3-5s — so a QR code shown at print time scans into the browser's `DNS address could not be found` page. The obvious fix, polling the origin until it answers, is worse than the bug. `trycloudflare.com` serves a **1800-second negative TTL**, so a lookup issued before the record exists is cached as NXDOMAIN by the operator's own resolver and then outlives the record it wrongly denies. A controlled experiment against live tunnels separated the paths:

| Polling path | Operator's resolver afterwards | HTTPS from the operator's machine |
|---|---|---|
| `dns.lookup` (the OS path browsers use) | `ENOTFOUND` — poisoned | fails |
| Direct query to a public resolver | resolves | answered `401` |

Polling through the OS resolver therefore does not merely fail to help; it breaks the tunnel on the machine that started it, for up to half an hour, and a restart does not clear it. `startQuickTunnel` consequently never resolves the public name: it holds the published URL for `publicationGraceMs` (default 8s, covering the measured gap) and reports it. The two facts stay separate — publication is the connector's success, resolvability belongs to Cloudflare — and a probe that can damage the operator's environment is not part of making the feature work.

A connector that dies during the grace period still rejects: its tunnel is gone, and handing out its URL would only mislead.

The URL is the credential. It carries the same per-process launch token the loopback URL carries, so `--remote` changes reachability, not authorization. The token is minted per process and never persisted, which is what makes the unauthenticated edge acceptable: the public hostname is random and short-lived, and the only thing guarding the session behind it is a secret the operator holds.

### What the operator sees

```
dsh web: http://127.0.0.1:3080/?token=…
dsh web: publishing through a Cloudflare quick tunnel; this takes a few seconds
dsh web: remote https://<assigned>.trycloudflare.com/?token=…
dsh web: that URL is the credential for this session; anyone holding it can drive it
<QR code>
dsh web: scan to open this session on another device
```

`--no-qr` suppresses the code; `--cloudflared <path>` names a connector outside `PATH`. These lines appear after the publication grace period, so the URL is scannable when it is shown.

## Alternatives considered

**Reuse `--host 0.0.0.0` with a trusted host.** The LAN path already exists and needs no dependency, but it fails the stated requirement: a phone on cellular data cannot route to a private LAN address, and the bind exposes the raw port with no TLS. It also contradicts an explicit refusal the CLI states in its own error text.

**Support Tailscale, ngrok, and cloudflared behind one flag.** Tailscale was installed and would have given a private mesh with a stable URL, which is the better security posture. It lost on setup cost against the user's stated goal: it needs a login on both the Mac and the phone before the first scan works, while a quick tunnel needs no account on either side. Choosing one transport also keeps the failure reporting single-shaped.

**Speak the tunnel protocol in-process instead of spawning a connector.** This would remove the external dependency and the child-process lifecycle. It lost because implementing WireGuard and the Cloudflare edge handshake is a large, security-critical surface that a maintained binary already owns, and the repo prefers maintained dependencies over hand-rolling when they delete owned code.

**Hand-roll the QR encoder.** It removes a dependency. It lost to `uqr` (pure ESM, zero dependencies, no CJS hazard under the source-launch tsx contract), because a QR encoder is arithmetic with no product-specific behavior and `renderUnicodeCompact` is exactly the needed terminal form.

**Print the QR code for the loopback or LAN URL.** It would avoid the tunnel entirely. It lost because neither address is reachable from another network, so the code would encode a URL the phone cannot open.

## Consequences

Remote access needs no port forwarding, no account, and no client install, and the phone reaches the session over real HTTPS, which also gives the browser a secure context that a plain-HTTP LAN origin would not.

The costs are real and deliberate. A quick tunnel is public: anyone who obtains the URL drives the session, so the operator must treat the QR code as a secret. Cloudflare assigns a new hostname per start, so a URL is good for one run and cannot be bookmarked across restarts. The TLS-terminated public authority still receives a cookie without `Secure`, because one process serves both the loopback and public authorities. The connector's own availability bounds the feature: it must be installed, and a network that blocks the tunnel leaves only the loopback URL.

Scanning is a cross-site navigation, which the session cookie's attribute must admit: the browser hands the scanned URL to a new page from outside the browsing context, so the [browser-session cookie](../architecture/2026-08-24-browser-token-authentication.md) is `SameSite=Lax`. Under the original `Strict` the browser stored the minted cookie and then withheld it from the `303` follow to clean `/`, so every scan of a correct code ended on the 401 page. `Lax` governs the cookie everywhere, including loopback, because one process serves both authorities.

A deployment wanting stronger control should front the loopback listener with its own authenticated tunnel or reverse proxy and declare that stable hostname with `--trusted-host`, which needs no change to this code.

## Testing

`tests/remote-access.spec.ts` drives the connector lifecycle through a fake child process — origin capture from either stream, the missing-executable, early-exit, and deadline failures, post-start exit reporting, and idempotent close — so no test needs the binary or the network. It also pins the publication grace: the URL is withheld until the grace period elapses, is reported anyway after it, rejects when the connector dies inside it, and a later output line cannot replace the published origin. `tests/web-app-remote.spec.ts` covers the runtime's publication, fence admission, disposal, and the tunnel-failure path that must leave the local server serving. `tests/node-half.host.spec.ts` covers `addTrustedAuthority`: an undeclared authority returns 403 before registration, the added authority reaches 401 without a session and passes with one, withdrawal restores 403, and a malformed entry throws.

The end-to-end path was verified against a real quick tunnel: the token exchange returned 303 on the public origin and minted the cookie, the index returned 200 with that cookie, an unauthenticated request returned 401, and a request naming the tunnel Host reached the RPC bridge while an undeclared Host returned 403.

The readiness behavior is only observable against real infrastructure, so it was settled there rather than in a unit test. A driver started `dsh web --remote`, captured the instant the remote URL printed, and checked both the OS resolver and HTTPS at that moment: before the grace period the OS resolver returned `ENOTFOUND` while the record was already public, and after it the resolver answered and HTTPS returned 401. The DNS-poisoning comparison above ran two polling arms against live tunnels and recorded the operator's resolver state after each. A real Chromium then simulated the scan — a foreign-origin page handing the URL over, which is what a camera app does — and rendered the GUI at the clean root URL with no token left in the address bar.
