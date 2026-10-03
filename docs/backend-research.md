# T3 Code backend / client integration research

Findings for **t3-tode** (render the entire real T3 UI through a terminal browser, preserving all
features). Research against `pingdotgg/t3code` cloned at
`vendor/t3code` (HEAD `aad732901e4b7d485574eaef5a9c1fb388c4291a`, 2026-10-03; package version
`0.0.45`). All paths below are relative to `vendor/t3code/` unless noted.

---

## 1. TL;DR

| Question | Answer |
| --- | --- |
| Exact command to run backend **with** the official full web frontend | `npx t3@latest` (or installed `t3` / `t3 serve`). The released `t3` npm package **bundles the built official web app** and serves it from the same origin as the backend. |
| Default port | **3773** (first free port ≥ 3773 in `web` mode; fixed 3773 in `desktop` mode). `apps/server/src/config.ts:23` |
| Auth | Environment-issued, scoped sessions. One-time **pairing token** → browser cookie or OAuth-style token exchange → bearer/DPoP → short-lived **wsTicket** for the `/ws` upgrade. |
| Client registration / "official designation" | **Not possible, and not needed.** There is no client registry or allowlist. Any authenticated session is first-class; client identity (`clientSurface` etc.) is optional, unauthenticated, informational metadata. A `cli` surface literal already exists. |
| Reusable endpoint for a custom client | `GET /.well-known/t3/environment` (unauth descriptor), `POST /oauth/token`, `POST /api/auth/websocket-ticket`, `GET /api/orchestration/*` snapshots, and `WS /ws` with 173 typed RPC methods (`packages/contracts/src/rpc.ts`, `orchestrationV2.ts`). |
| Best route for t3-tode's goal | Run the **released** server and point a JS-capable terminal browser at `http://localhost:3773` after pairing once; no fork, no proxy, no reimplementation. Custom-client over the WS RPC is the fallback if a terminal browser cannot run the SPA. |

---

## 2. Source layout (what matters)

```
apps/server/          "t3" npm package. WS server, HTTP API, auth, orchestration, CLI (bin.ts → binCli.ts)
apps/web/             Official React/Vite web UI (the same bundle used by app.t3.codes and the desktop renderer)
apps/desktop/         Electron shell wrapping apps/web + bundled server
apps/mobile/          React Native client
packages/contracts/   THE wire boundary: rpc.ts (WS RPC), environmentHttp.ts (HTTP API), auth.ts, orchestrationV2.ts
packages/client-runtime/  Shared client logic (connection resolver, auth bootstrap, RPC session) — reusable by a custom client
docs/internals/       Architecture: overview.md, environment-auth.md, connection-runtime.md, remote.md
docs/user/            install.md, remote-access.md — official user flows
```

Key facts:

- The web UI is served **by the server itself**: `apps/server/src/config.ts:249 resolveStaticDir()`
  looks for `dist/client/index.html` next to the server bundle (the published npm layout) or
  `apps/web/dist` in the monorepo. The build script (`apps/server/scripts/cli.ts:94-101`) copies
  the built web app into `dist/client`. **One origin serves UI + `/api` + `/ws` + `/oauth`.**
- The server is event-sourced (orchestration v2). Clients are dumb renderers over typed RPC +
  subscriptions; **no client-side state is authoritative** — ideal for our goal.

---

## 3. Running the backend with the official full web frontend

### Option A (recommended for t3-tode): released CLI, bundled official web UI

```bash
# Once, if you want it installed:
curl -fsSL https://t3.codes/install.sh | sh        # puts t3 in ~/.local/bin

# One-shot without installing:
npx t3@latest                                      # starts server, opens browser
npx t3@latest serve                                # headless: no browser, prints Connection string / Token / Pairing URL / QR
```

Output of `serve` (`apps/server/src/startupAccess.ts:122 formatHeadlessServeOutput`):

```
T3 Code server is ready.
Connection string: http://<host>:3773
Token: <one-time token>
Pairing URL: http://<host>:3773/pair#token=<one-time token>
```

The server on `http://localhost:3773` **is** the official web frontend (bundled `dist/client`).
Open the printed pairing URL in any browser once; the token is exchanged for a session cookie.

Flags (`apps/server/src/cli/config.ts`, all shared by `t3`, `t3 start`, `t3 serve`):

```
--mode web|desktop          runtime mode (default web)
--port <n>                  HTTP/WS port (default 3773; web mode picks next free port)
--host <iface>              bind address (e.g. 0.0.0.0 or a Tailnet IP; default loopback in desktop mode)
--base-dir <dir>            data dir, runtime state under <dir>/userdata  (≈ T3CODE_HOME)
--cwd <dir>                 default project working directory
--no-browser                don't auto-open a browser
--tailscale-serve           publish over Tailscale Serve HTTPS (with --tailscale-serve-port, default 443)
--auto-bootstrap-project-from-cwd
--log-websocket-events / --log-ws-events
--bootstrap-fd <fd>         desktop: one-time bootstrap secrets via fd
--dev-url <url>             dev web URL to proxy/redirect to (dev mode only)
```

Equivalent env vars: `T3CODE_PORT`, `T3CODE_HOST`, `T3CODE_HOME`, `T3CODE_NO_BROWSER`,
`T3CODE_MODE`, `T3CODE_TAILSCALE_SERVE`, `VITE_DEV_SERVER_URL` (dev only).

Background service: `t3 service install | status | restart | update | uninstall`.
Update: `t3 update`. Full reference: `t3 --help`.

### Option B: from source (dev mode — full fidelity, hot reload)

```bash
git clone https://github.com/pingdotgg/t3code && cd t3code
curl -fsSL https://vite.plus | bash     # install `vp` (Vite+); repo requires Node ^24.13
vp i
vp run dev                              # server + web (single origin via Vite proxy)
vp run dev --share                      # additionally publishes over tailnet, prints pairingUrl:
```

- Dev is **single-origin**: Vite proxies `/api`, `/ws`, `/oauth`, `/.well-known` to the backend.
  Never set `VITE_HTTP_URL` / `VITE_WS_URL` (bakes localhost into the bundle and breaks remote).
- Read the actual ports from the `[dev-runner]` line (derived from worktree path; shift if busy;
  `T3CODE_PORT_OFFSET` / `T3CODE_DEV_INSTANCE` to select).
- State: main checkout → `~/.t3/dev/userdata`; worktrees → their own gitignored `.t3`.
- Intel Macs (no prebuilt `t3`): build from source with Node 24 + `vp`:
  `vp i && vp run build:desktop && node apps/server/dist/bin.mjs` (serves `apps/web/dist`).

### Option C: desktop app (bundles the same server)

`brew install --cask t3-code` (macOS) / `winget install T3Tools.T3Code` / releases on GitHub.
Hosts the same server (`mode: desktop`, port fixed 3773) and the same web renderer; remote clients
(web/mobile/desktop) can attach to it. Not useful for a terminal-rendered UI by itself, but its
server is identical to Option A.

### Requirements / prerequisites

- Node.js (published CLI: `^22.16 || ^23.11 || >=24.10`; source/dev: Node 24, `vp`).
- **At least one provider CLI installed and authenticated** — Codex, Claude Code, Cursor CLI,
  Grok Build, OpenCode, or Antigravity (e.g. `claude auth login`, `codex login`). The server
  wraps provider CLIs as subprocesses; with none authenticated you can't start threads.

---

## 4. Auth model (exact flows)

Architecture: `docs/internals/environment-auth.md`. The environment issues its **own** sessions;
cloud identity / relay credentials are a separate trust boundary (T3 Connect). Socket
authentication ≠ method authorization: **every RPC declares a required scope**
(`apps/server/src/auth/RpcAuthorization.ts`).

### Scopes (`packages/contracts/src/auth.ts:81-114`)

```
orchestration:read  orchestration:operate  terminal:operate  review:write
access:read  access:write  relay:read  relay:write
```

- `AuthStandardClientScopes` = orchestration:read, orchestration:operate, terminal:operate,
  review:write, relay:read — what `t3 pair` / `t3 auth pairing create` delegate.
- `AuthAdministrativeScopes` = standard + access:read/write + relay:write — the **startup URL**
  (server boot) grants these; required for the Connections settings UI.

### Flow 1 — browser (what a terminal browser will use)

1. Server prints pairing URL: `<origin>/pair#token=<one-time credential>` (token in the **hash**,
   not query — never sent to the server in the URL request).
   Format from `startupAccess.ts:92 buildPairingUrl`.
2. Web app reads `#token=…`, POSTs **`/api/auth/browser-session`** with `{ credential }`
   (`apps/web/src/environments/primary/auth.ts`, contracts `AuthBrowserSessionRequest`).
3. Server validates the one-time credential, creates a session, and sets an HTTP-only cookie:
   name **`t3_session`** (`apps/server/src/auth/utils.ts:11`; suffixed `t3_session_<hash>` /
   `t3_session_<port>` for remote/desktop variants). Browser sessions authenticate the `/ws`
   upgrade with this cookie — no headers needed.
4. Token is stripped from the URL after use (`apps/web/src/pairingUrl.ts`).

### Flow 2 — programmatic client (for a custom t3-tode client)

1. Obtain a one-time pairing credential (server startup URL, `t3 pair`, or
   `t3 auth pairing create`).
2. Exchange it once: **`POST /oauth/token`** (`form-urlencoded`):
   ```
   grant_type=urn:ietf:params:oauth:grant-type:token-exchange
   subject_token=<pairing credential>
   subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap
   requested_token_type=urn:ietf:params:oauth:token-type:access_token
   scope=<space-separated, optional — narrow only>
   client_label / client_device_type / client_os        (optional metadata)
   ```
   → `{ access_token, token_type: "Bearer" | "DPoP", expires_in, scope }`
   (`packages/client-runtime/src/authorization/remote.ts:exchangeRemoteDpopAccessToken`).
   DPoP binds the token to a proof key; **an invalid DPoP proof fails hard, never falls back**.
3. Mint a short-lived WS ticket: **`POST /api/auth/websocket-ticket`** (Bearer or DPoP header)
   → `{ ticket, expiresAt }`.
4. Connect **`GET /ws?orchestrationProtocol=2&wsTicket=<ticket>`** (cookie-authed browsers skip
   the ticket). Optional identity params on the upgrade URL: `clientSurface`, `clientAppVersion`,
   `clientDeviceType`, `clientOs`, `clientWebDeployment`, `clientBrowser`, `connectionMethod`
   (`apps/server/src/ws.ts:611-675`). Absent/malformed values **degrade to `{}`** — a connection
   never fails over attribution metadata.

### Flow 3 — CLI-issued long-lived credential (headless)

```bash
t3 auth session issue --ttl 30d --label t3-tode --token-only   # scoped bearer for headless/remote clients
t3 auth session list / revoke
t3 auth pairing create [--ttl 5m] [--label ...] [--base-url http://host:3773]  # prints /pair#token=... link
t3 auth pairing list / revoke <id>
```

`pairing` mints **standard-scope** one-time links; `session issue` mints a durable scoped bearer
token (subject defaults to `headless`). This is the officially supported way to give a
custom/headless client standing credentials without touching the DB.

### Dev-only convenience

`T3CODE_DEV_AUTH_TOKEN` (≥ 32 chars) in the dev checkout's `.env`: one reusable admin credential
across worktrees/ports on one hostname; cookie expires after 30 days; **ignored by desktop and
non-dev servers**. Startup pairing URLs carry admin scopes; `t3 pair` carries standard scopes.
Never publish tokens or startup URLs.

### Managing access

- Web/desktop: **Settings → Connections** (create links, list/revoke client sessions).
- CLI: `t3 auth` (above). Server-issued pairing secrets are stored hashed; only the creation
  response returns the raw credential.

---

## 5. Client registration — can t3-tode be "officially designated"?

**Short answer: there is no such mechanism, and none is needed.**

1. **No client registry / allowlist / clientID+secret.** Authority derives entirely from the
   session's scopes (`environment-auth.md`: "client labels and device metadata have no
   authorization role").
2. **Identity is self-declared and optional.** `clientSurface` on the `/ws` upgrade and
   `client_label`/`client_device_type`/`client_os` on token exchange are informational
   (connections list, telemetry). Malformed values silently degrade.
3. **A first-class `cli` surface already exists** (`packages/contracts/src/baseSchemas.ts:164`):
   `ClientSurface = "web" | "desktop" | "mobile" | "cli"`. A terminal client announcing
   `clientSurface=cli` is as official as the contract allows.
4. **Feature gating is capability negotiation, not client identity.** The server publishes an
   `ExecutionEnvironmentDescriptor` (`GET /.well-known/t3/environment`, unauthenticated) with
   `environmentId`, `label`, `platform`, `serverVersion`, `orchestrationProtocolVersion` (2), and
   `capabilities` (e.g. `threadPullRequests`, `threadPullRequestLinking` — see
   `docs/internals/overview.md` compatibility table). Clients must honor descriptor flags and the
   protocol version (`?orchestrationProtocol=2` on the WS URL; mismatched hosts get a
   blocked/connect-for-update path in `client-runtime/connection/compatibility.ts`).
5. The official clients (web/desktop/mobile) are simply consumers of the same public contract in
   `packages/contracts`. Nothing stops a third client from consuming it identically — the repo
   explicitly celebrates forks and multiple surfaces ("Open at the core", AGENTS.md).

**Conclusion:** t3-tode can be a legitimate peer client by (a) pairing via the documented flows,
(b) announcing `clientSurface=cli`, and (c) negotiating via the descriptor. No fork of the server
is required for that. If t3-tode instead *renders the real web UI*, it doesn't even need to speak
the contract.

---

## 6. Reusable endpoints (the full stable surface)

### HTTP (all same-origin on the server; exact schemas in `packages/contracts/src/environmentHttp.ts`)

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /.well-known/t3/environment` | none | Environment descriptor (id, label, version, protocol, capabilities) |
| `POST /api/auth/browser-session` | pairing credential in body | Pairing → session cookie |
| `GET /api/auth/session` | bearer/cookie | Current session state |
| `POST /oauth/token` | none (credential in payload) | Token exchange → Bearer/DPoP access token |
| `POST /api/auth/websocket-ticket` | authenticated | Short-lived `wsTicket` for `/ws` |
| `POST /api/auth/pairing-token` | authenticated (needs access:write) | Mint additional pairing credentials |
| `GET /api/auth/pairing-links` · `POST /api/auth/pairing-links/revoke` | access scopes | Manage links |
| `GET /api/auth/clients` · `POST /api/auth/clients/revoke[-others]` | access scopes | Manage sessions |
| `GET /api/orchestration/shell` | `orchestration:read` | Project shell snapshot |
| `GET /api/orchestration/threads/:id` · `/bounded` · `/history?cursor=` | `orchestration:read` | Thread snapshots + paged history |
| `GET /api/projects` · `POST /api/projects/mutate` | auth | Project list / mutations |
| `POST /api/pull-requests/diff` | auth | PR diff |
| `/api/connect/*`, `/api/t3-connect/*` | relay scopes | T3 Connect relay management |

Also: `HTTP GET /ws` upgrade; static UI at `/`; OTLP proxy at `/api/observability/v1/traces`.

### WebSocket RPC (`WS /ws?orchestrationProtocol=2`)

Effect `RpcGroup` with **173 methods** (`packages/contracts/src/rpc.ts` WS_METHODS +
`orchestrationV2.ts` ORCHESTRATION_V2_WS_METHODS). Namespaces: `projects.*` (list/add/files/search/
mutate), `filesystem.*`, `agentSessions.*`, `assets.*`, `attachments.*`, `provider.*` (auth,
install), `vcs.*`, `git.*`, `review.*`, `terminal.*` (open/attach/write/resize/restart/close),
`preview.*`, `device.*`, `server.*` (config/settings/diagnostics/usage/updates), `scheduledTasks.*`,
`pullRequests.*` (full review surface), `sourceControl.*`, `projectClone.*`, plus ~15
`subscribe*` stream methods and orchestration-v2 (`orchestration.dispatchCommand`,
`getTurnDiff`, `searchThreads`, thread streams…). Every method declares a required scope
(`apps/server/src/auth/RpcAuthorization.ts`); subscriptions push per-thread state so a client
viewing one thread doesn't pay for all threads.

The shared client implementation of this surface lives in `packages/client-runtime`
(connection resolver, credential store, RPC session) and is plainly intended for reuse by
non-official clients.

---

## 7. Recommended integration for t3-tode

**Goal: render the entire real T3 UI in a terminal browser, preserving all features.**

### Primary path: terminal browser → official bundled web UI

1. Run the released server: `npx t3@latest serve` (or installed `t3 serve`) — official web app is
   served at `http://localhost:3773` from the same origin.
2. Complete pairing **once** inside the terminal browser session: load the printed
   `/pair#token=…` URL; the web app exchanges it for the `t3_session` cookie, which persists
   (until expiry/revocation) in the browser profile. After that, the bare origin authenticates.
3. Point the terminal browser at `http://localhost:3773` from then on. Re-pair after expiry or
   revocation with `t3 pair` (never restart the server for this).
4. For remote/second machines: `t3 serve --host <lan-ip>` + `t3 pair`, or `t3 pair --tailscale`,
   or `t3 connect` (T3 Connect relay for full remote access from app.t3.codes or mobile).

Why this preserves "all features": the UI is the actual official React app (every panel: threads,
composer, terminal, device, PR review, settings) talking to the real server over the real
WebSocket. Nothing is reimplemented or proxied; feature parity is automatic across updates
(`t3 update` ships a new bundled UI).

Terminal-browser requirements discovered from the codebase:
- The UI is an SPA that requires **JavaScript + WebSocket + cookie storage**. A text-only terminal
  browser (lynx/w3m) will not work. A JS-capable terminal browser (e.g. Browsh-style headless
  Firefox rendering, or a Chromium-backed renderer) is required.
- WebCodecs-based device streaming requires a secure context; the viewer probes and falls back to
  MJPEG on iOS (`docs/internals/devices.md`) — a headless/terminal browser may need the fallback
  or will simply show the panel's "cannot decode" state. Everything else degrades gracefully.
- Performance contract matters at terminal frame rates: subscriptions stream deltas; heavy screens
  (device MJPEG, preview panes) may need disabling in a low-FPS terminal surface.

### Fallback path: custom t3-tode client over the WS RPC

If SPA-in-terminal proves impractical, build the terminal UI against the real contract instead:
`GET /.well-known/t3/environment` → `POST /oauth/token` (exchange pairing credential) →
`POST /api/auth/websocket-ticket` → `WS /ws?orchestrationProtocol=2&wsTicket=…` with
`clientSurface=cli`, consuming `packages/contracts` schemas (TypeScript-importable as
`@t3tools/contracts` — same workspace package) and reusing `packages/client-runtime` patterns.
This is fully supported by the architecture (that's how web/mobile/desktop all connect) but
re-implements UI, so it sacrifices "render the real UI" — use only if the primary path fails.

---

## 8. Working CLI command sheet (verified against source)

```bash
# Run server + official web UI
npx t3@latest                       # starts server, opens browser, prints pairing URL
npx t3@latest serve                 # headless; prints Connection string / Token / Pairing URL / QR
t3                                  # installed binary: same as `npx t3@latest`
t3 serve --port 3773 --host 127.0.0.1 --base-dir ~/.t3
t3 serve --no-browser

# Pairing (one-time, standard scopes)
t3 pair                             # QR + URL for a RUNNING server (discovered via server-runtime.json)
t3 pair --ttl 15m --label t3-tode
t3 pair --tailscale [--tailscale-serve-port 443]
t3 auth pairing create --ttl 1h --base-url http://localhost:3773
t3 auth pairing list / revoke <id>

# Standing credentials for headless/custom clients
t3 auth session issue --ttl 30d --label t3-tode --token-only
t3 auth session list / revoke <id>

# Service & lifecycle
t3 service install / status / restart / update / uninstall
t3 update
t3 --help

# Desktop helpers
t3 app [path]                       # open a project in the running desktop app (same machine only)

# Remote access variants
t3 serve --host <lan-ip>            # pair over LAN
t3 serve --tailscale-serve          # publish over Tailscale HTTPS
t3 connect                          # T3 Connect (cloud relay; sign-in flow)

# From source (dev, official full frontend via Vite)
curl -fsSL https://vite.plus | bash && vp i
vp run dev                          # single origin; read ports from [dev-runner] line; open printed pairing URL
vp run dev --share                  # tailnet publish + pairingUrl:
vp run dev:server | dev:web | dev:desktop
node apps/server/src/bin.ts pair    # mint a fresh one-time token for the dev server

# Programmatic probe
curl http://localhost:3773/.well-known/t3/environment   # unauthenticated descriptor
```

---

## 9. Risks and gotchas

1. **The web UI is a full SPA.** Terminal rendering needs JS + WS + cookies. Text browsers are
   out; a headless-JS terminal browser is mandatory. Visual density (dark-theme, animations,
   canvas/WebCodecs panels) may render poorly; the device stream and preview panes are the first
   things to degrade. Budget for a "features render but heavy panes are lossy" outcome.
2. **Port dynamics.** Web mode picks the first free port ≥ 3773 (`config.ts:23`, `findAvailablePort`).
   Pin `--port` (and `--base-dir`) for t3-tode so saved pairing/credentials stay valid; the
   session cookie name embeds an instance hash for remote hosts.
3. **Pairing tokens are one-time, 5-minute-TTL by default.** Automate first-run pairing carefully:
   consume the token promptly, persist the cookie, and re-mint with `t3 pair` when needed. Never
   log or echo tokens (docs: treat them as passwords).
4. **Scope asymmetry.** Startup pairing URLs carry **admin** scopes; `t3 pair` carries standard
   scopes. A standard session cannot mint further pairing links (needs `access:write` + all
   delegated scopes — issuance is enforced server-side, exchange can only narrow). Use
   `t3 auth session issue` for a durable automation credential.
5. **Never run a second server against the live install.** `~/.t3/userdata` is the real database;
   state lives under `--base-dir`; dev worktrees force their own `.t3`. t3-tode must always pass
   an explicit `--base-dir` when testing (e.g. a scratch dir) to avoid corrupting a user install
   (AGENTS.md "Writing to the live install").
6. **Killing the server.** t3-tode must not pkill-by-pattern; the T3 process may be the user's
   daily driver, and this machine runs several servers. Track the spawned PID or use the service
   commands.
7. **Protocol versioning.** The WS URL must send `orchestrationProtocol=2`; descriptor flags gate
   features (PR linking table in `docs/internals/overview.md`). A custom client must implement
   capability negotiation or it will mis-render newer servers. The official UI (primary path)
   handles this automatically.
8. **Dev-mode traps (only if building from source).** Never set `VITE_HTTP_URL`/`VITE_WS_URL`;
   never `vp check`/repo-wide test runs against the developer's live instance; `T3CODE_DEV_AUTH_TOKEN`
   is an admin secret tied to one hostname (any service on that hostname can read the cookie).
9. **Upstream is early and fast-moving.** Version `0.0.45`; docs say "expect bugs" and contributions
   are restricted. Pin t3-tode to a known-good `t3` version (`T3CODE_VERSION` / `npx t3@<version>`)
   and re-run this research on upgrades. Forks are explicitly supported if drift becomes a problem.
10. **Provider prerequisite.** With no authenticated provider CLI, the UI works but threads can't
    run. t3-tode should surface the README's provider setup list in onboarding.

---

## 10. Provenance

- Repo: https://github.com/pingdotgg/t3code, cloned to `vendor/t3code`
  (shallow, HEAD `aad732901e4b7d485574eaef5a9c1fb388c4291a`, dated 2026-10-03, version 0.0.45).
- Primary sources: `apps/server/src/{binCli,cli/*,config,server,serverRuntimeStartup,startupAccess,ws,http,auth/*}.ts`,
  `packages/contracts/src/{rpc,orchestrationV2,environmentHttp,auth,environment,baseSchemas}.ts`,
  `packages/client-runtime/src/{connection,authorization}/`,
  `docs/{internals,user,operations}/` (overview, environment-auth, devices, development, install,
  remote-access).
- No files outside `docs/backend-research.md` and `vendor/t3code/` were created or modified.
