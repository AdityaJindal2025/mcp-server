# gmail-docs-mcp

A self-hostable [Model Context Protocol](https://modelcontextprotocol.io) server that lets any MCP-compatible agent (VS Code Copilot, Claude, Gemini CLI, ChatGPT and the OpenAI Responses API, Cursor, Codex and custom agents) **send email from Gmail** and **append to existing Google Docs**.

- One build and one set of tool contracts for every host. Only the host-side config differs.
- Both transports: **stdio** for local hosts, and **Streamable HTTP** (stateless, single `/mcp` endpoint) for remote hosts.
- Both protocol revisions: MCP **`2026-07-28`** and **`2025-11-25`**.
- Safe by default: least-privilege scopes, append-only doc writes, recipient and rate guardrails, and an audit log that never contains email bodies, document text or tokens.

> **Security model in one sentence:** every caller allowed to reach this server acts as the **one Google account** you sign in with. Treat access to the server like access to that mailbox. See [Security model](#security-model).

**What it does not do (v1):** read, search or delete email; edit, replace or delete existing document content; create new docs; send attachments or threaded replies; host multiple users' Google accounts.

---

## Contents

- [Quick start](#quick-start)
- [Google Cloud setup](#google-cloud-setup)
- [Sign in (`auth`)](#sign-in-auth)
- [Connect a host](#connect-a-host)
- [Tool reference](#tool-reference)
- [Security model](#security-model)
- [Guardrails and production settings](#guardrails-and-production-settings)
- [Running over HTTP](#running-over-http)
- [Configuration reference](#configuration-reference)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

---

## Quick start

Prerequisites: **Node.js 20+** (22 LTS recommended) and a Google account. Target time: under 15 minutes.

```bash
git clone <this repo> gmail-docs-mcp && cd gmail-docs-mcp
npm ci
npm run build
cp .env.example .env            # then fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
```

1. Create a Google OAuth client: [Google Cloud setup](#google-cloud-setup) (about 5 minutes).
2. Sign in once:
   ```bash
   node dist/index.js auth       # or: npx gmail-docs-mcp auth
   ```
3. Add the server to your agent host: [Connect a host](#connect-a-host).
4. Try it: _"Email a one-line hello to me@example.com with subject 'MCP test'. Use dry_run first."_

While testing, set `EMAIL_DRY_RUN=true` in `.env`: every send then becomes a preview and nothing is sent.

---

## Google Cloud setup

You need a Google Cloud project with an OAuth client of type **Desktop app**.

1. **Create or select a project.** Open <https://console.cloud.google.com/>, then use the project picker at the top and choose **New project**. Give it a name (for example `gmail-docs-mcp`) and click **Create**.
2. **Enable the APIs.** Go to **APIs & Services → Library** and enable:
   - **Gmail API**
   - **Google Docs API**
3. **Configure the OAuth consent screen** (**APIs & Services → OAuth consent screen**, or **Google Auth Platform → Branding/Audience** in the newer console):
   - **Google Workspace account:** choose **Internal**. Recommended, because refresh tokens don't expire after 7 days.
   - **Personal Gmail account:** choose **External** and add yourself under **Test users**.
     > ⚠️ With an **External** app in **Testing** status, Google expires refresh tokens after **7 days**. Re-run `auth` when that happens, or publish the app.
   - App name, support email and developer email: fill in anything sensible.
   - **Scopes** (optional on this screen; the `auth` command requests them anyway):
     | Scope                                           | Why                                                             |
     | ----------------------------------------------- | --------------------------------------------------------------- |
     | `https://www.googleapis.com/auth/gmail.send`    | `gmail_send_email` (send only: cannot read your mail)           |
     | `https://www.googleapis.com/auth/documents`     | all `gdocs_*` tools                                             |
     | `openid`, `.../auth/userinfo.email`             | to name the connected account in error messages (non-sensitive) |
     | `https://www.googleapis.com/auth/gmail.compose` | only if `ENABLE_DRAFTS=true` (**restricted** scope)             |
4. **Create the OAuth client.** Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**, choose **Application type: Desktop app**, and click **Create**.
5. Copy the **Client ID** and **Client secret** into `.env`:
   ```bash
   GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

> Why `documents` and not `drive.file`? `drive.file` only covers files this app created or that you opened through it, so it can't append to an arbitrary existing doc.

---

## Sign in (`auth`)

```bash
npx gmail-docs-mcp auth           # or: node dist/index.js auth
```

- A browser opens the Google consent screen. If it doesn't open (for example on a headless machine), copy the printed URL into any browser.
- Sign in, **leave every permission ticked**, and you're done. The terminal prints `Authenticated as you@example.com. Token saved to …`.
- The token file (`GOOGLE_TOKEN_PATH`, default `~/.config/gmail-docs-mcp/token.json`) is written with `0600` permissions. It holds the refresh token plus the OAuth client ID and secret (Google's `authorized_user` format), so the server only needs `GOOGLE_TOKEN_PATH` at runtime.
- On platforms without secret files (Railway, most PaaS), put the token file's contents in **`GOOGLE_TOKEN_JSON`** instead, as raw or base64 JSON: `base64 -i ~/.config/gmail-docs-mcp/token.json | tr -d '\n'`. It takes precedence over `GOOGLE_TOKEN_PATH`, is read-only, and its value never appears in logs or error messages.
- Check the stored sign-in at any time:
  ```bash
  npx gmail-docs-mcp auth --status
  ```
- Changed scopes (for example enabled drafts)? Run `auth` again. Tools tell you when a permission is missing.

Tool calls **never** open a browser or prompt. If the sign-in is missing or expired, the tool returns an error containing the exact command to run.

---

## Connect a host

Build first (`npm run build`). The examples use absolute paths; replace them with yours. Host config formats evolve, so check each host's current MCP docs if a snippet doesn't work.

### VS Code (Copilot agent mode)

`.vscode/mcp.json` (already in this repo):

```json
{
  "servers": {
    "gmail-docs": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/index.js"],
      "envFile": "${workspaceFolder}/.env"
    }
  }
}
```

Over HTTP (with the server started separately, see [Running over HTTP](#running-over-http)):

```json
{
  "servers": {
    "gmail-docs": {
      "type": "http",
      "url": "http://127.0.0.1:3333/mcp",
      "headers": { "Authorization": "Bearer ${input:gmailDocsToken}" }
    }
  },
  "inputs": [
    {
      "id": "gmailDocsToken",
      "type": "promptString",
      "description": "MCP bearer token",
      "password": true
    }
  ]
}
```

### Claude Desktop

`claude_desktop_config.json` (**Settings → Developer → Edit Config**):

```json
{
  "mcpServers": {
    "gmail-docs": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-docs-mcp/dist/index.js"],
      "env": { "GOOGLE_TOKEN_PATH": "/absolute/path/to/token.json" }
    }
  }
}
```

### Claude Code

```bash
# stdio
claude mcp add gmail-docs --env GOOGLE_TOKEN_PATH=/absolute/path/to/token.json -- node /absolute/path/to/gmail-docs-mcp/dist/index.js

# HTTP
claude mcp add --transport http gmail-docs http://127.0.0.1:3333/mcp --header "Authorization: Bearer $MCP_HTTP_BEARER_TOKEN"
```

### Gemini CLI

`~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "gmail-docs": {
      "command": "node",
      "args": ["/absolute/path/to/gmail-docs-mcp/dist/index.js"],
      "env": { "GOOGLE_TOKEN_PATH": "/absolute/path/to/token.json" }
    }
  }
}
```

Over HTTP: `{ "mcpServers": { "gmail-docs": { "httpUrl": "http://127.0.0.1:3333/mcp", "headers": { "Authorization": "Bearer <token>" } } } }`.

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project) uses the same `mcpServers` shape as Claude Desktop above.

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.gmail-docs]
command = "node"
args = ["/absolute/path/to/gmail-docs-mcp/dist/index.js"]
env = { GOOGLE_TOKEN_PATH = "/absolute/path/to/token.json" }
```

### OpenAI Responses API / Agents SDK (remote)

The server must be reachable over public HTTPS. See [Running over HTTP](#running-over-http).

```json
{
  "type": "mcp",
  "server_label": "gmail_docs",
  "server_url": "https://your-host.example.com/mcp",
  "headers": { "Authorization": "Bearer <MCP_HTTP_BEARER_TOKEN>" },
  "require_approval": "always"
}
```

### ChatGPT connectors and Claude.ai custom connectors

These hosts expect the server to act as an **OAuth 2.1 resource server** (the MCP authorization spec), backed by an authorization server such as Auth0, Keycloak or Google Identity. **That mode isn't implemented yet** (plan task T2.10, blocked on choosing the authorization server). Until then, use one of the hosts above. Never expose this server publicly without authentication.

---

## Tool reference

Generated from the server's `tools/list` output (`npm run docs:tools`). Changing a tool name, a required field or an output shape is a breaking change; the schema snapshot test enforces this.

<!-- tools:start -->

### `gmail_send_email`

Send an email from the connected Gmail account. This sends immediately and cannot be undone. If the user has not clearly stated the recipients and content, confirm with them first. Set dry_run to true to preview without sending.

Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.

| Input               | Type                 | Required | Description                                                                                                                                                              |
| ------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `to`                | string[]             | yes      | Recipient email addresses, e.g. ["alex@example.com"]. At least one.                                                                                                      |
| `cc`                | string[]             |          | Optional CC addresses.                                                                                                                                                   |
| `bcc`               | string[]             |          | Optional BCC addresses.                                                                                                                                                  |
| `subject`           | string               | yes      | Subject line, plain text, max 250 characters.                                                                                                                            |
| `body`              | string               | yes      | Email body. Plain text unless body_format is 'html'.                                                                                                                     |
| `body_format`       | `"text"` \| `"html"` |          | Format of body. Default 'text'.                                                                                                                                          |
| `client_request_id` | string               |          | Optional unique ID for this request (max 128 characters). If the same ID is sent again within 24 hours, the original result is returned instead of repeating the action. |
| `dry_run`           | boolean              |          | If true, validate and return the composed email without sending. Default false.                                                                                          |

Output (`structuredContent`): `status`, `message_id`, `thread_id`, `to`, `cc`, `bcc_count`, `subject`.

### `gdocs_get_document_info`

Get the title, tabs and the last part of an existing Google Doc. Use this to confirm you have the right document before appending to it. Returns the last 500 characters by default.

Annotations: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.

| Input        | Type    | Required | Description                                                                    |
| ------------ | ------- | -------- | ------------------------------------------------------------------------------ |
| `document`   | string  | yes      | Google Doc URL or document ID.                                                 |
| `tail_chars` | integer |          | How many characters from the end of the doc to return (default 500, max 5000). |

Output (`structuredContent`): `document_id`, `title`, `url`, `revision_id`, `tabs`, `end_index`, `tail_text`.

### `gdocs_append_text`

Append text to the end of an existing Google Doc. Never modifies or removes existing content. Starts a new paragraph by default.

Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.

| Input               | Type                                                                            | Required | Description                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `document`          | string                                                                          | yes      | Google Doc URL or document ID.                                                                                                                                           |
| `text`              | string                                                                          | yes      | Text to append. Use \n for line breaks.                                                                                                                                  |
| `tab_id`            | string                                                                          |          | Optional tab ID for docs that use tabs. Defaults to the tab in the URL, else the first tab.                                                                              |
| `start_on_new_line` | boolean                                                                         |          | If true (default), the text starts as a new paragraph.                                                                                                                   |
| `paragraph_style`   | `"NORMAL_TEXT"` \| `"TITLE"` \| `"HEADING_1"` \| `"HEADING_2"` \| `"HEADING_3"` |          | Optional style applied to the appended paragraphs (P1).                                                                                                                  |
| `client_request_id` | string                                                                          |          | Optional unique ID for this request (max 128 characters). If the same ID is sent again within 24 hours, the original result is returned instead of repeating the action. |

Output (`structuredContent`): `document_id`, `title`, `url`, `tab_id`, `inserted_chars`, `start_index`, `end_index`, `revision_id`.

### `gdocs_append_table`

Append a table to the end of an existing Google Doc; the first row is the header and is bold by default. Never modifies or removes existing content. Use gdocs_append_text for plain text.

Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.

| Input               | Type       | Required | Description                                                                                                                                                              |
| ------------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `document`          | string     | yes      | Google Doc URL or document ID.                                                                                                                                           |
| `rows`              | string[][] | yes      | Table rows as arrays of cell strings; the first row is the header. Shorter rows are padded with empty cells.                                                             |
| `bold_header`       | boolean    |          | If true (default), the header row is bold.                                                                                                                               |
| `tab_id`            | string     |          | Optional tab ID for docs that use tabs. Defaults to the tab in the URL, else the first tab.                                                                              |
| `client_request_id` | string     |          | Optional unique ID for this request (max 128 characters). If the same ID is sent again within 24 hours, the original result is returned instead of repeating the action. |

Output (`structuredContent`): `document_id`, `title`, `url`, `tab_id`, `row_count`, `column_count`, `start_index`, `end_index`, `revision_id`.

### `gmail_create_draft`

Create a draft email in the connected Gmail account without sending it, so the user can review and send it themselves. Use this instead of gmail_send_email when the user wants to review first.

Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`, `openWorldHint: true`.

Registered only when `ENABLE_DRAFTS=true`.

| Input               | Type                 | Required | Description                                                                                                                                                              |
| ------------------- | -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `to`                | string[]             | yes      | Recipient email addresses, e.g. ["alex@example.com"]. At least one.                                                                                                      |
| `cc`                | string[]             |          | Optional CC addresses.                                                                                                                                                   |
| `bcc`               | string[]             |          | Optional BCC addresses.                                                                                                                                                  |
| `subject`           | string               | yes      | Subject line, plain text, max 250 characters.                                                                                                                            |
| `body`              | string               | yes      | Email body. Plain text unless body_format is 'html'.                                                                                                                     |
| `body_format`       | `"text"` \| `"html"` |          | Format of body. Default 'text'.                                                                                                                                          |
| `client_request_id` | string               |          | Optional unique ID for this request (max 128 characters). If the same ID is sent again within 24 hours, the original result is returned instead of repeating the action. |

Output (`structuredContent`): `draft_id`, `message_id`.

<!-- tools:end -->

### Behaviour notes

- **`gmail_send_email`**
  - Addresses are validated, then de-duplicated across to/cc/bcc. Bare addresses only (no `"Name" <addr>`).
  - CR/LF in the subject or an address is rejected (header injection).
  - Non-ASCII subjects are RFC 2047-encoded. HTML is sent as `multipart/alternative` with a generated plain-text part.
  - `From` is omitted (Gmail uses the signed-in account) unless `GMAIL_SEND_AS` is set to a verified send-as alias.
  - A dry run returns `status: "dry_run"` with empty `message_id`/`thread_id`; the preview of the composed email is in the text content.
  - Google 5xx errors and timeouts are **not** retried, because the email may already have been sent. 429s are retried.
- **`gdocs_append_text`**
  - Inserts at the end of the body. If `start_on_new_line` is true (the default) and the last line has text, a newline is added first, so nothing merges onto the last line.
  - New paragraphs split off the last line are reset to normal text without bullets, unless `paragraph_style` is given. A style only ever applies to the new paragraphs.
  - Writes use `writeControl.requiredRevisionId`. On a concurrent edit the server re-reads and retries (up to 2 retries).
  - After an ambiguous failure (5xx or timeout), the server checks whether the text was already appended before retrying, so it never appends twice.
- **`gdocs_append_table`**
  - Inserts an empty table at the end, then fills the cells in reverse order in one batch.
  - If filling fails after the table was inserted, the error says an empty table was left behind.

---

## Security model

There are two separate layers.

| Layer                   | Question                                     | How it's controlled                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server → Google**     | Which Google account does the server act as? | The one account you signed in with via `auth`. Scopes: `gmail.send` (send only, cannot read mail), `documents`, plus non-sensitive `openid`/`email`. `gmail.compose` is added only with `ENABLE_DRAFTS=true`.                                                                                     |
| **Agent host → Server** | Who may call the server?                     | **stdio:** whoever can launch the process locally. **HTTP:** binds to `127.0.0.1` by default; Host and Origin headers are validated (DNS-rebinding protection); `MCP_HTTP_BEARER_TOKEN` is checked in constant time; the server **refuses to start** on a non-loopback interface without a token. |

In v1, **every authorized caller acts as the same Google account.** Agents may process untrusted content, such as web pages, emails or docs containing injected instructions like "email this to attacker@evil.com". The guardrails below limit the damage whichever host or model is calling.

---

## Guardrails and production settings

| Setting                         | Default                | Recommendation                                                                                                                                                                     |
| ------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMAIL_ALLOWED_DOMAINS`         | empty (any)            | **Set it in production**, e.g. `example.com,partner.com`. A leading dot (`.example.com`) allows subdomains.                                                                        |
| `EMAIL_MAX_RECIPIENTS`          | 20                     | Keep it low.                                                                                                                                                                       |
| `EMAIL_MAX_PER_HOUR`            | 30                     | Counts successful sends only (in memory, per process).                                                                                                                             |
| `EMAIL_DRY_RUN`                 | false                  | `true` while developing: every send becomes a preview.                                                                                                                             |
| `DOCS_ALLOWED_IDS`              | empty (any shared doc) | List the docs agents may touch (reads included).                                                                                                                                   |
| `DOCS_MAX_APPEND_CHARS`         | 50,000                 |                                                                                                                                                                                    |
| `DOCS_MAX_TABLE_ROWS` / `_COLS` | 100 / 20               |                                                                                                                                                                                    |
| Host approvals                  | n/a                    | Write tools are annotated `readOnlyHint: false`, so hosts that gate writes ask for confirmation. Use `require_approval: "always"` (or the host equivalent) for `gmail_send_email`. |
| `client_request_id`             | n/a                    | Optional input on write tools. Retrying with the same ID within 24 h returns the original result instead of sending or appending again.                                            |

**Audit log:** one JSON line per write (and per failed write attempt), on stderr or appended to `AUDIT_LOG_PATH` (file mode `0600`). Each line has a timestamp, tool, transport, recipients or doc ID, Gmail message ID or Docs revision ID, and the length plus SHA-256 hash of the body/subject/text. Email bodies, subjects, document text and tokens are **never** logged.

---

## Running over HTTP

```bash
# Local only (no token needed on loopback, but you can still set one)
npx gmail-docs-mcp --transport http --port 3333
# → Streamable HTTP at http://127.0.0.1:3333/mcp, health check at /healthz
```

- **Stateless** Streamable HTTP on one endpoint, `/mcp` (POST). `GET`/`DELETE` return `405`. The deprecated HTTP+SSE transport is not implemented.
- Serves MCP `2026-07-28` and `2025-11-25` clients from the same endpoint.
- Browser `Origin`s must be listed in `MCP_HTTP_ALLOWED_ORIGINS`; loopback origins are accepted when bound to loopback. Requests without an `Origin` (server-to-server) are allowed.
- **Public or tunnel exposure:** set a long random `MCP_HTTP_BEARER_TOKEN` (for example `openssl rand -hex 32`). When a tunnel forwards to `127.0.0.1`, add the tunnel's hostname to `MCP_HTTP_ALLOWED_HOSTS`:
  ```bash
  MCP_HTTP_BEARER_TOKEN=$(openssl rand -hex 32) MCP_HTTP_ALLOWED_HOSTS=my-tunnel.trycloudflare.com \
    npx gmail-docs-mcp --transport http
  cloudflared tunnel --url http://127.0.0.1:3333
  ```

### Docker

Run `auth` on your workstation, then mount the token file into the container:

```bash
docker build -t gmail-docs-mcp .
docker run --rm -p 3333:3333 \
  -e MCP_HTTP_BEARER_TOKEN="$(openssl rand -hex 32)" \
  -v "$HOME/.config/gmail-docs-mcp/token.json:/run/secrets/token.json:ro" \
  gmail-docs-mcp
```

The image binds `0.0.0.0`, so it refuses to start without `MCP_HTTP_BEARER_TOKEN`. It runs as the non-root `node` user and has a `/healthz` health check.

### Railway

[`railway.json`](railway.json) builds the Dockerfile, runs one replica and health-checks `/healthz`. Set `MCP_HTTP_BEARER_TOKEN` and `GOOGLE_TOKEN_JSON` as sealed variables; the server listens on Railway's `PORT` automatically. Full steps, verification and operations: [docs/deploymentPlan.md](docs/deploymentPlan.md).

---

## Configuration reference

All configuration is through environment variables (a `.env` file in the working directory is loaded automatically). CLI flags `--transport`, `--host` and `--port` override the matching variables. The HTTP port is resolved as `--port`, then `MCP_HTTP_PORT`, then `PORT` (set by Railway and similar platforms), then `3333`. See [.env.example](.env.example) for the full list with comments. Invalid values stop the server with exit code `2` and a message naming each bad variable.

```text
gmail-docs-mcp auth                          One-time Google sign-in
gmail-docs-mcp auth --status                 Show the stored sign-in and check it still works
gmail-docs-mcp [--transport stdio]           Serve over stdio (default)
gmail-docs-mcp --transport http [--host H] [--port P]
```

---

## Troubleshooting

| Symptom                                                               | Fix                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool says **"Not signed in to Google"**                               | Run `npx gmail-docs-mcp auth` with the same `GOOGLE_TOKEN_PATH` the host passes to the server.                                                                                                             |
| **"The Google sign-in has expired or was revoked"** (`invalid_grant`) | Run `auth` again. If it happens weekly, your consent screen is External and in Testing status (7-day token expiry): switch to Internal (Workspace) or publish the app.                                     |
| **"missing permission(s): …gmail.compose"** after enabling drafts     | Scopes changed, so run `auth` again and leave every box ticked.                                                                                                                                            |
| **"does not have edit access to this document"**                      | Share the doc with the account named in the message as an **Editor**.                                                                                                                                      |
| **"Document … was not found"**                                        | Check the URL, and that the doc is shared with the connected account. Published-to-web (`/d/e/…/pub`) links can't be used.                                                                                 |
| **"Blocked recipient(s)"**                                            | The address isn't covered by `EMAIL_ALLOWED_DOMAINS`.                                                                                                                                                      |
| Host says **"server disconnected"** right away                        | Run `node dist/index.js` in a terminal to see the stderr log. Common causes: `npm run build` not run, a wrong absolute path, or an invalid env var (exit code 2). This server never writes logs to stdout. |
| **"Refusing to listen on 0.0.0.0 without MCP_HTTP_BEARER_TOKEN"**     | Set a bearer token, or bind to `127.0.0.1`.                                                                                                                                                                |
| HTTP **403 "Host not allowed"** through a tunnel                      | Add the tunnel hostname to `MCP_HTTP_ALLOWED_HOSTS`.                                                                                                                                                       |
| Corporate proxy                                                       | Set `HTTPS_PROXY`; the Google client honours it.                                                                                                                                                           |
| Windows                                                               | Use absolute Windows paths in host configs (`C:\\Users\\me\\...`). The token file is protected by your user profile permissions (`chmod` is a no-op there).                                                |

---

## Development

```bash
npm run dev            # run from source (tsx)
npm test               # unit + contract + integration + protocol + e2e
npm run test:coverage  # coverage gate: ≥ 80 % on src/lib
npm run lint && npm run format:check && npm run typecheck
npm run inspector      # MCP Inspector against dist/index.js
npm run docs:tools     # regenerate the tool reference in this README
```

- **Live smoke tests** (real Google, opt-in). They send email to yourself and append to a scratch doc:
  ```bash
  LIVE_TESTS=1 GOOGLE_TOKEN_PATH=~/.config/gmail-docs-mcp/token.json LIVE_SCRATCH_DOC_ID=<doc id> npm run test:live
  ```
- **Contract changes:** tool schemas are snapshot-tested (`test/contract/__snapshots__`). Update the snapshot with `npx vitest run test/contract -u` only for deliberate changes; CI requires the `contract-change` label on such PRs.
- Design docs: [problem statement](docs/problemStatement.md), [implementation plan](docs/implementationPlan.md), [SDK notes](docs/sdk-notes.md), [compatibility matrix](docs/compatibility.md).
