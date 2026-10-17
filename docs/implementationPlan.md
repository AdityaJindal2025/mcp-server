# Implementation Plan: Generic Gmail + Google Docs MCP Server

> **Source of truth:** [problemStatement.md](problemStatement.md). This plan says _how_ and _in what order_ to build what that document specifies. Where this plan and the problem statement disagree, the problem statement wins unless the deviation is listed in §3 (Decisions) and has been signed off.
>
> **How to use:** Work top to bottom. Each task has an ID (`T1.4`), the files it touches, and a "Done when" check. Don't start a milestone until the previous milestone's exit criteria pass. Section references like "PS §6.4" point at the problem statement.

---

## Contents

1. [Scope summary](#1-scope-summary)
2. [Architecture](#2-architecture)
3. [Decisions and proposed deviations](#3-decisions-and-proposed-deviations)
4. [Phase 0: Spike and scaffold](#4-phase-0-spike-and-scaffold)
5. [Phase 1: Local MVP (P0)](#5-phase-1-local-mvp-p0)
6. [Phase 2: Remote + richer docs (P1)](#6-phase-2-remote--richer-docs-p1)
7. [Phase 3: Extensions (P2)](#7-phase-3-extensions-p2)
8. [Detailed module designs](#8-detailed-module-designs)
9. [Error catalogue](#9-error-catalogue)
10. [Testing plan](#10-testing-plan)
11. [CI pipeline](#11-ci-pipeline)
12. [Risks and mitigations](#12-risks-and-mitigations)
13. [Traceability matrix](#13-traceability-matrix)
14. [Open questions and when they block](#14-open-questions-and-when-they-block)

---

## 1. Scope summary

| Phase                         | Deliverables                                                                                                                                                                                                           | Rough size        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 0 – Spike & scaffold          | Repo scaffold, toolchain, SDK v2 API confirmation, one "hello" tool over stdio on both protocol revisions                                                                                                              | 1–2 days          |
| 1 – Local MVP (P0)            | Config, logger, `auth` CLI, Google client, `gmail_send_email`, `gdocs_get_document_info`, `gdocs_append_text`, guardrails, audit log, unit/contract/integration/protocol tests, host configs, README                   | 6–9 days          |
| 2 – Remote + richer docs (P1) | Streamable HTTP (bearer + Origin), `paragraph_style`, `gdocs_append_table`, `gmail_create_draft`, `client_request_id`, keychain storage, Dockerfile, OpenAI/ChatGPT/Claude.ai verification, OAuth resource-server mode | 7–10 days         |
| 3 – Extensions (P2)           | Attachments, threaded replies, create doc, markdown→Docs, service account + DWD, multi-user                                                                                                                            | Scoped separately |

**Repo layout decision:** the current folder (`mcp-server/`) _is_ the project root (the problem statement's `gmail-docs-mcp/` folder). The npm package name is `gmail-docs-mcp`, so `npx gmail-docs-mcp …` works once published.

---

## 2. Architecture

### 2.1 Component view

```
                 ┌──────────────────────────── src/index.ts (CLI) ────────────────────────────┐
                 │  `auth`  ──────────────► auth/authCli.ts  (loopback OAuth, writes token)    │
                 │  default / --transport  ► config.ts ─► server.ts ─► transports/{stdio,http} │
                 └─────────────────────────────────────────────────────────────────────────────┘
                                                   │
                         server.ts: createServer(config, deps) → McpServer
                                                   │ registers
          ┌────────────────────────┬───────────────┴───────────┬─────────────────────────┐
          ▼                        ▼                           ▼                         ▼
 tools/gmail/sendEmail   tools/docs/getDocumentInfo   tools/docs/appendText   (P1) appendTable, createDraft
          │                        │                           │
          └──────────── uses ──────┴────────────┬──────────────┘
                                                ▼
   lib/: mime · docRef · docsIndex · guards · rateLimiter · errors · audit · logger · retry · schemaLint
                                                │
                                                ▼
                     auth/googleClient.ts  (OAuth2Client, token load/refresh, scope check)
                                                │
                                                ▼
                                googleapis: gmail v1, docs v1
```

### 2.2 Key design principles

1. **One tool registry, many transports.** `createServer()` is pure: it takes `config` + injected dependencies (Google API clients, clock, audit sink, rate limiter) and returns a configured `McpServer`. Transports only wire it to stdio or HTTP. This makes the contract and protocol tests run in-process without network.
2. **Tool handler = thin orchestration.** Every tool follows the same pipeline:
   `zod parse → guards → Google call(s) via retry wrapper → shape output → audit → return {content, structuredContent}`.
   Any thrown `ToolError` (or mapped Google error) becomes `{ isError: true, content: [{type:"text", text}] }` in a single shared wrapper (`defineTool()` in `lib/tool.ts`).
3. **Pure logic lives in `lib/`** (MIME building, doc-ref parsing, index math, guards). It has no I/O, so it's easy to unit-test to ≥ 80 % coverage.
4. **Dependency injection for Google.** Tools receive `{ gmail, docs }` interfaces, not `googleapis` singletons, so integration tests swap in `nock`-backed or fake clients.
5. **stdout is sacred.** Only the stdio transport writes to stdout. The logger is hard-wired to `process.stderr`, and in stdio mode `console.log/info/debug` are re-pointed to stderr at startup as a safety net.

### 2.3 Request flow: `gdocs_append_text`

```
host ──tools/call──► transport ──► McpServer ──► defineTool wrapper
                                                   │ 1. zod.parse(args)                       (invalid → isError)
                                                   │ 2. parseDocRef(document)                 (bad URL → isError + example)
                                                   │ 3. guards.checkDocAllowed / checkAppendSize
                                                   │ 4. googleClient.ensureScopes(["documents"])
                                                   │ 5. loop (max 3 attempts):
                                                   │      docs.get(fields mask) → endIndex, lastParaEmpty, revisionId
                                                   │      build requests (insertText [+ style])
                                                   │      docs.batchUpdate(writeControl.requiredRevisionId)
                                                   │      on revision conflict → continue loop
                                                   │ 6. audit.write({tool, doc_id, revision_id, len, sha256})
                                                   │ 7. return text + structuredContent
```

---

## 3. Decisions and proposed deviations

Items marked **Needs sign-off** change or interpret the public contract (PS §6) or a stated requirement. Per PS header, ask before implementing them.

| ID  | Decision                                                                                                                                                                                                                               | Rationale                                                                                                                                                                                                       | Status                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| D1  | Request `openid` + `email` scopes in addition to the API scopes, and store the account email from the ID token in the token file.                                                                                                      | The 403 message must name "the connected Google account (…)". `gmail.send` can't call `users.getProfile`, so without this we can't know the address. Both scopes are non-sensitive.                             | **Needs sign-off** (adds scopes beyond the PS §8.1 table) |
| D2  | `gmail_send_email` with `dry_run` returns `message_id: ""` and `thread_id: ""` (always present, empty) rather than omitting them. The composed message preview goes in the **text** content (capped at 4 KB), not `structuredContent`. | Output shape in PS §6.2 has no preview field; some clients require every declared property to be present; nullable type arrays are banned by C4.                                                                | **Needs sign-off**                                        |
| D3  | `messages.send` is **not** auto-retried on 5xx or timeouts; it is retried only on 429 (and on connection errors that provably happened before the request was sent, e.g. `ECONNREFUSED`).                                              | Sending is non-idempotent; a 5xx after Google accepted the message would cause a duplicate email. PS §10 says "retry 429/5xx". All other Google calls follow PS §10 as written.                                 | **Needs sign-off**                                        |
| D4  | After an _ambiguous_ `batchUpdate` failure (5xx/timeout), the retry re-reads the doc; if `revisionId` changed **and** the tail now ends with the text we tried to append, treat it as success instead of appending again.              | Prevents duplicate appends while still meeting the "retry up to 2 times on revision conflict" rule.                                                                                                             | Implementation detail, no contract change                 |
| D5  | When `start_on_new_line` is true and `paragraph_style` is not given, apply `NORMAL_TEXT` to the newly created paragraphs **and** strip bullets from them.                                                                              | Inserting `\n…` at the end of a heading or bullet paragraph makes the new paragraphs inherit that heading/bullet style, which surprises users. Only the inserted range is touched, so append-only is preserved. | **Needs sign-off** (behaviour not in PS)                  |
| D6  | Rate limiting (`EMAIL_MAX_PER_HOUR`) and idempotency cache (P1) are in-memory per process.                                                                                                                                             | v1 = one account per instance; horizontal scaling is out of scope. Documented in README.                                                                                                                        | Accepted                                                  |
| D7  | Email address validation uses a pragmatic regex + structural checks in `lib/guards.ts`, not zod's `.email()`.                                                                                                                          | `.email()` emits `format`/`pattern` in the generated JSON Schema, which violates C4.                                                                                                                            | Accepted                                                  |
| D8  | HTML→plain-text for the `multipart/alternative` part uses `html-to-text`.                                                                                                                                                              | Well-maintained, no native deps.                                                                                                                                                                                | Accepted                                                  |
| D9  | Token file stores `{ refresh_token, scope, token_type, account_email, created_at }` only (no access token).                                                                                                                            | Smaller blast radius if leaked; access tokens are cheap to mint.                                                                                                                                                | Accepted                                                  |
| D10 | MCP SDK: TypeScript SDK v2 (`@modelcontextprotocol/server`). Exact version pinned in Phase 0 after checking npm. If v2 can't serve both `2025-11-25` and `2026-07-28` (C2), stop and escalate before writing tools.                    | PS §11.                                                                                                                                                                                                         | Confirm in T0.3                                           |

---

## 4. Phase 0: Spike and scaffold

**Goal:** prove the SDK can do everything C1/C2/C6 need before building on it.

### T0.1 Repo scaffold

- Files: `package.json`, `tsconfig.json`, `.gitignore`, `.editorconfig`, `.nvmrc` (`22`), `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, `src/index.ts` (placeholder).
- `package.json`:
  - `"type": "module"`, `"engines": { "node": ">=20" }`, `"bin": { "gmail-docs-mcp": "dist/index.js" }`, `"files": ["dist", "README.md", "LICENSE"]`.
  - Scripts: `build` (`tsc -p tsconfig.build.json`), `dev` (`tsx src/index.ts`), `test`, `test:watch`, `test:coverage`, `test:live` (`LIVE_TESTS=1 vitest run test/live`), `lint`, `format`, `typecheck`, `inspector` (`npx @modelcontextprotocol/inspector node dist/index.js`).
- `tsconfig.json`: `strict: true`, `module`/`moduleResolution`: `NodeNext`, `target: ES2022`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `outDir: dist`.
- `dist/index.js` starts with `#!/usr/bin/env node`; build step preserves it.
- `.gitignore` includes `.env`, `token.json`, `*.jsonl`, `dist/`, `coverage/`.
- **Done when:** `npm run build && npm run lint && npm test` pass on an empty test.

### T0.2 Dependencies

- Runtime: `@modelcontextprotocol/server` (v2, exact pin), `zod@^4`, `googleapis`, `google-auth-library`, `html-to-text`, `open` (browser launch for `auth`).
- HTTP (can be deferred to Phase 2): `@modelcontextprotocol/express` + `express`, **or** Node `http` only. Prefer Node `http` if the SDK transport accepts raw `IncomingMessage`/`ServerResponse`, to keep deps small.
- Dev: `typescript`, `tsx`, `vitest`, `@vitest/coverage-v8`, `nock`, `eslint`, `typescript-eslint`, `prettier`, `@types/node`, `@types/html-to-text`.
- P1: `@napi-rs/keyring` or `keytar` (decide in T2.8).
- **Done when:** `npm ls` is clean and all versions are pinned in `package-lock.json`.

### T0.3 SDK spike (throwaway branch, findings recorded in `docs/sdk-notes.md`)

Confirm and write down the exact API for each of these:

1. Registering a tool with a zod v4 `inputSchema` **and** `outputSchema`, plus `annotations`, `title`, `description`.
2. What JSON Schema the SDK emits for that zod schema (dump `tools/list`). Check for `$schema`, `additionalProperties`, `format`, `pattern`, `default`, integer bounds. These feed the portability linter (T1.13).
3. Returning `structuredContent` + text `content`, and whether the SDK validates `structuredContent` against `outputSchema` server-side.
4. Returning `isError: true` results (with and without `structuredContent`).
5. Enabling protocol `2026-07-28` (explicit opt-in in v2) while keeping `2025-11-25`. Connect an SDK client pinned to each version.
6. Stateless Streamable HTTP: per-request server/transport vs shared, and how to plug in auth/Origin middleware.
7. In-memory client↔server transport for tests.

- **Done when:** a `ping_test` tool can be listed and called over stdio from MCP Inspector, and from an SDK client on both protocol revisions. Notes committed. If item 5 fails, escalate (D10).

### T0.4 Tooling baseline

- ESLint rule `no-console` (error) everywhere except `src/lib/logger.ts`, plus a custom restricted-syntax rule banning `process.stdout.write` outside `src/transports/stdio.ts`.
- Pre-commit isn't required; CI enforces lint/format (§11).
- **Done when:** a deliberate `console.log` in a tool file fails lint.

**Phase 0 exit criteria:** scaffold builds; SDK notes cover all 7 items; dual-protocol `ping_test` works.

---

## 5. Phase 1: Local MVP (P0)

### Milestone M1: Foundations

#### T1.1 `src/lib/logger.ts`

- Structured JSON lines to **stderr only**: `{ ts, level, msg, ...fields }`.
- Levels `debug|info|warn|error`, threshold from `LOG_LEVEL` (default `info`).
- `redact(fields)`: drops keys matching `/token|secret|authorization|body|text|password/i` and replaces them with `"[redacted]"`. Applied to every log call.
- `installStdoutGuard()`: called in stdio mode; re-points `console.log/info/debug/warn` to the logger.
- **Done when:** unit tests show nothing written to stdout and redaction works on nested objects.

#### T1.2 `src/config.ts`

- zod schema over `process.env` (after optional `.env` load via Node 20.6+ `process.loadEnvFile` when `.env` exists in CWD; no `dotenv` dep).
- Parsing rules:
  - Booleans: accept `true|false|1|0` (case-insensitive); anything else is an error.
  - Integers: positive ints with sensible upper bounds (`EMAIL_MAX_RECIPIENTS` ≤ 100, `DOCS_MAX_APPEND_CHARS` ≤ 1,000,000).
  - Lists (`EMAIL_ALLOWED_DOMAINS`, `DOCS_ALLOWED_IDS`, `MCP_HTTP_ALLOWED_ORIGINS`): comma-split, trim, lowercase domains, drop empties.
  - `GOOGLE_TOKEN_PATH`: expand leading `~` with `os.homedir()`, then `path.resolve`. Default `path.join(os.homedir(), ".config", "gmail-docs-mcp", "token.json")` (works on Windows too).
- Export `type Config` and `loadConfig(env = process.env, argv)`. CLI flags (`--transport`, `--port`, `--host`) override env.
- Derived: `requiredScopes(config)` → `gmail.send`, `documents`, `openid`, `email` (D1), plus `gmail.compose` if `ENABLE_DRAFTS`.
- Startup error: print one clear stderr line per invalid var and exit code `2`.
- **Done when:** unit tests cover defaults, every var, bad values, `~` expansion, CLI override.

#### T1.3 `src/lib/errors.ts`

- `class ToolError extends Error { code: ErrorCode; hint?: string }`.
- `mapGoogleError(err, ctx: { tool, docId?, accountEmail? }): ToolError` implementing the catalogue in §9.
- `toToolResult(err): CallToolResult` → `{ isError: true, content: [{ type: "text", text }] }`. Unknown errors become a generic message with a correlation id, and full details are logged to stderr (without secrets).
- **Done when:** a table-driven unit test covers each §9 row.

#### T1.4 `src/lib/retry.ts`

- `withRetry(fn, { attempts: 3, baseMs: 250, maxMs: 4000, retryOn: (err) => boolean, timeoutMs: 20000 })`.
- Full-jitter exponential backoff: `sleep(random(0, min(maxMs, baseMs * 2^n)))`. Honour `Retry-After` when present.
- Timeout via `AbortSignal.timeout(timeoutMs)` passed to googleapis (`{ signal }` request option).
- Predefined predicates: `retryableRead` (429, 500, 502, 503, 504, ECONNRESET, ETIMEDOUT) and `retryableSend` (429, ECONNREFUSED only; D3).
- Injected clock/sleep for deterministic tests.
- **Done when:** unit tests cover success after retry, give-up after 3, Retry-After, no retry on 400/401/403/404.

#### T1.5 `src/lib/tool.ts`: shared tool wrapper

```ts
defineTool({
  name,
  title,
  description,
  annotations,
  input: zodObject,
  output: zodObject,
  handler: async (args, ctx) => ({ text, structured }),
});
```

- Registers with the SDK (API per T0.3 notes).
- Wraps the handler: parse → handler → `outputSchema.strict().parse(structured)` (catches extra fields in dev/tests, which is C6) → `{ content: [{type:"text", text}], structuredContent }`.
- Catches `ToolError`/Google errors and returns `toToolResult`.
- Enforces C10: if the serialized result is > 25 KB, truncate the text content and log a warning. Tools cap their own fields first, so this is a backstop.
- `ctx` carries `{ config, google, audit, rateLimiter, logger, transport: "stdio"|"http", now }`.
- **Done when:** unit tests show an extra output field fails in test mode, errors become `isError`, and oversized output gets truncated.

**M1 exit:** lint, typecheck, unit tests green; coverage on `lib/` ≥ 80 %.

### Milestone M2: Google auth

#### T1.6 `src/auth/authCli.ts`: `gmail-docs-mcp auth`

Flow:

1. Load config; require `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (Desktop app client). If missing, print the setup steps and point to the README section.
2. Start `http.createServer` on `127.0.0.1`, port `0` (OS-assigned). Redirect URI = `http://127.0.0.1:<port>/oauth2callback`.
3. Generate PKCE verifier/challenge (`oauth2Client.generateCodeVerifierAsync()`), plus a random `state`.
4. `generateAuthUrl({ access_type: "offline", prompt: "consent", scope: requiredScopes(config), code_challenge, code_challenge_method: "S256", state })`.
5. Print the URL to **stderr** and try `open(url)`. If that fails (headless machine), the user copies the URL by hand.
6. On callback: verify `state`, exchange `code` + verifier, verify the ID token (`verifyIdToken`) to get `email`.
7. Verify that granted `scope` ⊇ required scopes. If the user unticked a scope on the consent screen, fail with a message listing the missing ones.
8. Write the token file atomically (write `token.json.tmp` with mode `0o600`, then `rename`). `mkdir -p` the parent with `0o700`. On Windows, `chmod` is effectively a no-op, so warn that the file is protected by the user profile ACL only.
9. Reply to the browser with a small "You can close this tab" HTML page, close the server, and print `Authenticated as <email>. Token saved to <path>.` to stderr.
10. Timeout after 5 minutes waiting for the callback.

- Also add `gmail-docs-mcp auth --status`: prints account, granted scopes and token path, and runs a no-op refresh to prove the token works.
- **Done when:** a manual run against a real Google project produces a working token, and unit tests (with a mocked token endpoint) cover the state mismatch, missing scope and timeout paths.

#### T1.7 `src/auth/googleClient.ts`

- `createGoogleClient(config)` → `{ oauth2, gmail, docs, accountEmail, grantedScopes, ensureScopes(needed) }`.
- Loads the token file lazily on first tool call (server still starts without a token so `tools/list` works, which C11 and host onboarding need).
- Missing file → `ToolError(AUTH_REQUIRED)` with message: ``Not signed in to Google. Run `npx gmail-docs-mcp auth` in a terminal, then retry.``
- `ensureScopes(needed)`: compares against stored `scope`. Missing → `ToolError(SCOPE_MISSING)` naming the scopes and the re-auth command (PS §8.1, e.g. after enabling drafts).
- Refresh handled by `google-auth-library`. `invalid_grant` → `ToolError(AUTH_EXPIRED)` with re-auth command and a hint about 7-day expiry in Testing-mode consent screens.
- Never opens a browser (C11).
- `google.options({ timeout: 20000 })`, plus per-call `AbortSignal` from `withRetry`.
- **Done when:** unit tests cover missing file, malformed file, missing scope and `invalid_grant` mapping.

#### T1.8 `src/index.ts`: CLI entry

- Parse argv with Node's built-in `util.parseArgs`: subcommand `auth` (with `--status`), flags `--transport stdio|http`, `--port`, `--host`, `--help`, `--version`.
- `auth` → `runAuthCli()`. Otherwise → `loadConfig` → `createServer` → start the transport.
- Global handlers: `unhandledRejection` / `uncaughtException` log to stderr and exit `1`. `SIGINT`/`SIGTERM` close cleanly.
- **Done when:** `node dist/index.js --help` prints usage to stderr and exits `0`, and `--transport bogus` exits `2`.

**M2 exit:** `npx gmail-docs-mcp auth` works end to end on macOS (and Windows/Linux in CI where possible, using mocks).

### Milestone M3: Server + stdio transport

#### T1.9 `src/server.ts`

- `createServer(config, deps)`:
  - Instantiates `McpServer({ name: "gmail-docs-mcp", version })` with **only** the `tools` capability (C3).
  - Enables protocol revisions `2026-07-28` + `2025-11-25` (per T0.3).
  - Registers P0 tools, plus P1 tools based on config flags (`ENABLE_DRAFTS`).
  - Server `instructions` string (short, model-agnostic): "Tools to send email from and append to Google Docs for one connected Google account. Write tools have real side effects."
- **Done when:** in-process client `tools/list` returns exactly the expected tools.

#### T1.10 `src/transports/stdio.ts`

- `installStdoutGuard()` first, then connect the SDK stdio transport.
- Exit when stdin closes.
- **Done when:** the C9 test (T1.21) passes.

**M3 exit:** MCP Inspector lists tools over stdio; calling any tool without a token returns the `AUTH_REQUIRED` `isError` result.

### Milestone M4: Tools

#### T1.11 `src/lib/guards.ts` + `src/lib/rateLimiter.ts`

- `normalizeAddresses(list)`: trim; reject CR/LF/NUL (header injection, PS §6.2) and commas/semicolons inside a single entry (prevents smuggling extra recipients); validate with pragmatic regex `^[^\s@<>()",;:\\]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$` plus length ≤ 254; lowercase the domain part only; de-duplicate case-insensitively across `to`/`cc`/`bcc` (keep the first occurrence, with precedence to > cc > bcc).
- Display-name forms (`"Alex" <alex@x.com>`) are **rejected** in v1 with a hint to pass bare addresses. That keeps parsing and injection surface small.
- `checkRecipientCount(total, max)` → `ToolError(TOO_MANY_RECIPIENTS)`.
- `checkAllowedDomains(addresses, allowed)`: exact domain match, plus subdomain match only if the allowlist entry starts with `.` (documented). Error names **every** blocked address (PS §6.2 AC).
- `checkSubject(subject)`: no CR/LF, length ≤ 250 characters.
- `checkAppendSize(text, max)`, `checkDocAllowed(docId, allowedIds)`.
- `rateLimiter`: sliding window of send timestamps (in-memory, injected clock). `tryConsume(n=1)`; counts **successful sends only** (dry runs don't count). Error tells the model when the next slot frees up.
- **Done when:** unit tests cover each rule, including unicode local parts being rejected/accepted as documented.

#### T1.12 `src/lib/mime.ts`

- `buildMime({ from?, to, cc, bcc, subject, body, format }): string` (CRLF line endings).
- Headers: `MIME-Version: 1.0`, `To`, `Cc` (if any), `Bcc` (if any; Gmail strips it from delivered copies), `Subject`, `Date` (RFC 2822), `Message-ID` omitted (Gmail assigns), `From` only if `GMAIL_SEND_AS` is set.
- Subject: ASCII-only → as-is; otherwise RFC 2047 `=?UTF-8?B?…?=` encoded words, split so each encoded word is ≤ 75 chars **without splitting a UTF-8 multi-byte sequence or surrogate pair** (emoji AC).
- Header folding at 78 chars for long `To`/`Cc` lists.
- Text body: `Content-Type: text/plain; charset=UTF-8`, `Content-Transfer-Encoding: base64` (line-wrapped at 76). Base64 avoids 8-bit/long-line delivery issues.
- HTML: `multipart/alternative; boundary=<random>` with the text part first (generated via `html-to-text`, D8), then `text/html; charset=UTF-8`, both base64.
- Final safety: assert no header value contains CR/LF after encoding.
- `toBase64Url(mime)` for the Gmail `raw` field.
- **Done when:** unit tests cover ASCII subject, emoji subject, CJK subject, long subject folding, HTML alternative structure (parsed back with a minimal parser in tests), CRLF injection rejected, `From` presence toggled by config.

#### T1.13 `src/tools/gmail/sendEmail.ts`: `gmail_send_email`

- Input zod (mirrors PS §6.2 exactly; every field `.describe()`d with the PS text):
  - `to: z.array(z.string()).min(1)`, `cc`/`bcc`: optional arrays, `subject: z.string()`, `body: z.string()`, `body_format: z.enum(["text","html"]).optional()`, `dry_run: z.boolean().optional()`.
  - Defaults applied in the handler, not via zod `.default()`, so the emitted schema stays minimal. Defaults are stated in descriptions (C8).
- Output zod: `{ status: enum["sent","dry_run"], message_id: string, thread_id: string, to: string[], cc: string[], bcc_count: integer, subject: string }`, `.strict()`.
- Handler:
  1. Normalize + dedupe addresses → count check → domain allowlist → subject check → body size cap (reuse `DOCS_MAX_APPEND_CHARS`? **No**: add internal 1 MB body cap constant, since the Gmail raw limit is ~35 MB but bodies that large are almost certainly a mistake).
  2. `effectiveDryRun = args.dry_run || config.EMAIL_DRY_RUN`.
  3. Build MIME.
  4. If dry run → return `status: "dry_run"`, ids `""` (D2); text: `Dry run: email to a@x.com, b@y.com (subject: "…") was NOT sent.` + `(Server is in EMAIL_DRY_RUN mode.)` when config-forced + capped preview.
  5. Else `ensureScopes([gmail.send])` → `rateLimiter.tryConsume()` → `withRetry(() => gmail.users.messages.send({ userId: "me", requestBody: { raw } }), retryableSend)`.
  6. Audit: `{ tool, status, to, cc, bcc_count, subject_sha256, body_len, body_sha256, message_id, thread_id, transport }`. Recipients are logged per PS §9, the subject is hashed (could hold sensitive content), and the body is never logged.
  7. Text: `Email sent to alex@example.com (subject: "Weekly update"). Gmail message id: 18f2…`
- Annotations exactly per PS §6.2.
- **Done when:** integration tests (nock) cover success, dry run, config dry run, allowlist block, CRLF subject, 401 `invalid_grant`, 403 scope, 429→success, 500 → **no retry** (D3), rate limit exceeded.

#### T1.14 `src/lib/docRef.ts`

- `parseDocRef(input): { documentId, tabId? }`.
- Accepts:
  - Raw ID: `^[A-Za-z0-9_-]{25,}$` (Docs IDs are typically 44 chars; use a lenient lower bound).
  - URLs on `docs.google.com` (http/https), path `/document/d/<ID>/…` including `/document/u/<n>/d/<ID>/…`, with any suffix (`/edit`, `/view`, `/edit#heading=…`, `/mobilebasic`, etc.).
  - `?tab=t.xxxx` → `tabId`. Also accept `#tab=` if present.
- Rejects: other hosts (including look-alikes such as `docs.google.com.evil.com`, checked via `URL.hostname === "docs.google.com"`), `/spreadsheets/`, `/presentation/`, `/document/d/e/<published-id>/pub` (published-to-web IDs aren't usable with the API; give a specific error).
- Error message includes a valid example: `Expected a Google Doc URL like https://docs.google.com/document/d/1AbC…xyz/edit or a document ID like 1AbC…xyz.`
- **Done when:** table-driven unit tests cover ≥ 15 cases from PS §14.1.

#### T1.15 `src/lib/docsIndex.ts`: pure index math for the Docs body

- `selectTab(doc, requestedTabId?)`: with `includeTabsContent: true`, walk `doc.tabs` (including `childTabs`, recursively). Returns `{ tabId, body }`. Unknown tab id → `ToolError(TAB_NOT_FOUND)` listing available tab ids/titles. Default = first tab (PS §6.4).
- `bodyEnd(body)`: `endIndex` of the last structural element.
- `lastParagraphIsEmpty(body)`: the last element is a paragraph whose concatenated `textRun.content` is exactly `"\n"`. If the last element is a table/section break (possible in edge cases), treat it as "needs newline".
- `planAppend({ body, text, startOnNewLine })` → `{ insertIndex: end - 1, textToInsert, insertedStart, insertedEnd }`:
  - Normalize `\r\n` and `\r` to `\n` in `text`.
  - If `startOnNewLine && !lastParagraphIsEmpty` → prefix `"\n"`.
  - Indices are **UTF-16 code units** (Docs API convention). JS `string.length` is also UTF-16, so `insertedEnd = insertIndex + textToInsert.length`.
- `tailText(body, n)`: concatenate text runs (and table cell text, each cell separated by `\t`, rows by `\n`), take the last `n` chars without splitting a surrogate pair.
- **Done when:** unit tests use fixture JSON for: empty doc, doc ending in text, doc ending in empty paragraph, doc ending in table, doc with emoji, multi-tab doc with child tabs.

#### T1.16 `src/tools/docs/getDocumentInfo.ts`: `gdocs_get_document_info`

- Input per PS §6.3. `tail_chars`: integer, default 500, clamp to 0–5000 (values above max → error with the limit, not silent clamp, so models learn the bound).
- `docs.documents.get({ documentId, includeTabsContent: true, fields: "documentId,title,revisionId,tabs(tabProperties(tabId,title),childTabs,documentTab(body(content(startIndex,endIndex,paragraph(elements(textRun(content))),table(tableRows(tableCells(content(paragraph(elements(textRun(content))))))),sectionBreak))))" })`. Verify the mask against the live API in T1.24. If nested `childTabs` need an explicit recursive mask, expand to 3 levels deep.
- Output (strict): `{ document_id, title, url, revision_id, tabs: [{ tab_id, title }], end_index, tail_text }`. `end_index`/`tail_text` refer to the tab from the URL or the first tab. `url` = `https://docs.google.com/document/d/<id>/edit` (+ `?tab=` when known).
- Text: `"<title>" (<n> tabs). Ends with: "…last 120 chars…"`.
- Not audited (read-only).
- **Done when:** integration tests cover success, 403, 404, invalid ref, `DOCS_ALLOWED_IDS` block (allowlist also applies to reads, so models can't probe docs outside the list).

#### T1.17 `src/tools/docs/appendText.ts`: `gdocs_append_text`

- Input per PS §6.4. In P0, `paragraph_style` is **declared in the schema** (so the contract snapshot is stable from day one) but rejected with `ToolError(NOT_IMPLEMENTED)` until T2.3, **or** implemented early if time permits (it's small). Recommendation: implement in P0 alongside D5, since both use the same `updateParagraphStyle` request.
- Algorithm (attempt loop, max 3 = 1 + 2 retries):
  1. `parseDocRef` → tab precedence: `args.tab_id` > URL `tab` > first tab.
  2. Guards: allowlist, size (`text.length ≤ DOCS_MAX_APPEND_CHARS`), non-empty text.
  3. `ensureScopes([documents])`.
  4. `docs.get` with a minimal mask (tabs + last elements + `revisionId`).
  5. `planAppend` → requests:
     ```json
     [
       { "insertText": { "location": { "index": insertIndex, "tabId": tabId }, "text": textToInsert } },
       // if style (explicit or D5 default):
       { "updateParagraphStyle": { "range": { "startIndex": paraStart, "endIndex": insertedEnd, "tabId": tabId },
                                   "paragraphStyle": { "namedStyleType": style }, "fields": "namedStyleType" } },
       // D5 only:
       { "deleteParagraphBullets": { "range": { "startIndex": paraStart, "endIndex": insertedEnd, "tabId": tabId } } }
     ]
     ```
     `paraStart = insertedStart + 1` when a `\n` prefix was added (so the previous paragraph isn't restyled), else `insertedStart`. **Never** include ranges below `paraStart`. When the original last paragraph was empty and no prefix was added, the inserted text fills that empty paragraph, which is still "after" all existing content. `deleteParagraphBullets` only touches the inserted range, so it doesn't modify existing content.
  6. `docs.batchUpdate({ documentId, requestBody: { requests, writeControl: { requiredRevisionId } } })` via `withRetry(retryableRead)` with D4 ambiguity handling.
  7. On revision-conflict error (HTTP 400 whose message mentions the required revision; confirm the exact shape in T1.24 and encode it in `errors.ts`) → loop to step 4. After 3 conflicts → `ToolError(CONCURRENT_EDITS)`: "The document is being edited by someone else right now; try again in a moment."
  8. Response `writeControl.requiredRevisionId` → output `revision_id`.
  9. Audit: `{ tool, doc_id, tab_id, revision_id, inserted_chars, text_sha256, transport }`.
- Output (strict): `{ document_id, title, url, tab_id, inserted_chars, start_index, end_index, revision_id }`. `start_index`/`end_index` = inserted range including any `\n` prefix. `inserted_chars` = `textToInsert.length`.
- Text: `Appended 1,234 characters to "Changelog" (tab "Tab 1").`
- **Done when:** integration tests cover non-empty last line (prefix added), empty doc (no prefix), `start_on_new_line: false`, explicit tab, unknown tab, conflict→success, conflict×3→error, 403 with account email in message, 404, oversize text; plus a "byte-for-byte" unit test that applies the generated requests to an in-memory doc model and asserts the prefix `[0, insertIndex)` is unchanged.

**M4 exit:** all P0 acceptance criteria (PS §6.2–6.4) have a passing automated test, except "arrives correctly" (live, T1.24).

### Milestone M5: Safety & audit

#### T1.18 `src/lib/audit.ts`

- `AuditSink` interface; implementations: `StderrAudit` (default: log line with `type: "audit"` via logger) and `FileAudit` (`AUDIT_LOG_PATH`, append JSONL, file created `0o600`, one `fs.appendFile` per line, serialized through a promise queue).
- Schema: `{ ts, type: "audit", tool, transport, status: "ok"|"error"|"dry_run", ...tool fields }`. Errors on write tools are audited too (with `error_code`).
- Helper `sha256(text)`. Type-level guard: the audit field type is a closed union, so `body`/`text` can't be passed by accident.
- **Done when:** unit tests confirm no body/text/token fields can appear, and that file mode is 0600 on POSIX.

#### T1.19 Guardrail wiring review

- Checklist test (`test/guardrails.test.ts`) that sets every PS §9 env var and asserts the behaviour through the in-process client: allowlist, max recipients, max per hour, max append chars, doc allowlist, global dry run.
- **Done when:** all PS §9 items have a test.

### Milestone M6: Tests, docs, host configs

#### T1.20 Contract tests: `test/contract/`

- `schemaLint.ts` (in `src/lib/schemaLint.ts` so it can also run at startup in dev): walks each tool's `inputSchema` and `outputSchema` from `tools/list` and fails on:
  - Top level not `type: "object"`.
  - Any of: `oneOf`, `anyOf`, `allOf`, `not`, `$ref`, `$defs`, `definitions`, `patternProperties`, `additionalProperties` that is an object/schema (only `false` allowed), `type` as array, `format`, `pattern`, `if/then/else`.
  - Property types outside `string|integer|number|boolean|array`; arrays whose `items` aren't one of those scalars, or an array of string arrays (tables).
  - Enums that aren't all strings.
  - Any property missing a non-empty `description`.
  - Tool names not matching `^[a-z0-9_]{1,40}$` or not prefixed `gmail_` / `gdocs_` (C5). Warn if `"gmail_docs_" + name` exceeds 64 chars.
  - Descriptions: 1–3 sentences, no host names ("Claude", "ChatGPT", "Gemini", "Copilot") (C8).
- `schemas.snapshot.test.ts`: `expect(toolsList).toMatchSnapshot()` with stable key ordering. Snapshot updates require a deliberate `-u` and show up in review.
- Run the suite twice: once with `ENABLE_DRAFTS=false`, once `true` (P1).
- **Done when:** linter has its own unit tests with bad-schema fixtures, and the snapshot is committed.

#### T1.21 stdout hygiene test (C9)

- Spawn `node dist/index.js` (stdio), send `initialize` + `tools/list` + a `tools/call` that errors (no token) + one that triggers logging at `LOG_LEVEL=debug`. Assert **every** stdout line parses as JSON-RPC 2.0, and stderr contains the logs.
- **Done when:** test passes in CI on Linux, macOS and Windows.

#### T1.22 Protocol tests (PS §14.4)

- For each of `2025-11-25` and `2026-07-28`: connect an SDK client (in-memory transport, and stdio subprocess) pinned to that version, `tools/list`, call each tool against mocked Google, check results.
- **Done when:** both versions pass.

#### T1.23 Host configs + README

- `.vscode/mcp.json` (PS §13), `.env.example` (PS §12 verbatim, plus comments for D1 scopes).
- `README.md` sections:
  1. What it does / doesn't (non-goals), the **one-account security model**, and the two auth layers (PS §8).
  2. Quick start (target < 15 min, G3): prerequisites → Google Cloud setup (create project, enable Gmail + Docs APIs, OAuth consent screen _Internal_ vs _External/Testing_ with 7-day caveat, create Desktop client, copy ID/secret) → `npm i && npm run build` → `.env` → `npx gmail-docs-mcp auth` → add to host → try S1.
  3. Host snippets for VS Code, Claude Desktop, Claude Code (`claude mcp add gmail-docs -- node /abs/path/dist/index.js`), Gemini CLI, Cursor, Codex CLI. **Verify each against current host docs** at writing time.
  4. Tool reference (generated from `tools/list` by `scripts/gen-tool-docs.ts` to avoid drift).
  5. Guardrails & recommended production settings (`EMAIL_ALLOWED_DOMAINS`, `require_approval: "always"`).
  6. Troubleshooting: token expired / `invalid_grant`, missing scopes after enabling drafts, doc not shared, "server disconnected" (stdout), Windows paths, corporate proxy.
- **Done when:** a teammate unfamiliar with the project goes from clone to first successful tool call in < 15 minutes following only the README (record the time in the PR).

#### T1.24 Live smoke tests (opt-in) + manual verification

- `test/live/*.test.ts`, skipped unless `LIVE_TESTS=1`. Env: `LIVE_SCRATCH_DOC_ID`, `LIVE_EMAIL_TO` (defaults to the authenticated account).
  - Send plain text, HTML, and emoji/CJK subject email to self. Manually confirm rendering once, then rely on success codes.
  - `get_document_info` on scratch doc; `append_text` twice (non-empty last line, then after an empty paragraph); verify via `documents.get` that the prior content prefix is identical (byte-for-byte AC).
  - Tabbed doc append (if a tabbed scratch doc is configured).
  - Capture the exact revision-conflict error shape (start two appends concurrently with the same `requiredRevisionId`) and lock it into `errors.ts` fixtures.
- Manual: MCP Inspector run-through of all tools.
- **Done when:** live suite passes against a real account, and the conflict fixture is committed.

#### T1.25 Cross-host matrix (Phase 1 hosts)

- Run S1, S2 (and S3 placeholder) in VS Code Copilot agent mode, Claude Desktop **or** Claude Code, and Gemini CLI over stdio with identical builds.
- Record in `docs/compatibility.md`: host, version, protocol negotiated, scenario, tool chosen first try (G4), args valid first try, result, notes.
- **Done when:** S1/S2 pass in all three hosts with only host config differing.

**Phase 1 exit criteria (= PS §15 minus HTTP/OpenAI items):** all P0 ACs pass; stdio works in VS Code, Claude and Gemini CLI unchanged; linter + snapshot pass in CI; both protocol revisions pass; stdout hygiene test passes; guardrails tested; README complete.

---

## 6. Phase 2: Remote + richer docs (P1)

#### T2.1 `src/transports/http.ts`: Streamable HTTP (C1)

- Single endpoint `/mcp` handling `POST` (and `GET`/`DELETE` returning `405` in stateless mode, per T0.3 findings). Stateless: no session ids; a fresh server/transport per request (or the SDK's stateless helper) built from the shared `createServer` factory.
- Middleware order for each request:
  1. **Host header check:** must match the bind host/port or an allowed public hostname (configurable via `MCP_HTTP_ALLOWED_HOSTS`, a new optional var; **needs sign-off**, since it's not in PS §12). DNS-rebinding defense layer 1.
  2. **Origin check:** if `Origin` is present, it must be in `MCP_HTTP_ALLOWED_ORIGINS` (exact match, scheme+host+port), otherwise `403`. Absent `Origin` (server-to-server, e.g. OpenAI) is allowed.
  3. **Bearer:** if `MCP_HTTP_BEARER_TOKEN` is set, require `Authorization: Bearer <t>`; compare `timingSafeEqual(sha256(given), sha256(expected))` (equal-length buffers). Failure → `401` with `WWW-Authenticate: Bearer`.
  4. Body size limit 1 MB, `Content-Type: application/json` required, request timeout 60 s.
- Startup refusal: if host isn't loopback (`127.0.0.1`, `::1`, `localhost`) and no bearer token (and OAuth mode is off), log an error and exit `2` (PS §8.2).
- `GET /healthz` → `200 {"ok":true}` (no auth, no info leak) for Docker/Cloud Run.
- Graceful shutdown on SIGTERM (drain in-flight requests ≤ 10 s).
- `ctx.transport = "http"` for audit.
- **Done when:** tests cover Origin allowed/blocked/absent, bad Host, bearer missing/wrong/right, refusal to start on `0.0.0.0` without a token, both protocol revisions over HTTP, S4 (headless append) via a script using the SDK client.

#### T2.2 Protocol tests over HTTP

- Extend T1.22 to the HTTP transport.

#### T2.3 `paragraph_style` (if not done in T1.17)

- As designed in T1.17 step 5. Tests: style applied to all inserted paragraphs only; previous paragraph unchanged.

#### T2.4 `gdocs_append_table`: `src/tools/docs/appendTable.ts`

- Input: `document`, `rows: z.array(z.array(z.string())).min(1)`, `bold_header?: boolean` (default true), `tab_id?`. Optional `client_request_id` (T2.6).
- Limits: `DOCS_MAX_TABLE_ROWS` (100), `DOCS_MAX_TABLE_COLS` (20): new env vars (PS §6.5 says "configurable"). Also count total cell text against `DOCS_MAX_APPEND_CHARS`.
- Normalize: pad every row to the max column count with `""`. Reject cells containing `\n`? **No**, allow, since newlines inside a cell are valid; but normalize `\r\n`.
- Algorithm:
  1. Read doc (rev R0). If last paragraph is non-empty, include `insertText "\n"` at `end-1` first so the table starts after a fresh paragraph.
  2. `insertTable { rows, columns, location: { index: <end-1 after newline>, tabId } }` in the same batch, with `requiredRevisionId: R0`. (Docs inserts a newline before the table itself; verify in live test and adjust so we don't leave a double blank line.)
  3. Re-read (rev R1) and locate the **last** table element in the tab body, verifying its dimensions match. Collect `cell.content[0].startIndex` for every cell.
  4. Build one batch in **reverse cell order** (last row/last column first). For each non-empty cell: `insertText { index: cellStart, text }` and, if a header cell and `bold_header`, immediately `updateTextStyle { range: [cellStart, cellStart+len), textStyle: { bold: true }, fields: "bold" }`. Reverse order keeps earlier indices valid, and styling right after each insert uses still-valid indices.
  5. `batchUpdate` with `requiredRevisionId: R1`. On conflict between steps 2 and 5: re-read and retry fill (step 3) up to 2 times. The table is already present, so **never** re-insert it. Locate it by "last table whose cells are all empty and dims match".
  6. If fill ultimately fails, return `isError` saying an empty table was added and the fill failed, with the doc URL. This is the one non-atomic path; document it.
- Output (strict): `{ document_id, title, url, tab_id, rows, columns, start_index, end_index, revision_id }`. **Contract to be confirmed**, since PS §6.5 doesn't specify the output. Propose this shape for sign-off.
- Audit: `{ tool, doc_id, tab_id, rows, columns, cells_sha256, revision_id }`.
- **Done when:** integration tests (fixtures for pre/post table docs), live test appends a 5×3 table to the scratch doc (S3).

#### T2.5 `gmail_create_draft`: `src/tools/gmail/createDraft.ts`

- Registered only when `ENABLE_DRAFTS=true`. Same input as send minus `dry_run`. Reuses guards + `buildMime`.
- `ensureScopes([gmail.compose])` → `gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } })`.
- Drafts are **not** counted against `EMAIL_MAX_PER_HOUR` (nothing is sent), but the allowlist still applies. Annotations: `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true`.
- Output `{ draft_id, message_id }`. Text includes a link `https://mail.google.com/mail/#drafts`.
- **Done when:** the snapshot test with drafts enabled is committed, and the scope-missing path is tested (token from before drafts enabled).

#### T2.6 `client_request_id` idempotency (PS §9)

- Optional `client_request_id: string` (≤ 128 chars, description explains retry semantics) on all write tools. **This changes input schemas**, so update snapshots deliberately.
- `IdempotencyCache`: key = `tool + ":" + client_request_id`. Stores `{ argsHash, result, expiresAt (24 h) }`. In-memory LRU (max 10k entries); optional file persistence beside the token (P1 nice-to-have).
- Same key + same args → return cached result (add a text note "(returned cached result; not sent again)"). Same key + **different** args → `isError` (`IDEMPOTENCY_CONFLICT`).
- In-flight dedupe: a second call with the same key while the first is still running awaits the same promise.
- **Done when:** tests cover hit, miss, conflict, expiry, concurrent duplicate.

#### T2.7 Dockerfile

- Multi-stage: `node:22-alpine` build → runtime with `NODE_ENV=production`, non-root `node` user, `ENTRYPOINT ["node","dist/index.js"]`, `CMD ["--transport","http","--host","0.0.0.0","--port","3333"]`, `HEALTHCHECK` on `/healthz`.
- Token supplied via mounted secret file (`GOOGLE_TOKEN_PATH=/run/secrets/token.json`); `auth` is run on a workstation, not in the container.
- The container refuses to start without `MCP_HTTP_BEARER_TOKEN` (binds `0.0.0.0`), which follows from T2.1.
- **Done when:** `docker run` + SDK client call works; image < 200 MB.

#### T2.8 Keychain token storage

- `TokenStore` interface: `FileTokenStore` (default) and `KeychainTokenStore` (`GOOGLE_TOKEN_STORE=keychain`, new var). Service `gmail-docs-mcp`, account = Google email.
- Library candidate: `@napi-rs/keyring` (prebuilt binaries, no node-gyp). Fall back to file with a warning if unavailable.
- **Done when:** works on macOS Keychain and Windows Credential Manager; Linux tested with libsecret where available.

#### T2.9 OpenAI Responses API verification

- Expose local HTTP via `cloudflared`/`ngrok` **with bearer set**; run S1/S2 using the PS §13 snippet with `require_approval: "always"`. Record in `docs/compatibility.md`.

#### T2.10 OAuth resource-server mode (ChatGPT connectors, Claude.ai custom connectors)

- Prerequisite: resolve Open Question 4 (which authorization server; whether those hosts accept a static bearer header).
- Implement per the MCP authorization spec revision(s) negotiated:
  - Publish protected-resource metadata at `/.well-known/oauth-protected-resource` (`resource`, `authorization_servers`, `scopes_supported`, `bearer_methods_supported`).
  - On missing/invalid token: `401` + `WWW-Authenticate: Bearer resource_metadata="…"`.
  - Validate access tokens as JWTs against the AS JWKS (`jose` library): `iss`, `aud` = this resource URL, `exp`, required scope (e.g. `mcp:tools`). Optional caller allowlist by `sub`/`email` claim (`MCP_OAUTH_ALLOWED_SUBJECTS`) so only the owner can use the one Google account.
  - New env: `MCP_AUTH_MODE=bearer|oauth`, `MCP_OAUTH_ISSUER`, `MCP_OAUTH_AUDIENCE`, `MCP_OAUTH_REQUIRED_SCOPE`.
- Do **not** build an authorization server (PS §8.2).
- **Done when:** S1/S2 pass from ChatGPT developer mode and a Claude.ai custom connector against a public HTTPS deployment; unauthenticated requests get 401 with metadata pointer.

**Phase 2 exit criteria:** PS §15 fully met, including HTTP and one OpenAI surface (G1); all P1 tools snapshot-locked; compatibility matrix complete for every host in PS §13 that's in scope.

---

## 7. Phase 3: Extensions (P2)

Scope each as its own mini-plan when prioritized. Notes to keep the v1 design forward-compatible:

| Feature               | Design hook already in v1                                                                                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attachments           | `buildMime` is structured as parts; add `multipart/mixed` wrapper. Input would need an array of `{filename, mime_type, content_base64}` objects, which **breaks C4** (arrays of objects are banned). Options: parallel arrays, or a separate upload tool returning a handle. Decide before building. |
| Threaded replies      | Needs `gmail.readonly`/`metadata` (restricted/sensitive) to fetch `Message-ID`; add `In-Reply-To`/`References` headers + `threadId`. Gate behind opt-in flag like drafts.                                                                                                                            |
| Create new doc        | `gdocs_create_document` needs `documents` (already granted) and optionally `drive.file` to place in folder.                                                                                                                                                                                          |
| Markdown → Docs       | New `lib/markdownToDocs.ts` that emits `insertText` + `updateParagraphStyle`/`updateTextStyle`/`createParagraphBullets` requests with the same reverse-index technique; plug into `append_text` via `format: "markdown"` enum (additive change).                                                     |
| Service account + DWD | `googleClient` already abstracts credential source; add `GOOGLE_AUTH_MODE=service_account` + `GOOGLE_IMPERSONATE`.                                                                                                                                                                                   |
| Multi-user            | Requires per-caller token store keyed by OAuth `sub` (T2.10 provides identity) and per-user rate limits/caches. Biggest change; revisit D6.                                                                                                                                                          |

---

## 8. Detailed module designs

### 8.1 File/dependency map

| File                          | Depends on                              | Exports                                          |
| ----------------------------- | --------------------------------------- | ------------------------------------------------ |
| `src/index.ts`                | config, server, transports, authCli     | CLI main                                         |
| `src/config.ts`               | zod                                     | `loadConfig`, `Config`, `requiredScopes`         |
| `src/server.ts`               | SDK, tools/*, lib/tool                  | `createServer`                                   |
| `src/transports/stdio.ts`     | SDK, logger                             | `startStdio`                                     |
| `src/transports/http.ts`      | SDK, logger, config                     | `startHttp`                                      |
| `src/auth/googleClient.ts`    | googleapis, google-auth-library, errors | `createGoogleClient`, `GoogleDeps`               |
| `src/auth/authCli.ts`         | google-auth-library, open, config       | `runAuthCli`                                     |
| `src/auth/tokenStore.ts` (P1) | fs / keyring                            | `TokenStore`                                     |
| `src/tools/**`                | lib/*, GoogleDeps                       | `register(server, ctx)` per tool                 |
| `src/lib/tool.ts`             | SDK, errors, logger                     | `defineTool`                                     |
| `src/lib/mime.ts`             | html-to-text                            | `buildMime`, `toBase64Url`, `encodeSubject`      |
| `src/lib/docRef.ts`           | –                                       | `parseDocRef`                                    |
| `src/lib/docsIndex.ts`        | –                                       | `selectTab`, `planAppend`, `tailText`, `bodyEnd` |
| `src/lib/guards.ts`           | errors                                  | address/subject/size/allowlist checks            |
| `src/lib/rateLimiter.ts`      | –                                       | `SlidingWindowLimiter`                           |
| `src/lib/retry.ts`            | –                                       | `withRetry`, predicates                          |
| `src/lib/errors.ts`           | –                                       | `ToolError`, `mapGoogleError`, `toToolResult`    |
| `src/lib/audit.ts`            | fs, crypto, logger                      | `AuditSink`, `createAudit`, `sha256`             |
| `src/lib/logger.ts`           | –                                       | `logger`, `installStdoutGuard`                   |
| `src/lib/schemaLint.ts`       | –                                       | `lintToolSchemas`                                |
| `src/lib/idempotency.ts` (P1) | –                                       | `IdempotencyCache`                               |

### 8.2 Tool descriptions (final text)

Use the PS text verbatim where given, appending defaults per C8:

| Tool                      | Description                                                                                                                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail_send_email`        | PS §6.2 text verbatim.                                                                                                                                                                             |
| `gdocs_get_document_info` | PS §6.3 text + " Returns the last 500 characters by default."                                                                                                                                      |
| `gdocs_append_text`       | PS §6.4 text + " Starts a new paragraph by default."                                                                                                                                               |
| `gdocs_append_table`      | "Append a table to the end of an existing Google Doc; the first row is the header and is bold by default. Never modifies or removes existing content. Use gdocs_append_text for plain text."       |
| `gmail_create_draft`      | "Create a draft email in the connected Gmail account without sending it, so the user can review and send it themselves. Use this instead of gmail_send_email when the user wants to review first." |

### 8.3 `structuredContent` / text rules (C6, C10)

- `structuredContent` always passes `Output.strict().parse()` before return.
- Echoed arrays (`to`, `cc`) are already bounded by `EMAIL_MAX_RECIPIENTS`. `subject` is ≤ 250. `tail_text` ≤ 5000. Total stays well under 25 KB.
- Text content is one line for success (plus capped preview for dry run), and 1–3 sentences for errors: _what went wrong + what to do next_.

### 8.4 Config additions beyond PS §12 (all optional, documented in `.env.example`)

| Var                                           | Phase | Default   | Sign-off?                   |
| --------------------------------------------- | ----- | --------- | --------------------------- |
| `DOCS_MAX_TABLE_ROWS` / `DOCS_MAX_TABLE_COLS` | 2     | 100 / 20  | No (PS says "configurable") |
| `MCP_HTTP_ALLOWED_HOSTS`                      | 2     | bind host | Yes                         |
| `GOOGLE_TOKEN_STORE`                          | 2     | `file`    | No (PS P1 keychain)         |
| `MCP_AUTH_MODE`, `MCP_OAUTH_*`                | 2     | `bearer`  | Yes                         |

---

## 9. Error catalogue

All are returned as tool results with `isError: true` (C7). JSON-RPC errors are reserved for malformed requests and unknown tools (handled by the SDK).

| Code                        | Trigger                                                    | Message template (model-facing)                                                                                                    |
| --------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_INPUT`             | zod failure                                                | `Invalid arguments: <field>: <issue>. <hint>`                                                                                      |
| `INVALID_DOC_REF`           | `parseDocRef` fails                                        | `"<input>" is not a Google Doc URL or ID. Expected something like https://docs.google.com/document/d/1AbC…xyz/edit or 1AbC…xyz.`   |
| `AUTH_REQUIRED`             | no token file                                              | ``Not signed in to Google. Ask the server owner to run `npx gmail-docs-mcp auth`, then retry.``                                    |
| `AUTH_EXPIRED`              | `invalid_grant` / 401 after refresh                        | ``The Google sign-in has expired or was revoked. Run `npx gmail-docs-mcp auth` to sign in again.`` (+ Testing-mode 7-day hint)     |
| `SCOPE_MISSING`             | stored scopes ⊉ required, or 403 `insufficientPermissions` | ``The Google sign-in is missing permission(s): <scopes>. Run `npx gmail-docs-mcp auth` again to grant them.``                      |
| `DOC_NO_ACCESS`             | Docs 403 (`PERMISSION_DENIED`)                             | `The connected Google account (<email>) does not have edit access to this document. Share it with <email> as an Editor and retry.` |
| `DOC_NOT_FOUND`             | Docs 404                                                   | `Document <id> was not found. Check the URL, and that it is shared with <email>.`                                                  |
| `TAB_NOT_FOUND`             | unknown `tab_id`                                           | `Tab "<id>" not found. Available tabs: t.0 ("Notes"), t.abc ("Q3").`                                                               |
| `DOC_NOT_ALLOWED`           | `DOCS_ALLOWED_IDS`                                         | `This server is not allowed to access document <id>.`                                                                              |
| `RECIPIENT_NOT_ALLOWED`     | domain allowlist                                           | `Blocked recipient(s): a@evil.com, b@x.org. This server only sends to: example.com, partner.com. Nothing was sent.`                |
| `TOO_MANY_RECIPIENTS`       | count > max                                                | `Too many recipients (25). The limit is 20. Nothing was sent.`                                                                     |
| `INVALID_ADDRESS`           | bad address / CRLF                                         | `"<addr>" is not a valid email address. Use a bare address like alex@example.com.`                                                 |
| `INVALID_SUBJECT`           | CRLF or > 250                                              | `Subject must be a single line of at most 250 characters.`                                                                         |
| `RATE_LIMITED_LOCAL`        | `EMAIL_MAX_PER_HOUR`                                       | `Hourly send limit (30) reached. Next send allowed in ~12 minutes. Nothing was sent.`                                              |
| `TOO_LARGE`                 | append/body/table limits                                   | `Text is 61,200 characters; the limit is 50,000. Split it into smaller appends.`                                                   |
| `CONCURRENT_EDITS`          | 3 revision conflicts                                       | `The document changed while appending (someone else is editing). Nothing was appended; try again.`                                 |
| `GOOGLE_RATE_LIMITED`       | 429 after retries                                          | `Google is rate-limiting requests. Wait a minute and retry.`                                                                       |
| `GOOGLE_UNAVAILABLE`        | 5xx/timeout after retries                                  | `Google <API> did not respond. <For send: "The email may or may not have been sent; check the Sent folder before retrying.">`      |
| `IDEMPOTENCY_CONFLICT` (P1) | same key, different args                                   | `client_request_id "<id>" was already used with different arguments.`                                                              |
| `INTERNAL`                  | anything else                                              | `Unexpected server error (ref <uuid>). Check the server logs.`                                                                     |

---

## 10. Testing plan

### 10.1 Layout

```
test/
├─ unit/          lib/* (mime, docRef, docsIndex, guards, rateLimiter, retry, errors, audit, logger, config, schemaLint)
├─ contract/      schemaLint over tools/list, schema snapshots (drafts off/on)
├─ integration/   tools via in-process MCP client + nock'd googleapis
├─ protocol/      both revisions × {in-memory, stdio subprocess, http (P2)}
├─ e2e/           stdout hygiene (spawned process), http middleware (P2)
├─ fixtures/      docs.get JSON (empty, text-ending, table-ending, tabs, emoji), Google error bodies
└─ live/          LIVE_TESTS=1 only
```

### 10.2 Integration test harness

- `makeTestServer({ env, googleFixtures })` → `{ client, auditSink (in-memory), clock (fake), nock scope }`.
- Google mocked at HTTP level with `nock` on `gmail.googleapis.com` and `docs.googleapis.com`, plus `oauth2.googleapis.com/token` for refresh. HTTP-level mocking exercises the real googleapis request building (paths, `raw` encoding, `writeControl`).
- An in-memory **Docs model** (`test/helpers/fakeDoc.ts`) that applies `insertText`, `insertTable`, `updateParagraphStyle`, `updateTextStyle`, `deleteParagraphBullets` to a simplified structure. Used to assert byte-for-byte preservation and correct cell placement for tables.

### 10.3 Scenario coverage (PS §14.3)

| Case                        | send             | get_info | append_text  | append_table  |
| --------------------------- | ---------------- | -------- | ------------ | ------------- |
| success                     | ✓                | ✓        | ✓            | ✓             |
| 401 / `invalid_grant`       | ✓                | ✓        | ✓            | ✓             |
| 403                         | ✓ (scope)        | ✓        | ✓            | ✓             |
| 404                         | –                | ✓        | ✓            | ✓             |
| 429 → success               | ✓                | ✓        | ✓            | ✓             |
| 5xx → success               | ✗ (D3: no retry) | ✓        | ✓ (D4 check) | ✓             |
| revision conflict → success | –                | –        | ✓            | ✓ (fill step) |

### 10.4 Coverage gates

- `lib/**` ≥ 80 % lines/branches (PS §10), enforced in `vitest.config.ts` thresholds.
- Overall ≥ 70 % (soft target).

---

## 11. CI pipeline

GitHub Actions `.github/workflows/ci.yml`:

| Job              | Matrix                                   | Steps                                                                                  |
| ---------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `lint`           | ubuntu, node 22                          | `npm ci`, `lint`, `format --check`, `typecheck`                                        |
| `test`           | {ubuntu, macos, windows} × {node 20, 22} | `npm ci`, `build`, `test:coverage` (unit, contract, integration, protocol, e2e stdout) |
| `snapshot-guard` | ubuntu                                   | fails if `__snapshots__` changed without a `contract-change` PR label                  |
| `docker` (P2)    | ubuntu                                   | build image, run `/healthz` + one SDK call                                             |
| `live`           | manual `workflow_dispatch` only          | `test:live` with repo secrets for token + scratch doc                                  |

Also: Dependabot for npm; `npm audit --omit=dev` as a non-blocking report.

---

## 12. Risks and mitigations

| Risk                                                               | Impact                        | Mitigation                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| SDK v2 API differs from expectations or can't dual-serve protocols | Blocks C2                     | Phase 0 spike (T0.3) before any tool code; escalate per D10                                                                |
| zod→JSON Schema emits banned keywords                              | C4 failures in strict hosts   | Linter in CI from M6, but run it from the first tool onward; avoid `.email()`, `.url()`, `.regex()`, `.nullable()`, unions |
| External OAuth in Testing → 7-day token expiry                     | Silent breakage after a week  | README; `auth --status`; error hint on `invalid_grant`; resolve Open Q1 early                                              |
| Duplicate email on retry                                           | User-visible harm             | D3 (no retry on ambiguous send failure), P1 `client_request_id`                                                            |
| Duplicate doc append after ambiguous failure                       | Content duplication           | D4 tail check                                                                                                              |
| Inherited heading/bullet style on append                           | Ugly docs                     | D5                                                                                                                         |
| Prompt injection exfiltrates data via email                        | Security                      | Allowlist (recommend on by default in prod, Open Q5), rate limit, host approval guidance, audit log                        |
| Table insert not atomic                                            | Empty table left behind       | Fill retry; explicit error message; documented                                                                             |
| Docs field mask misses nested tabs                                 | Wrong end index on child tabs | Fixture + live test with child tabs                                                                                        |
| Windows path/permission differences                                | G3 fails on Windows           | CI matrix on Windows; `path`/`os.homedir`; warn about `chmod` no-op                                                        |
| Host config formats drift                                          | README snippets break         | Verify at write time; record host versions in `compatibility.md`                                                           |
| Gmail daily sending limits (Google-side)                           | 429/`dailyLimitExceeded`      | Map to `GOOGLE_RATE_LIMITED` with "daily limit" variant; don't retry `dailyLimitExceeded`                                  |

---

## 13. Traceability matrix

| Requirement                       | Tasks                                        | Verified by                                             |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
| PS §6.2 `gmail_send_email` + ACs  | T1.11–T1.13                                  | integration send suite; live T1.24                      |
| PS §6.3 `gdocs_get_document_info` | T1.14–T1.16                                  | integration; live                                       |
| PS §6.4 `gdocs_append_text` + ACs | T1.14, T1.15, T1.17                          | integration + fakeDoc byte-for-byte; live               |
| PS §6.5 `gdocs_append_table`      | T2.4                                         | integration + fakeDoc; live S3                          |
| PS §6.6 `gmail_create_draft`      | T2.5                                         | integration; snapshot (drafts on)                       |
| C1 transports                     | T1.10, T2.1                                  | protocol tests ×transport                               |
| C2 protocol revisions             | T0.3, T1.9, T1.22, T2.2                      | protocol tests                                          |
| C3 tools only                     | T1.9                                         | capability assertion in protocol test                   |
| C4 schema subset                  | T1.20                                        | schemaLint in CI                                        |
| C5 naming                         | T1.20                                        | schemaLint                                              |
| C6 dual result                    | T1.5                                         | strict output parse in every integration test           |
| C7 error semantics                | T1.3, T1.5                                   | error catalogue tests                                   |
| C8 descriptions                   | §8.2, T1.20                                  | schemaLint description rules + review                   |
| C9 stdout hygiene                 | T1.1, T1.10, T1.21                           | e2e spawned-process test (3 OSes)                       |
| C10 bounded payloads              | T1.5, T1.16                                  | size backstop test                                      |
| C11 non-interactive               | T1.7                                         | test that no tool path imports `open` / starts a server |
| PS §8.1 Google auth               | T1.6, T1.7                                   | unit + manual                                           |
| PS §8.2 host→server auth          | T2.1, T2.10                                  | http e2e tests                                          |
| PS §9 guardrails                  | T1.11, T1.18, T1.19, T2.6                    | guardrails checklist test                               |
| PS §10 NFRs                       | T1.4 (retry/timeout), T1.1 (logs), CI matrix | unit + CI                                               |
| G1 cross-host                     | T1.25, T2.9, T2.10                           | `docs/compatibility.md`                                 |
| G3 < 15 min setup                 | T1.23                                        | timed teammate run                                      |
| G4 first-try tool use             | §8.2 descriptions, T1.25                     | compatibility matrix columns                            |

---

## 14. Open questions and when they block

| PS # | Question                                                                                      | Blocks                  | Default if unanswered                                                 |
| ---- | --------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------- |
| 1    | Personal Gmail vs Workspace                                                                   | T1.6 manual test, T1.24 | Assume Workspace (Internal consent); document External/Testing caveat |
| 2    | Must-have hosts                                                                               | T1.25 scope             | VS Code, Claude Code, Gemini CLI for Phase 1                          |
| 3    | HTTP hosting location                                                                         | T2.7, T2.9, T2.10       | Local + cloudflared for testing; Cloud Run reference in README        |
| 4    | OAuth AS for ChatGPT/Claude.ai; static bearer support?                                        | T2.10                   | Research during Phase 2 start; don't build T2.10 until answered       |
| 5    | Domain allowlist on by default in prod?                                                       | README guidance         | Recommend (not enforce) in README; `.env.example` shows it commented  |
| 6    | HTML email in v1?                                                                             | T1.12 scope             | Implement (low cost, already in contract)                             |
| 7    | Do target docs use tabs?                                                                      | T1.15 test depth        | Support tabs fully (already in contract)                              |
| –    | Sign-off on D1, D2, D3, D5, `MCP_HTTP_ALLOWED_HOSTS`, OAuth vars, `append_table` output shape | Respective tasks        | Ask the owner before implementing                                     |

---

### Suggested first prompt for the coding agent

> "Read `docs/problemStatement.md` and `docs/implementationPlan.md`. Do Phase 0 (T0.1–T0.4) and record SDK findings in `docs/sdk-notes.md`. Stop and report before starting Phase 1, and list any decision in §3 that the SDK findings affect."

---

## 15. Implementation status (2026-10-17)

### Decisions adopted

D1, D2, D3, D4, D5 and the extra config variables (`MCP_HTTP_ALLOWED_HOSTS`, `DOCS_MAX_TABLE_ROWS`, `DOCS_MAX_TABLE_COLS`, plus `GOOGLE_TIMEOUT_MS`) were implemented as proposed in §3 and §8.4. Revert any of them if the owner disagrees: each is isolated (D3 in `retryableSend`, D5 in `buildAppendRequests`).

### Deviations from this plan

| Item                        | Plan said                                             | Implemented                                                                    | Why                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google client library       | `googleapis`                                          | `@googleapis/docs` + `@googleapis/gmail`, loaded lazily on the first tool call | The monolithic package added about 1 s to startup; the per-API packages are the same code from the same publisher.                                                                                                                                                                                  |
| Token file                  | `{ refresh_token, scope, account_email, created_at }` | Google's `authorized_user` shape (also `client_id`, `client_secret`)           | The PS §13 host snippets pass only `GOOGLE_TOKEN_PATH`, so the server must be able to refresh with nothing else. Env vars still override.                                                                                                                                                           |
| `gdocs_append_table` output | `rows`, `columns`                                     | `row_count`, `column_count`                                                    | Avoids reusing the input name `rows` (an array) for an integer.                                                                                                                                                                                                                                     |
| Table newline               | Insert `\n` first if the last paragraph has text      | No manual newline                                                              | `insertTable` already inserts a newline before the table; adding one would leave a blank line. Confirmed against live Docs. The empty paragraph left after the table inherited the previous line's style, so the fill batch now resets it to `NORMAL_TEXT` without bullets (found in the live run). |
| HTTP entry                  | Per-request server + transport                        | SDK `createMcpHandler(factory, { legacy: 'stateless' })`                       | That is how SDK v2 serves `2026-07-28` and `2025-11-25` from one endpoint (see [sdk-notes.md](sdk-notes.md)).                                                                                                                                                                                       |
| HTTP mocking                | `nock` (latest)                                       | `nock@14`                                                                      | nock 15 mis-handles gaxios's `node-fetch` requests (host shows as `null`).                                                                                                                                                                                                                          |

### Task status

| Task                        | Status                                                                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0.1–T0.4                   | Done. Findings in [sdk-notes.md](sdk-notes.md).                                                                                                                                                                                                                                                       |
| T1.1–T1.23                  | Done.                                                                                                                                                                                                                                                                                                 |
| T1.24 Live smoke            | Done (2026-10-17, personal Gmail account). All 3 live tests pass. `fields` mask valid. Real conflict error: HTTP 400 `INVALID_ARGUMENT`, "The required revision ID '…' does not match the latest revision." (matches `isRevisionConflict` and the test fake). Also verified on protocol `2026-07-28`. |
| T1.25 Cross-host matrix     | Template in [compatibility.md](compatibility.md); **manual runs pending**.                                                                                                                                                                                                                            |
| T2.1–T2.7                   | Done. The Dockerfile is verified only in the CI `docker` job (Docker wasn't available locally).                                                                                                                                                                                                       |
| T2.8 Keychain storage       | **Not done.** The `TokenStore` interface is in place; a keychain implementation needs a native dependency choice.                                                                                                                                                                                     |
| T2.9 OpenAI Responses API   | **Pending manual verification** (needs a public HTTPS endpoint).                                                                                                                                                                                                                                      |
| T2.10 OAuth resource server | **Not started.** Blocked on open question 4 (choice of authorization server).                                                                                                                                                                                                                         |

### Test summary

243 tests across unit, contract (portability linter + schema snapshot, drafts off and on), integration (nock-backed fake Gmail and Docs), protocol (both revisions over in-memory and HTTP), and e2e (stdout hygiene on the built binary; HTTP Host, Origin and bearer checks). Coverage on `src/lib`: 99 % lines, 94 % branches.
