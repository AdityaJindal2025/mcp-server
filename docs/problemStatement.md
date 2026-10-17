# Problem Statement: Generic Gmail + Google Docs MCP Server

> **How to use this file:** Open the (empty) project folder in VS Code and point your coding agent (Copilot agent mode, Claude Code, Cline, etc.) at this file, e.g.
> *"Read problemStatement.md and implement Phase 1. Follow the tool contracts in §6 exactly and ask before deviating."*
> Sections are ordered so the project can be built top to bottom.

---

## 1. Background

AI agents (ChatGPT, Claude, Gemini, Copilot, custom agents) increasingly need to take actions in Google Workspace: "email this summary to the team", "append today's standup notes to the running doc". Each agent platform historically had its own integration mechanism, so the same capability gets rebuilt per platform, and many built-in connectors are read-only or can't append to an arbitrary existing doc.

The **Model Context Protocol (MCP)** is the open standard that all major agent hosts now support. One MCP server exposing a small, well-defined set of Gmail and Google Docs actions can be plugged into any of them.

## 2. Problem

We need **one self-hostable MCP server** that lets any MCP-compatible agent:

1. **Send an email** from a Gmail / Google Workspace account.
2. **Append content to an existing Google Doc** without overwriting, reordering or deleting anything already in it.

It must work **unchanged** across hosts that differ in transport (local stdio vs. remote HTTP), MCP protocol revision, authentication expectations and JSON Schema strictness.

## 3. Goals

| ID | Goal | How we know |
|----|------|-------------|
| G1 | Same build + same tool contracts work across hosts | Scenarios S1–S3 pass in VS Code, Claude (Desktop or Code), Gemini CLI and one OpenAI surface (ChatGPT or Responses API), with only host-side config differing |
| G2 | Safe by default | Least-privilege scopes, append-only doc access, recipient/rate guardrails, no secrets in logs |
| G3 | Fast setup | A developer goes from clone to first successful tool call in < 15 min using the README |
| G4 | Models use the tools correctly | In the scenario prompts, models pick the right tool and valid arguments on the first attempt |

## 4. Non-goals (v1)

- **Reading, searching or deleting email.** Requires restricted Gmail scopes (Google security assessment for external apps) and widens the blast radius.
- **Editing, replacing or deleting existing doc content.** Append-only is the contract.
- **Creating new Google Docs.** Target is existing docs only (candidate for P2).
- **Multi-tenant hosting** where each caller brings their own Google account. v1 = one Google account per server instance.
- **Email attachments** and **threaded replies** (reply threading needs read scopes to fetch the original `Message-ID`). Both P2.
- **Any UI.** The server is headless; the agent host is the UI.

## 5. Users and core scenarios

**Personas:** (a) the *owner/developer* who installs, authenticates and configures the server; (b) the *agent user* who talks to ChatGPT/Claude/Gemini/Copilot and asks it to do things.

| ID | Scenario | Expected tool calls |
|----|----------|---------------------|
| S1 | "Summarize this and email it to teammate@example.com with subject 'Weekly update'." | `gmail_send_email` |
| S2 | "Append these release notes to our changelog doc: <doc URL>." | `gdocs_get_document_info` → `gdocs_append_text` |
| S3 | "Add these 5 test results as a table at the end of the QA tracker doc." | `gdocs_append_table` (P1) |
| S4 | A scheduled/headless agent appends daily metrics to a doc. | `gdocs_append_text` over HTTP transport |

---

## 6. Functional requirements: tool contracts

### 6.1 Tool inventory

| Tool | Priority | Side effect | Google scope |
|------|----------|-------------|--------------|
| `gmail_send_email` | P0 | Sends email (irreversible) | `gmail.send` |
| `gdocs_get_document_info` | P0 | None (read-only) | `documents` |
| `gdocs_append_text` | P0 | Appends to doc | `documents` |
| `gdocs_append_table` | P1 | Appends to doc | `documents` |
| `gmail_create_draft` | P1, opt-in | Creates draft | `gmail.compose` (restricted) |

Tool contracts below are the **public API**. Changing a name, required field or output shape is a breaking change and must be deliberate (enforced by the schema snapshot test in §14).

### 6.2 `gmail_send_email` (P0)

**Description (shown to the model):**
"Send an email from the connected Gmail account. This sends immediately and cannot be undone. If the user has not clearly stated the recipients and content, confirm with them first. Set dry_run to true to preview without sending."

**Input schema**
```json
{
  "type": "object",
  "properties": {
    "to":          { "type": "array", "items": { "type": "string" }, "description": "Recipient email addresses, e.g. [\"alex@example.com\"]. At least one." },
    "cc":          { "type": "array", "items": { "type": "string" }, "description": "Optional CC addresses." },
    "bcc":         { "type": "array", "items": { "type": "string" }, "description": "Optional BCC addresses." },
    "subject":     { "type": "string", "description": "Subject line, plain text, max 250 characters." },
    "body":        { "type": "string", "description": "Email body. Plain text unless body_format is 'html'." },
    "body_format": { "type": "string", "enum": ["text", "html"], "description": "Format of body. Default 'text'." },
    "dry_run":     { "type": "boolean", "description": "If true, validate and return the composed email without sending. Default false." }
  },
  "required": ["to", "subject", "body"]
}
```

**Output (`structuredContent`)**: `{ status: "sent" | "dry_run", message_id, thread_id, to[], cc[], bcc_count, subject }`
**Text content**: one human-readable line, e.g. `Email sent to alex@example.com (subject: "Weekly update"). Gmail message id: 18f2…`

**Behaviour**
- Validate and de-duplicate addresses; enforce `EMAIL_MAX_RECIPIENTS` and `EMAIL_ALLOWED_DOMAINS` (§9).
- **Reject any CR/LF** in subject or addresses (header injection).
- Build an RFC 2822 MIME message: UTF-8; RFC 2047-encode non-ASCII subjects; for `html`, send `multipart/alternative` with an auto-generated plain-text part.
- Omit the `From` header (Gmail fills in the authenticated address) unless `GMAIL_SEND_AS` is set to a verified send-as alias.
- Call `gmail.users.messages.send({ userId: "me", requestBody: { raw: base64url(mime) } })`.
- If `EMAIL_DRY_RUN=true` in config, every call behaves as `dry_run: true` and says so in the result.

**Annotations**: `{ title: "Send email", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`

**Acceptance criteria**
- [ ] Plain-text and HTML emails arrive correctly, including a subject containing emoji / non-Latin characters.
- [ ] `dry_run: true` returns the composed message and sends nothing.
- [ ] Address outside the allowlist → `isError` result naming the blocked address; nothing sent.
- [ ] Subject containing `\r\n` → rejected.
- [ ] Missing/expired Google token → `isError` with the exact command to re-authenticate.

### 6.3 `gdocs_get_document_info` (P0)

**Description:** "Get the title, tabs and the last part of an existing Google Doc. Use this to confirm you have the right document before appending to it."

**Input**
```json
{
  "type": "object",
  "properties": {
    "document":   { "type": "string",  "description": "Google Doc URL or document ID." },
    "tail_chars": { "type": "integer", "description": "How many characters from the end of the doc to return (default 500, max 5000)." }
  },
  "required": ["document"]
}
```

**Output**: `{ document_id, title, url, revision_id, tabs: [{ tab_id, title }], end_index, tail_text }`
**Annotations**: `readOnlyHint: true, openWorldHint: true`

### 6.4 `gdocs_append_text` (P0)

**Description:** "Append text to the end of an existing Google Doc. Never modifies or removes existing content."

**Input**
```json
{
  "type": "object",
  "properties": {
    "document":          { "type": "string",  "description": "Google Doc URL or document ID." },
    "text":              { "type": "string",  "description": "Text to append. Use \\n for line breaks." },
    "tab_id":            { "type": "string",  "description": "Optional tab ID for docs that use tabs. Defaults to the tab in the URL, else the first tab." },
    "start_on_new_line": { "type": "boolean", "description": "If true (default), the text starts as a new paragraph." },
    "paragraph_style":   { "type": "string",  "enum": ["NORMAL_TEXT", "TITLE", "HEADING_1", "HEADING_2", "HEADING_3"], "description": "Optional style applied to the appended paragraphs (P1)." }
  },
  "required": ["document", "text"]
}
```

**Output**: `{ document_id, title, url, tab_id, inserted_chars, start_index, end_index, revision_id }`

**Behaviour / implementation notes**
- Accept either an ID or a URL. Parse `docs.google.com/document/d/<ID>/…`, including `/u/0/` variants, and read `?tab=` from the URL if present.
- Read the doc first (use a `fields` mask to keep the payload small; `includeTabsContent: true` when tabs are involved), find the body's end index and the **current `revisionId`**.
- **Gotcha:** a doc body always ends with a final newline, and inserting at the end lands *inside the last paragraph*. If `start_on_new_line` is true and the last paragraph is non-empty, prefix the text with `\n`.
- Write with `documents.batchUpdate` using `insertText` at `endIndex - 1` (with `tabId` when relevant) and `writeControl.requiredRevisionId`. On a revision conflict, re-read and retry up to 2 times.
- P1: apply `paragraph_style` with `updateParagraphStyle` over the inserted range in the same batch.
- Enforce `DOCS_MAX_APPEND_CHARS` and the optional `DOCS_ALLOWED_IDS` allowlist.

**Annotations**: `{ title: "Append to Google Doc", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }`

**Acceptance criteria**
- [ ] Appending to a doc whose last line has text starts a new paragraph (no text merged onto the last line).
- [ ] Appending to an empty doc works.
- [ ] Doc not shared with the authenticated account → `isError`: "The connected Google account (…) does not have edit access to this document."
- [ ] Invalid ID/URL → `isError` with an example of a valid input.
- [ ] Existing content is byte-for-byte unchanged before the insertion point.

### 6.5 `gdocs_append_table` (P1)

**Input**: `document` (string), `rows` (array of arrays of strings, first row = header), `bold_header` (boolean, default true), `tab_id` (string, optional).
**Limits**: configurable, default max 100 rows × 20 columns, every row padded to the same length.
**Implementation**: ensure a new paragraph, `insertTable` at the end, re-read the doc to get cell indices, then insert cell text in **reverse order** (last cell first) in a single `batchUpdate` so earlier indices don't shift; bold the header row.

### 6.6 `gmail_create_draft` (P1, opt-in)

Same input as `gmail_send_email` minus `dry_run`; returns `{ draft_id, message_id }`. Only registered when `ENABLE_DRAFTS=true`, because it requires the **restricted** `gmail.compose` scope. Gives agents a "review before sending" path.

---

## 7. Cross-agent compatibility requirements (the "generic" part)

These rules are what make one server work with ChatGPT, Claude, Gemini, Copilot and custom agents. Treat them as P0.

| ID | Requirement |
|----|-------------|
| C1 | **Two transports, one tool registry.** stdio (for local hosts) and Streamable HTTP on a single `/mcp` endpoint (for remote hosts). Run HTTP in stateless mode. Do not implement the deprecated HTTP+SSE transport. |
| C2 | **Serve current and previous protocol revisions.** Support MCP `2026-07-28` (stateless) **and** `2025-11-25` from the same server, since many hosts still speak the 2025 revision. With the official SDK v2, serving `2026-07-28` is an explicit opt-in; make sure it's enabled without dropping 2025 support. |
| C3 | **Tools only.** Expose everything as tools, the one primitive every host supports. Don't require sampling, roots or logging (deprecated in 2026-07-28), elicitation, resources or prompts. Elicitation-based confirmation may be added later as an *optional* enhancement. |
| C4 | **Portable JSON Schema subset.** Top level `type: "object"`; properties limited to `string`, `integer`, `number`, `boolean`, string `enum`, and arrays of those (arrays of string arrays allowed for tables). **No** `oneOf`/`anyOf`/`allOf`, `$ref`/`$defs`, `patternProperties`, map-style `additionalProperties`, nullable type arrays, or reliance on `format`/`pattern` for validation. Every property has a `description`. Validate strictly server-side (zod) instead of relying on schema keywords. |
| C5 | **Naming.** Tool names are `snake_case`, match `^[a-z0-9_]{1,40}$`, and are prefixed by service (`gmail_`, `gdocs_`). Some hosts prefix the server name and cap the total at 64 characters. |
| C6 | **Dual result format.** Every result returns a concise text `content` block (for hosts that only read text) **and** `structuredContent` that matches a declared `outputSchema` exactly. No extra properties: some clients validate strictly and reject responses with unexpected fields. |
| C7 | **Error semantics.** Google/validation failures are returned as tool results with `isError: true` and an actionable message the model can act on. JSON-RPC protocol errors are only for malformed requests. |
| C8 | **Model-agnostic descriptions.** 1–3 sentences: what it does, side effects, when *not* to use it. No host-specific wording ("Claude should…"). Defaults are stated in the description, not assumed. |
| C9 | **stdout hygiene.** In stdio mode, nothing except JSON-RPC goes to stdout. All logs go to stderr. (This is the #1 cause of "server disconnected" in local hosts.) |
| C10 | **Bounded payloads.** Keep each tool response under ~25 KB. `tail_text` and echoed content are capped. |
| C11 | **Non-interactive at call time.** A tool call never opens a browser or waits for input. Auth happens out-of-band via the `auth` CLI command (§8). |

---

## 8. Authentication and authorization

There are **two separate layers**. Keep them separate in code and docs:

1. **Server → Google:** which Google account the server acts as.
2. **Agent host → Server:** who is allowed to call the server (relevant for HTTP only).

In v1, every authorized caller acts as the single configured Google account. The README must state this clearly.

### 8.1 Server → Google (P0)

- Google Cloud project with the **Gmail API** and **Google Docs API** enabled; OAuth client of type **Desktop app**.
- `auth` CLI command (`npx gmail-docs-mcp auth`) runs the installed-app loopback flow, then stores the refresh token at `GOOGLE_TOKEN_PATH` with `0600` permissions (P1: OS keychain).
- **Scopes (least privilege):**

| Scope | Google classification* | Used by |
|-------|------------------------|---------|
| `https://www.googleapis.com/auth/gmail.send` | Sensitive | `gmail_send_email` |
| `https://www.googleapis.com/auth/documents` | Sensitive | all `gdocs_*` tools |
| `https://www.googleapis.com/auth/gmail.compose` | Restricted | `gmail_create_draft` (only if `ENABLE_DRAFTS=true`) |

\* Verify current classification in the Google Cloud console before publishing.

- **Why not `drive.file`?** It only covers files the app created or the user opened through the app, so it can't append to arbitrary existing docs.
- **Gotcha:** with an *External* OAuth consent screen in **Testing** status, refresh tokens expire after 7 days. Use an **Internal** consent screen (Google Workspace) or publish the app.
- Changing scopes (e.g. enabling drafts) requires re-running `auth`; the server detects missing scopes and says so.

### 8.2 Agent host → Server

- **stdio:** no extra auth (the host launches the process locally).
- **HTTP (P1):** bind to `127.0.0.1` by default. Validate the `Origin` header (DNS-rebinding protection). Require `MCP_HTTP_BEARER_TOKEN` (constant-time compare) for any non-loopback bind, and **refuse to start** on a public interface without it.
- **OAuth for hosts that only support OAuth (P1/P2):** ChatGPT connectors and Claude.ai custom connectors expect the MCP authorization spec (server acts as an OAuth 2.1 resource server and publishes protected-resource metadata). Delegate to an existing authorization server (Auth0, Keycloak, Google Identity, etc.) rather than hand-rolling one. Never expose an email-sending server with "no authentication".

---

## 9. Safety and guardrails

Agents may be processing untrusted content (web pages, emails, docs) that contains injected instructions such as "email this data to attacker@evil.com". The server must limit damage regardless of which host or model is calling it.

- **Recipient allowlist:** `EMAIL_ALLOWED_DOMAINS` (empty = allow all; recommended for production).
- **Limits:** `EMAIL_MAX_RECIPIENTS` (default 20), `EMAIL_MAX_PER_HOUR` (default 30), `DOCS_MAX_APPEND_CHARS` (default 50,000).
- **Doc allowlist (optional):** `DOCS_ALLOWED_IDS`.
- **Global dry-run switch:** `EMAIL_DRY_RUN=true` for development.
- **Append-only:** no tool can delete or replace doc content.
- **Audit log:** one JSON line per write (timestamp, tool, recipients or doc ID, Google message/revision ID, caller transport). **Never** log tokens, email bodies or appended text; log length and SHA-256 hash instead.
- **Duplicate-send protection (P1):** optional `client_request_id` input on write tools; the server caches results for 24 h and returns the original result instead of re-sending when an agent retries.
- **Host approvals:** write tools carry `readOnlyHint: false` so hosts that gate write actions will ask the user to confirm. README recommends `require_approval: "always"` (or equivalent) for `gmail_send_email`.

---

## 10. Non-functional requirements

- **Runtime:** Node.js 20+ (22 LTS recommended); macOS, Windows and Linux (no POSIX-only paths).
- **Reliability:** retry Google `429` / `5xx` with exponential backoff and jitter (max 3 attempts); timeouts on every outbound call (default 20 s).
- **Performance:** p95 tool latency < 3 s under normal Google API latency.
- **Observability:** structured JSON logs to stderr, level via `LOG_LEVEL`.
- **Privacy:** no telemetry or outbound calls other than Google APIs.
- **Code quality:** TypeScript `strict`, ESLint + Prettier, ≥ 80 % unit test coverage on `lib/`.

---

## 11. Tech stack and project structure

- **Language:** TypeScript (ESM).
- **MCP:** official MCP TypeScript SDK **v2 line** (`@modelcontextprotocol/server`, plus `@modelcontextprotocol/express` or Node's `http` for Streamable HTTP). Check npm for the latest stable v2 release before pinning. (Python `mcp` 2.x is an acceptable alternative if preferred; the tool contracts in §6 don't change.)
- **Validation:** `zod` v4 for input/output schemas.
- **Google:** `googleapis` (Gmail v1, Docs v1) + `google-auth-library`.
- **Dev/test:** `tsx`, `vitest`, `msw` or `nock` for HTTP mocking, MCP Inspector for manual testing.

```
gmail-docs-mcp/
├─ src/
│  ├─ index.ts                 # CLI entry: `auth` | `--transport stdio|http`
│  ├─ server.ts                # creates MCP server, registers tools
│  ├─ config.ts                # loads + validates env (zod)
│  ├─ transports/
│  │  ├─ stdio.ts
│  │  └─ http.ts               # Streamable HTTP, bearer + Origin checks
│  ├─ auth/
│  │  ├─ googleClient.ts       # OAuth2 client, token load/refresh, scope check
│  │  └─ authCli.ts            # loopback OAuth flow, writes token file
│  ├─ tools/
│  │  ├─ gmail/sendEmail.ts
│  │  ├─ gmail/createDraft.ts
│  │  ├─ docs/getDocumentInfo.ts
│  │  ├─ docs/appendText.ts
│  │  └─ docs/appendTable.ts
│  └─ lib/
│     ├─ mime.ts               # RFC 2822 / MIME builder, RFC 2047 subjects
│     ├─ docRef.ts             # parse doc ID + tab from URL or ID
│     ├─ guards.ts             # allowlists, rate limits, size limits
│     ├─ errors.ts             # Google error → actionable isError result
│     ├─ audit.ts
│     └─ logger.ts             # stderr only
├─ test/
├─ .vscode/mcp.json
├─ .env.example
├─ Dockerfile                  # P1
├─ README.md
├─ package.json
└─ tsconfig.json
```

**CLI**
```bash
npx gmail-docs-mcp auth                         # one-time Google sign-in
npx gmail-docs-mcp                              # stdio (default)
npx gmail-docs-mcp --transport http --port 3333 # Streamable HTTP at /mcp
```

---

## 12. Configuration (`.env.example`)

```bash
# Google OAuth (Desktop app client)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_TOKEN_PATH=~/.config/gmail-docs-mcp/token.json

# Transport
MCP_TRANSPORT=stdio              # stdio | http
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=3333
MCP_HTTP_BEARER_TOKEN=           # required when host is not loopback
MCP_HTTP_ALLOWED_ORIGINS=        # comma-separated

# Email guardrails
EMAIL_DRY_RUN=false
EMAIL_ALLOWED_DOMAINS=           # e.g. example.com,partner.com (empty = any)
EMAIL_MAX_RECIPIENTS=20
EMAIL_MAX_PER_HOUR=30
GMAIL_SEND_AS=                   # optional verified send-as alias

# Docs guardrails
DOCS_ALLOWED_IDS=                # optional comma-separated doc IDs
DOCS_MAX_APPEND_CHARS=50000

# Optional features
ENABLE_DRAFTS=false              # adds restricted gmail.compose scope

LOG_LEVEL=info
AUDIT_LOG_PATH=                  # optional JSONL file
```

---

## 13. Client setup (README must include tested snippets)

| Host | Transport | Configured in |
|------|-----------|---------------|
| VS Code (Copilot agent mode) | stdio or HTTP | `.vscode/mcp.json` |
| Claude Desktop | stdio | `claude_desktop_config.json` |
| Claude Code | stdio or HTTP | `claude mcp add …` |
| Claude.ai custom connector | HTTP (public HTTPS) | Settings → Connectors (needs OAuth, §8.2) |
| Gemini CLI | stdio or HTTP | `~/.gemini/settings.json` |
| ChatGPT (developer mode / connectors) | HTTP (public HTTPS) | ChatGPT settings (needs OAuth, §8.2) |
| OpenAI Responses API / Agents SDK | HTTP | `tools: [{ type: "mcp", … }]` |
| Cursor, Codex CLI, others | stdio | their MCP config |

Config formats evolve, so verify each snippet against the host's current docs when writing the README.

**VS Code (`.vscode/mcp.json`)**
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

**Claude Desktop / Gemini CLI / Cursor (shared `mcpServers` shape)**
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

**OpenAI Responses API (remote)**
```json
{
  "type": "mcp",
  "server_label": "gmail_docs",
  "server_url": "https://your-host.example.com/mcp",
  "headers": { "Authorization": "Bearer <MCP_HTTP_BEARER_TOKEN>" },
  "require_approval": "always"
}
```

For testing remote hosts locally, expose the HTTP transport through a tunnel (ngrok, cloudflared) **with the bearer token set**.

---

## 14. Testing strategy

1. **Unit (vitest):** MIME builder (unicode subjects, HTML alternative part, header-injection rejection), doc reference parser (IDs, `/edit` URLs, `/u/0/` URLs, `?tab=`), guards, newline-prefix logic, Google error mapping.
2. **Contract test:** start the server in-process, call `tools/list`, and (a) run a **portability linter** that fails on any rule in C4/C5, (b) snapshot all tool schemas so contract changes are always deliberate.
3. **Integration (mocked Google):** success, 401/`invalid_grant`, 403, 404, 429-then-success, revision conflict-then-success.
4. **Protocol:** connect with an SDK client using both `2025-11-25` and `2026-07-28`; both list and call all tools.
5. **Live smoke (opt-in via `LIVE_TESTS=1`):** send an email to self; append text and a table to a scratch doc.
6. **Manual:** MCP Inspector (`npx @modelcontextprotocol/inspector`).
7. **Cross-host matrix:** run S1–S3 in each host from G1; record results in `docs/compatibility.md`.

---

## 15. Definition of done (v1)

- [ ] All P0 tools implemented exactly per §6 and passing their acceptance criteria.
- [ ] stdio works in VS Code, Claude Desktop/Code and Gemini CLI with no code changes between them.
- [ ] Portability linter + schema snapshot tests pass in CI.
- [ ] Both protocol revisions pass the protocol test.
- [ ] Nothing other than JSON-RPC is written to stdout in stdio mode.
- [ ] Guardrails (§9) configurable and covered by tests; no secrets or bodies in logs.
- [ ] README: Google Cloud setup with screenshots-level steps, `auth` flow, all §13 snippets, security model (§8 two layers), troubleshooting (token expiry, missing scopes, doc not shared).

---

## 16. Delivery phases

| Phase | Scope |
|-------|-------|
| **1 – Local MVP (P0)** | Project scaffold, config, `auth` CLI, stdio transport, `gmail_send_email`, `gdocs_get_document_info`, `gdocs_append_text` (plain text), guardrails, audit log, unit + contract tests, VS Code / Claude / Gemini CLI configs. |
| **2 – Remote + richer docs (P1)** | Streamable HTTP with bearer auth + Origin checks, `paragraph_style`, `gdocs_append_table`, `gmail_create_draft` (opt-in), `client_request_id` idempotency, keychain token storage, Dockerfile, OpenAI Responses API verified, OAuth for ChatGPT/Claude.ai connectors. |
| **3 – Extensions (P2)** | Attachments, threaded replies, create new doc, markdown → Docs formatting, service account with domain-wide delegation for headless Workspace deployments, multi-user mode. |

---

## 17. Open questions

| # | Question | Owner | Blocking? |
|---|----------|-------|-----------|
| 1 | Personal Gmail or Google Workspace account? (Workspace enables an *Internal* consent screen and avoids the 7-day token expiry.) | Owner | Yes, for Phase 1 setup |
| 2 | Which hosts are must-have for launch vs. nice-to-have? | Owner | No |
| 3 | Where will the HTTP endpoint be hosted (local tunnel, VM, Cloud Run, internal network)? | Eng | Phase 2 |
| 4 | Which authorization server for OAuth-only hosts (ChatGPT, Claude.ai)? Can those hosts send a static bearer header instead? Verify current behaviour. | Eng | Phase 2 |
| 5 | Should `gmail_send_email` be restricted to an allowlist of domains in production by default? | Owner / Security | No |
| 6 | Are HTML emails needed in v1, or is plain text enough? | Owner | No |
| 7 | Do target docs use Docs tabs? (Affects default tab behaviour.) | Owner | No |

---

## 18. References

- MCP specification (latest revision + changelog): https://modelcontextprotocol.io/specification
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk
- Gmail API `users.messages.send`: https://developers.google.com/gmail/api/reference/rest/v1/users.messages/send
- Google Docs API `documents.batchUpdate`: https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate
- Google OAuth 2.0 scopes: https://developers.google.com/identity/protocols/oauth2/scopes
