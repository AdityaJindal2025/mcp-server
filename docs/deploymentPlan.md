# Deployment Plan: gmail-docs-mcp on Railway

> **Goal:** run the server's Streamable HTTP transport on [Railway](https://railway.com) behind HTTPS, so remote MCP hosts (OpenAI Responses API, Claude Code, VS Code, Gemini CLI over HTTP, headless agents for scenario S4) can call it.
>
> **Scope:** one Railway service, one Google account (v1 security model), bearer-token auth. This resolves open question 3 in the [problem statement](problemStatement.md) (hosting location) in favour of Railway.
>
> **Status:** the code changes in §3 (C1, C2, C3) are implemented and tested. Next: §4 prerequisites and the §12 rollout checklist.

---

## 1. Target architecture

```
 MCP host (OpenAI Responses API, Claude Code, VS Code, script)
        │  HTTPS POST /mcp   Authorization: Bearer <MCP_HTTP_BEARER_TOKEN>
        ▼
 Railway edge (TLS, *.up.railway.app or custom domain)
        │  HTTP → container $PORT (Railway sets it, e.g. 8080)
        ▼
 Railway service "gmail-docs-mcp"   (1 replica, Dockerfile build)
   node dist/index.js --transport http
   ├─ Host / Origin / bearer checks  (src/transports/http.ts)
   ├─ GET /healthz                   (Railway health check)
   ├─ Google refresh token from GOOGLE_TOKEN_JSON (sealed variable)
   └─ JSON logs + audit lines on stderr → Railway logs
        │  HTTPS
        ▼
 Gmail API / Google Docs API  (as the one signed-in Google account)
```

What does **not** change from local use: the same image, the same tool contracts, and both protocol revisions (`2026-07-28` and `2025-11-25`) served from `/mcp`.

---

## 2. Decisions

| #   | Decision                                                                                                   | Why                                                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Build from the existing `Dockerfile`** (not Railpack/Nixpacks).                                          | It's already a multi-stage, non-root, production image and is exercised by the CI `docker` job. Same artifact locally and on Railway.                                                                                                 |
| R2  | **Exactly 1 replica.**                                                                                     | The hourly send limit (`EMAIL_MAX_PER_HOUR`) and the `client_request_id` cache are in memory per process (plan D6). Two replicas would double the effective limit and miss duplicate retries.                                         |
| R3  | **Google token supplied as a sealed environment variable** (`GOOGLE_TOKEN_JSON`, base64), not a volume.    | Railway has no secret-file mounts. A volume would need a manual upload and ties the service to one region's disk. The token is small and read-only at runtime. Requires code change C1.                                               |
| R4  | **Bearer-token auth only** (`MCP_HTTP_BEARER_TOKEN`).                                                      | Already implemented and enforced: the server refuses to bind a public interface without a token. OAuth for ChatGPT and Claude.ai connectors (plan T2.10) is not implemented, so those two hosts are out of scope for this deployment. |
| R5  | **Audit log to stderr** (leave `AUDIT_LOG_PATH` unset).                                                    | Railway captures stderr in its log viewer. A file would need a volume and would be lost on redeploy without one.                                                                                                                      |
| R6  | **Railway-generated domain first, custom domain optional.**                                                | `*.up.railway.app` comes with TLS immediately; a custom domain can be added later without config changes other than `MCP_HTTP_ALLOWED_HOSTS`.                                                                                         |
| R7  | **Publish the Google OAuth app** (consent screen status "In production") before relying on the deployment. | In "Testing" status Google expires refresh tokens after 7 days, which would silently break a deployed server weekly.                                                                                                                  |

---

## 3. Code changes before the first deploy

Both are small and keep local behaviour unchanged.

### C1. Read the Google token from an environment variable (required)

Today the server only reads a token **file** (`GOOGLE_TOKEN_PATH`). Add:

- **`GOOGLE_TOKEN_JSON`**: the token file's contents, either raw JSON or base64-encoded JSON (detect: a value starting with `{` is raw).
- New `EnvTokenStore` in [src/auth/tokenStore.ts](../src/auth/tokenStore.ts) implementing `TokenStore`:
  - `read()` parses and validates with the existing `StoredTokenSchema`, and throws `TokenFileError('malformed', …)` naming `GOOGLE_TOKEN_JSON` (never echoing its value).
  - `write()` throws: tokens are produced by `auth` on a workstation, never in the container.
  - `version()` returns a constant (the env can't change without a restart).
  - `location` is `"GOOGLE_TOKEN_JSON environment variable"` for messages.
- [src/config.ts](../src/config.ts): add `GOOGLE_TOKEN_JSON` to the schema. When set, it takes precedence over `GOOGLE_TOKEN_PATH`.
- [src/server.ts](../src/server.ts) `createDeps`: choose `EnvTokenStore` when `GOOGLE_TOKEN_JSON` is set, otherwise `FileTokenStore`.
- Make sure the logger's redaction pattern covers `GOOGLE_TOKEN_JSON` (it matches `/token/i` already) and that config errors print the variable **name** only.
- **Tests:** raw and base64 inputs, malformed input (message names the variable, not the value), precedence over `GOOGLE_TOKEN_PATH`, and an integration test that a tool call works with only `GOOGLE_TOKEN_JSON` set.
- **Docs:** add the variable to `.env.example` and the README configuration section.

The refresh token doesn't rotate during normal use (Google returns a new access token, not a new refresh token), so a read-only store is enough.

**Implemented:** `EnvTokenStore` and `tokenStoreFor()` in [src/auth/tokenStore.ts](../src/auth/tokenStore.ts). `auth --status` checks whichever store the server will use, and `auth` warns when `GOOGLE_TOKEN_JSON` would override the file it just wrote. Tests: [envTokenStore.test.ts](../test/unit/envTokenStore.test.ts), [envToken.test.ts](../test/integration/envToken.test.ts).

### C2. Honour Railway's `PORT` (recommended)

Railway injects `PORT` and routes the public domain to it by default. Change `loadConfig` so the HTTP port is resolved as `--port` flag, then `MCP_HTTP_PORT`, then `PORT`, then `3333`. Add a unit test for the order.

With C2 in place, don't set `MCP_HTTP_PORT` on Railway: it would override `PORT`. The domain's target port must equal the port in the startup log line (§5, step 5).

**Implemented:** `optInt` for `MCP_HTTP_PORT` and `PORT` in [src/config.ts](../src/config.ts), covered by a unit test of the resolution order.

### C3. Add `railway.json` (config as code)

```json
{
  "$schema": "https://railway.com/railway.schema.json",
  "build": {
    "builder": "DOCKERFILE",
    "dockerfilePath": "Dockerfile"
  },
  "deploy": {
    "numReplicas": 1,
    "healthcheckPath": "/healthz",
    "healthcheckTimeout": 60,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 5
  }
}
```

Railway ignores the Dockerfile `HEALTHCHECK`; `healthcheckPath` is what gates a deploy going live.

**Implemented:** [railway.json](../railway.json). All keys and values were validated against <https://railway.com/railway.schema.json> on 2026-10-17.

**Exit criteria for §3:** `npm run lint && npm run typecheck && npm test` green, the snapshot unchanged (no tool contract change), and `docker build .` succeeds in CI.

---

## 4. Prerequisites

| Item                             | How                                                                                                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Railway account and plan         | Sign up at railway.com. A service that must stay up needs a paid plan (check current Hobby pricing and usage limits).                                                                                                                                                               |
| Railway CLI (optional but handy) | `npm i -g @railway/cli`, then `railway login`                                                                                                                                                                                                                                       |
| GitHub repo                      | Push this project to GitHub so Railway can deploy on push. `railway up` from a local checkout also works.                                                                                                                                                                           |
| Google OAuth app **published**   | Google Cloud console → OAuth consent screen / Audience → **Publish app** (status "In production"). With sensitive scopes and no verification you'll see the "unverified app" warning on sign-in; that's acceptable for your own account. Internal (Workspace) apps don't need this. |
| Fresh token after publishing     | Run `node dist/index.js auth` again locally after publishing, so the refresh token isn't one issued under Testing status. Confirm with `node dist/index.js auth --status`.                                                                                                          |
| Bearer token                     | `openssl rand -hex 32` (keep it in a password manager).                                                                                                                                                                                                                             |

---

## 5. Step-by-step deployment

### Step 1: Prepare the token value

```bash
node dist/index.js auth --status                              # must say Refresh: OK
base64 -i ~/.config/gmail-docs-mcp/token.json | tr -d '\n'    # macOS
# base64 -w0 ~/.config/gmail-docs-mcp/token.json              # Linux
```

Copy the single-line output. It contains your refresh token and OAuth client secret: paste it only into Railway, never into chat, issues or commits.

### Step 2: Create the project and service

**Dashboard:** New Project → **Deploy from GitHub repo**, then select the repo. Railway detects `railway.json` and the `Dockerfile`.

**CLI alternative:**

```bash
railway init            # create/link a project
railway up              # build and deploy the current directory
```

The first deploy is **expected to fail** its health check until the variables are set. The server exits with code 2 when it binds `0.0.0.0` without `MCP_HTTP_BEARER_TOKEN`, which is the intended safety behaviour.

### Step 3: Set variables

Service → **Variables**. Mark the secrets as **sealed** (their values are hidden in the UI and API after saving).

| Variable                 | Value                                                                                      | Sealed |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------ |
| `MCP_HTTP_BEARER_TOKEN`  | output of `openssl rand -hex 32`                                                           | ✅     |
| `GOOGLE_TOKEN_JSON`      | base64 string from step 1 (needs C1)                                                       | ✅     |
| `MCP_HTTP_ALLOWED_HOSTS` | `<service>.up.railway.app` (set after step 6; add the custom domain later)                 |        |
| `EMAIL_ALLOWED_DOMAINS`  | e.g. `gmail.com,yourcompany.com`. **Strongly recommended** for a network-reachable server. |        |
| `DOCS_ALLOWED_IDS`       | IDs of the docs agents may touch, e.g. `1AbC...yourDocId`                                  |        |
| `EMAIL_DRY_RUN`          | `true` for the first verification, then `false`                                            |        |
| `EMAIL_MAX_PER_HOUR`     | e.g. `10` (lower than the local default)                                                   |        |
| `LOG_LEVEL`              | `info`                                                                                     |        |

Already set by the Dockerfile; leave them alone: `MCP_TRANSPORT=http`, `MCP_HTTP_HOST=0.0.0.0`, `NODE_ENV=production`.

**Leave unset:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (the token value carries them), `AUDIT_LOG_PATH` (R5), `ENABLE_DRAFTS` (needs the restricted scope and a re-auth), `GOOGLE_TOKEN_PATH` (superseded by `GOOGLE_TOKEN_JSON`).

CLI equivalent (each `--set` triggers a redeploy unless you pass `--skip-deploys`):

```bash
railway variables --set "MCP_HTTP_BEARER_TOKEN=..." --set "EMAIL_DRY_RUN=true" --skip-deploys
```

### Step 4: Settings

- **Region:** pick the one closest to you (Google API latency is low from any region).
- **Replicas:** 1 (enforced by `railway.json`).
- **Serverless / app sleeping: off.** The first request after sleep would pay a cold start, and the in-memory rate limiter resets on every wake.
- **Watch paths (optional):** `src/**`, `package*.json`, `Dockerfile`, `railway.json`, so doc-only commits don't redeploy.

### Step 5: Deploy

Click **Deploy** (or push to the deploy branch / run `railway up`). In the deploy logs, expect:

```json
{
  "level": "info",
  "msg": "gmail-docs-mcp listening on http",
  "url": "http://0.0.0.0:8080/mcp",
  "auth": "bearer"
}
```

and a passing `/healthz` health check.

### Step 6: Public domain

Service → **Settings → Networking → Generate Domain**. Set the target port to the port in the startup log line from step 5 (`"url":"http://0.0.0.0:<port>/mcp"`, typically **8080**). If the domain already exists, edit its target port with the pencil icon. Then:

1. Copy the domain (e.g. `gmail-docs-mcp-production.up.railway.app`).
2. Set `MCP_HTTP_ALLOWED_HOSTS` to it (step 3) and let it redeploy.

Optional custom domain: add it under Networking, create the CNAME Railway shows, wait for the certificate, and append it to `MCP_HTTP_ALLOWED_HOSTS` (comma-separated).

---

## 6. Verification

Run these in order; stop at the first failure (see §10).

```bash
URL=https://<your-domain>; TOKEN=<bearer token>

# 1. Health (no auth)
curl -s $URL/healthz                                   # {"ok":true}

# 2. Auth is enforced
curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL/mcp                # 401

# 3. Protocol handshake
curl -s -X POST $URL/mcp \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# → serverInfo.name "gmail-docs-mcp"

# 4. Wrong Host is rejected (proves MCP_HTTP_ALLOWED_HOSTS is active)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL/mcp -H 'host: evil.example.com'   # 403 (or an edge error)
```

5. **MCP Inspector:** `npx @modelcontextprotocol/inspector`, choose transport Streamable HTTP, URL `$URL/mcp`, header `Authorization: Bearer $TOKEN`. Check that `tools/list` shows 4 tools.
6. **Dry-run email** (with `EMAIL_DRY_RUN=true`): call `gmail_send_email` to yourself. Expect `status: "dry_run"`; nothing sent.
7. **Docs read/write:** `gdocs_get_document_info` then `gdocs_append_text` on the scratch doc. This proves `GOOGLE_TOKEN_JSON` works end to end.
8. Set `EMAIL_DRY_RUN=false`, redeploy, send one real email to yourself, and check the audit line in Railway logs (`"type":"audit","tool":"gmail_send_email","status":"ok"`).
9. **Both protocol revisions:** run a short SDK script against the URL with `versionNegotiation: { mode: 'legacy' }` and `{ pin: '2026-07-28' }` (same as `test/protocol/protocol.test.ts`, pointed at the deployed URL). Record the result in [compatibility.md](compatibility.md).

---

## 7. Connecting hosts to the deployment

| Host                                            | Config                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI Responses API / Agents SDK               | `{ "type": "mcp", "server_label": "gmail_docs", "server_url": "https://<domain>/mcp", "headers": { "Authorization": "Bearer <token>" }, "require_approval": "always" }` |
| Claude Code                                     | `claude mcp add --transport http gmail-docs https://<domain>/mcp --header "Authorization: Bearer <token>"`                                                              |
| VS Code                                         | `"type": "http", "url": "https://<domain>/mcp"`, with the token from an `inputs` prompt (README → VS Code over HTTP)                                                    |
| Gemini CLI                                      | `"httpUrl": "https://<domain>/mcp", "headers": { "Authorization": "Bearer <token>" }`                                                                                   |
| ChatGPT connectors, Claude.ai custom connectors | **Not supported yet.** They require OAuth (plan T2.10).                                                                                                                 |

If a browser-based client sends an `Origin` header, add that origin to `MCP_HTTP_ALLOWED_ORIGINS`.

---

## 8. Operations

### Logs and audit

- Railway → service → **Logs** shows stderr JSON lines. Filter on `"type":"audit"` for write activity and `"level":"error"` for failures.
- Railway's log retention is limited. If you need a durable audit trail, forward logs to an external sink (Railway log drains, or a later code change adding an HTTP audit sink).

### Deploying updates

- Push to the deploy branch (or `railway up`). Railway builds, waits for `/healthz`, then switches traffic.
- Any change to a tool's contract shows up as a snapshot diff in CI first (`contract-change` label). Deploy those deliberately and update host configs if needed.

### Rollback

- Deployments tab → pick the last good deployment → **Redeploy**. Variables are not versioned with deployments, so note what you changed.

### Restarts and state

- Restarts and redeploys reset the in-memory hourly send counter and the `client_request_id` cache. That's acceptable for v1; mention it to anyone relying on the limit.

### Token lifecycle

| Event                                                             | Action                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools return "The Google sign-in has expired or was revoked"      | Locally: `node dist/index.js auth`, re-encode (step 1), update `GOOGLE_TOKEN_JSON`, redeploy.                                                 |
| Enabling drafts                                                   | Set `ENABLE_DRAFTS=true` locally, re-run `auth` (adds `gmail.compose`), update `GOOGLE_TOKEN_JSON`, then set `ENABLE_DRAFTS=true` on Railway. |
| Token leaked                                                      | Revoke at <https://myaccount.google.com/permissions> (remove the app), then re-run `auth` and update the variable.                            |
| Rotate the bearer token (e.g. quarterly, or if shared too widely) | New `openssl rand -hex 32` → update the variable → redeploy → update every host config.                                                       |

### Monitoring (lightweight)

- Railway's health check restarts the service if `/healthz` fails (`restartPolicyType: ON_FAILURE`).
- Optional: an external uptime check (UptimeRobot, Better Stack) on `https://<domain>/healthz`.
- Watch Railway usage and metrics. The service is idle most of the time; memory should stay well under 256 MB.

---

## 9. Security checklist (before announcing the URL to anyone)

- [ ] `MCP_HTTP_BEARER_TOKEN` is a 32-byte random value and sealed.
- [ ] `GOOGLE_TOKEN_JSON` is sealed and doesn't appear in any repo, issue or chat.
- [ ] `EMAIL_ALLOWED_DOMAINS` is set. A public endpoint plus prompt injection is exactly the scenario PS §9 warns about.
- [ ] `DOCS_ALLOWED_IDS` lists only the docs agents should touch.
- [ ] `EMAIL_MAX_PER_HOUR` is lowered for a remote deployment.
- [ ] `MCP_HTTP_ALLOWED_HOSTS` lists exactly the Railway and custom domains.
- [ ] Hosts that support approvals use `require_approval: "always"` (or equivalent) for `gmail_send_email`.
- [ ] The Google OAuth app is published (or Internal), and `auth --status` shows the expected account and scopes.
- [ ] Everyone with the bearer token understands they act as that single Google account (README → Security model).
- [ ] `ENABLE_DRAFTS` stays off unless needed (restricted scope).

---

## 10. Troubleshooting

| Symptom                                                                              | Likely cause                                                                                                                                        | Fix                                                                                                                                               |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy fails, log says "Refusing to listen on 0.0.0.0 without MCP_HTTP_BEARER_TOKEN" | Variable missing                                                                                                                                    | Set `MCP_HTTP_BEARER_TOKEN` (step 3).                                                                                                             |
| Deploy fails with "Invalid configuration"                                            | A variable has a bad value (exit code 2)                                                                                                            | The log names the variable; fix it.                                                                                                               |
| `502 Application failed to respond` on every URL                                     | The domain's target port doesn't match the port the server listens on (check the startup log line), or an `MCP_HTTP_PORT` variable overrides `PORT` | Settings → Networking → edit the domain's target port to the logged port (usually 8080); remove any `MCP_HTTP_PORT` variable. No redeploy needed. |
| Health check times out                                                               | Port mismatch                                                                                                                                       | Make the domain's target port match the startup log's port (usually 8080), and remove any `MCP_HTTP_PORT` variable.                               |
| `403 Host not allowed`                                                               | `MCP_HTTP_ALLOWED_HOSTS` doesn't include the domain you're calling                                                                                  | Add the exact hostname (no scheme, no path).                                                                                                      |
| `403 Origin not allowed`                                                             | A browser client sends `Origin`                                                                                                                     | Add it to `MCP_HTTP_ALLOWED_ORIGINS`.                                                                                                             |
| `401` with the right token                                                           | Header copied with quotes, whitespace, or the wrong scheme                                                                                          | Send exactly `Authorization: Bearer <token>`.                                                                                                     |
| Tools return "Not signed in to Google"                                               | `GOOGLE_TOKEN_JSON` unset or C1 not deployed                                                                                                        | Set it; confirm the deployed commit includes C1.                                                                                                  |
| Tools return "token … missing required fields" / "not valid JSON"                    | Truncated or wrapped base64                                                                                                                         | Re-encode with `tr -d '\n'` (macOS) or `-w0` (Linux).                                                                                             |
| Sign-in expires after ~7 days                                                        | OAuth app still in Testing                                                                                                                          | Publish the app (R7), re-auth, update the variable.                                                                                               |
| `405` on `GET /mcp`                                                                  | Expected: the endpoint is stateless and POST-only                                                                                                   | Nothing to fix.                                                                                                                                   |

---

## 11. Known limitations of this deployment

- One Google account for all callers (v1).
- No OAuth resource-server mode, so no ChatGPT or Claude.ai connectors (T2.10).
- In-memory rate limit and idempotency cache, so a single replica only, and both reset on restart.
- The audit log lives only in Railway's log retention unless forwarded.

---

## 12. Rollout checklist

1. [x] Implement C1 (+ tests), C2 (+ test), C3; CI green.
2. [ ] Publish the Google OAuth app; re-run `auth`; `auth --status` OK.
3. [ ] Create the Railway project/service from the repo.
4. [ ] Set variables (§5 step 3) with `EMAIL_DRY_RUN=true`.
5. [ ] Deploy; health check passes.
6. [ ] Generate the domain; set `MCP_HTTP_ALLOWED_HOSTS`; redeploy.
7. [ ] Verification steps 1–7 (§6).
8. [ ] `EMAIL_DRY_RUN=false`; verification steps 8–9.
9. [ ] Security checklist (§9).
10. [ ] Configure hosts (§7); record results in [compatibility.md](compatibility.md).
