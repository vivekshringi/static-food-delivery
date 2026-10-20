# Security Review: Agent Guardrails

Date: 2026-10-20
Scope: `packages/agent/agent.js`, `packages/agent/prompt.js`, `packages/server/src/index.js`
Question: Does the agent have enough guardrails so that it cannot be misused?

## Verdict

**Capability containment: strong. Policy/abuse containment: all identified classes closed.**

The agent cannot be turned into remote code execution, a host sandbox escape, or a data
exfiltration channel. Those risks are prevented structurally — by the absence of dangerous
tools and by server-authoritative business logic — not merely by prompt instructions.

The three realistic abuse paths found in the first pass (unbounded customer-number enumeration,
an unguarded delegated subagent, and a fail-open admin-token default) are fixed, as are the four
LOW hardening items.

## Findings

| # | Severity | File | Lines | Vulnerability | Confidence |
|---|----------|------|-------|---------------|------------|
| 1 | ~~HIGH~~ FIXED | `packages/server/src/index.js` | 29, 289-293 | Fail-open `demo-admin-token` default protects `/api/admin/*`, `/api/payments`, `/api/orders` | 7/10 |
| 2 | ~~MEDIUM~~ FIXED | `packages/agent/agent.js` | 724-770 | deepagents auto-injects `task`, exposing an unguarded `general-purpose` subagent with the same tools | 8/10 |
| 3 | ~~MEDIUM~~ FIXED | `packages/agent/agent.js` | 99-137, 365-410 | `verify_customer_number` is an enumeration oracle; the "3 attempts" limit is prompt-only and keyed to a client-chosen `threadId` | 8/10 |
| 4 | ~~LOW~~ FIXED | `packages/server/src/index.js` | 536-566 | `recursionLimit: 1e4`, no timeout or step/cost cap on a chat turn | 8/10 |
| 5 | ~~LOW~~ FIXED | `packages/server/src/index.js` | 116-136, 568 | `threadId` is not bound to an authenticated principal; all clients share one Basic credential | 6/10 |
| 6 | ~~LOW~~ FIXED | `packages/agent/agent.js`, `packages/agent/file-lock.js` | 655-668 | Unlocked read-modify-write on `orders.json`, racing the hourly backup cron | 6/10 |
| 7 | ~~LOW~~ FIXED | `packages/server/src/index.js` | 52-84, 466-478 | No security headers and open CORS; the hardened header set existed only in the unused `packages/server/src/server.ts` | 7/10 |

### 1. Fail-open admin token default (HIGH) — FIXED

If neither `ADMIN_TOKEN_HASH` nor `ADMIN_TOKEN` is set, the admin token silently fell back to
the hardcoded, publicly documented value `demo-admin-token`:

```js
const adminTokenHash = process.env.ADMIN_TOKEN_HASH || hashToken(process.env.ADMIN_TOKEN || 'demo-admin-token');
```

This was fail-open and guarded the most sensitive endpoints (`/api/payments`, `/api/orders`,
`/api/admin/customers`, `/api/admin/content`, `/api/admin/menu`, `/api/admin/orders-backup`).
The comparison itself was already implemented correctly (SHA-256 plus length-checked
`timingSafeEqual`); the weakness was purely the default.

Exploit path: any internet user sends `Authorization: Bearer demo-admin-token` to a deployment
where the operator did not set the env var, and receives the full customer number list, all
orders, and all payment records including payer emails.

Fix applied: the literal fallback is removed. `configuredAdminTokenHash` is `null` when no
secret is configured, `isTokenValid` rejects every token in that state, and `requireAdminToken`
returns `503 Admin authentication is not configured.` to mirror the existing chat-auth behavior.
Verified: with no secret, `/api/orders`, `/api/payments`, and `/api/admin/customers` return 503
even with `demo-admin-token`; with `ADMIN_TOKEN` or `ADMIN_TOKEN_HASH` set, the correct token
returns 200 and `demo-admin-token` returns 401. `README.md` no longer documents a default token.

### 2. Unguarded delegated subagent (MEDIUM) — FIXED

`createDeepAgent` was called without disabling the framework's automatic `general-purpose`
subagent. deepagents unconditionally injects a `task` tool whose subagent system prompt is
generic and does **not** inherit the ordering guardrails, the "treat customer text as data"
rule, or the refusal policy from `prompt.js`. The subagent received the same tool array,
including `prepare_payment` and `finalize_order`, and ran with the parent
`configurable.thread_id`, so it operated on the live payment record.

Exploit path: injected customer text convinces the main model to call `task`; the subagent then
follows the injected instructions without role or ordering constraints and can drive payment
tools outside the scripted flow. Business impact is bounded because pricing and payment state
are server-side, so this is a guardrail bypass rather than privilege escalation.

Note: the originally suggested fix (`generalPurposeSubagent: { enabled: false }` in
`createDeepAgent`) does **not** work in deepagents 1.14.2, because that option is only read from
a registered harness profile and is ignored as a top-level parameter. Verified empirically.

Fix applied, in three layers:

1. A `subagents` entry named `general-purpose` replaces the auto-added one, so the framework's
   branch that injects the unguarded agent is skipped. The replacement reuses
   `SYSTEM_PROMPT_TEXT` and exposes no tools.
2. A `DisableTaskDelegation` middleware strips `task` from the model-facing tool list, so the
   model never sees it and cannot call it.
3. The same middleware's `wrapToolCall` refuses a direct `task` invocation with an error result,
   covering hallucinated or replayed tool calls.

Verified on the constructed agent: `task` no longer appears in the model's tool list, the
general-purpose description is inert, the "has access to all tools as the main agent" wording is
gone, and a direct `task` call returns an error.

### 3. Customer-number enumeration (MEDIUM) — FIXED

`verify_customer_number` returned a bare boolean and was invoked per tool call. There was no
counter, delay, or lockout in `agent.js` or in the `/api/chat` route. The only limit ("After 3
failed attempts, politely end the conversation") was prose in the system prompt, and `threadId`
is supplied by the client and validated only as a UUID, so the limit reset with a new UUID per
attempt. Customer numbers are short numeric identifiers (sample data: `01212`, `67221`).

Exploit path: using the shared chat credential, script `/api/chat` with a fresh UUID per
request over the `00000`-`99999` space; the tool result is echoed by the model, so existence
leaks. A discovered number is then accepted by `prepare_payment`, allowing orders to be
attributed to an arbitrary real customer.

Fix applied, in two scopes:

1. **Per thread (agent, `packages/agent/agent.js`):** failed verifications are counted in code.
   After 3 failures the tool returns `{ locked: true }`, the prompt instructions tell the model to
   end the conversation, and further attempts on that thread are refused.
2. **Per client (agent + server):** a second counter is keyed on the client address and passed
   into the agent as `configurable.client_id`. It survives new threads, so opening a fresh
   `threadId` no longer grants a fresh budget. `/api/chat` checks it before invoking the agent and
   returns `429`. A successful verification clears only the per-thread counter, so a customer who
   knows one valid number cannot reset the budget and keep enumerating.
3. **Request throttling (server):** 30 chat messages per minute and 5 new chats per minute per
   client, with `Retry-After` and audit logging.

`TRUST_PROXY=true` (set in `fly.toml`) makes Express read the real client address from
`X-Forwarded-For` with a single trusted hop. Without it, every request behind Fly's proxy shares
one address and the limits would apply globally instead of per client.

Verified: 3 bad numbers on one thread lock that thread; a fresh thread per guess stops after the
per-client budget; a legitimate customer on a clean server still completes the flow; separate
`X-Forwarded-For` client addresses get independent budgets.

### 4-7. Hardening items — FIXED

- **Resource limits (4):** a chat turn is now aborted via `AbortSignal` after
  `CHAT_TURN_TIMEOUT_MS` (default 90s) and returns 504, logged as `agent_timeout`. The 10,000-step
  `recursionLimit` remains but is now reachable only within that window.
- **Session ownership (5):** `/api/chat` and both PayPal routes call `claimThread`, which binds a
  `threadId` to the client that first used it and returns 403 to any other client. The map shares
  the agent's `MemorySaver` lifetime, so nothing is orphaned by a restart. This is defense-in-depth
  on top of v4 UUIDs being unguessable.
- **Order persistence (6):** `finalizeOrder` and `backupOrders` share `withFileLock("orders", …)`,
  so the cron's read-then-truncate cycle cannot interleave with an append. Verified with 20
  concurrent finalizations racing 10 backups: all 20 orders survive. The same test without the
  lock loses every order, confirming the race was real.

Verified: forced 50ms timeout returns 504 and logs `agent_timeout`; client B gets 403 on client
A's `threadId` for `/api/chat` and `/api/create-order` while A continues normally; the lock
race test loses no orders.

- **Transport hardening (7):** a `securityHeaders` middleware now sets a CSP, `nosniff`,
  `Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy`. The CSP allowlists only Google
  Fonts, the PayPal SDK and the Google Maps embed, because those are the third parties the SPA
  actually loads. CORS accepts same-origin requests and only those cross-origin callers listed in
  `CORS_ORIGINS`. Auth is header-based, so CSRF does not apply.

Verified in a headless browser against the built SPA: the page, the chat flow, the Google Maps
iframe and Google Fonts all render with zero CSP violations, and the PayPal SDK loads under the
policy.

## Guardrails that are present

- **No shell execution.** Although `FilesystemMiddleware` statically lists `execute`, the
  default `StateBackend` has no shell, so deepagents filters the tool out per request. No
  `child_process`, `exec`, or `eval` in `packages/agent` or `packages/server/src`.
- **No real filesystem access.** Filesystem tools operate on in-memory LangGraph state keyed to
  the thread; there is no path traversal to the host, home directory, `.env`, or SSH keys.
- **No network egress tools.** No browser, fetch, or HTTP tool and no shell, so there is no SSRF
  or exfiltration channel. Tool outputs are first-party: bundled menu JSON, local customer
  list, local payment store.
- **Server-side pricing and discounting.** `priceOrder` resolves each item against the menu
  JSON, so the model cannot set prices. Comments are trimmed, capped at 500 characters, and
  cannot change items or totals.
- **Payment gate enforced in code.** `finalizeOrder` refuses when payment is missing, pending,
  or already finalized. `capture-order` requires a matching `paypalOrderId`, `COMPLETED`
  status, and exact amount and currency before marking the order paid.
- **Customer-number check enforced in code.** `buildOrder` refuses unknown numbers, so prompt
  injection cannot skip verification for order creation.
- **Strong secret comparison.** SHA-256 plus length-checked `timingSafeEqual` for the admin
  token, and constant-time digest comparison for chat Basic auth.
- **Admin auth fails closed.** Without `ADMIN_TOKEN` or `ADMIN_TOKEN_HASH`, admin endpoints
  return 503 and no token is accepted; there is no default token.
- **No unguarded delegation.** The auto-added general-purpose subagent is replaced by an inert
  one, `task` is removed from the model's tool list, and direct `task` calls are refused.
- **Verification is rate limited in code.** Failed customer-number checks are counted per thread
  and per client, with server-side 429 responses and audit logging.
- **Chat auth fails closed** with 503 when credentials are unconfigured.
- **Input size limits.** 1 MB JSON body, 1000-character chat message cap, 10 MB PDF upload cap.
- **Request rate limits.** 30 chat messages and 5 new chats per minute per client, keyed on the
  real client address behind a single trusted proxy hop.
- **Per-turn timeout.** A chat turn is aborted after `CHAT_TURN_TIMEOUT_MS` (default 90s) and
  the client receives 504, so a stuck model call cannot hold the request open.
- **Thread ownership.** A `threadId` is bound to the client that first used it; other clients get
  403 on `/api/chat` and both PayPal routes.
- **Serialised order writes.** `finalizeOrder` and the hourly backup cron share a lock, so an
  order captured during a backup cannot be truncated away.
- **Security headers and CORS.** CSP allowlisting only Google Fonts, PayPal and Google Maps,
  plus `nosniff`, `Referrer-Policy`, `X-Frame-Options` and `Permissions-Policy`. Cross-origin
  API access requires an explicit `CORS_ORIGINS` entry.
- **Thorough prompt guardrails.** Off-topic refusal, anti-jailbreak rules, "treat customer text
  as data", no instruction or tool-name disclosure, no price negotiation, and an explicit rule
  that a customer claiming to have paid is not sufficient.
- **No XSS sink for model or customer output.** `renderMessageText` builds React elements
  without `dangerouslySetInnerHTML`; `orders.js` uses `textContent`.
- **Audit trail.** User messages, tool calls and arguments, tool results, replies, and payment
  lifecycle events are written as JSONL with 2000-character clipping.
- **Secrets are not in the repository.** `.env` is gitignored and untracked; no credentials
  appear in any tracked file.

## Recommended priority

1. ~~Remove the fail-open admin-token default~~ — **done** (finding 1).
2. ~~Disable the general-purpose subagent~~ — **done** (finding 2).
3. ~~Add server-side rate limiting and attempt accounting for chat and customer verification~~
   — **done** (finding 3).
4. ~~Add timeout, step cap, and concurrency limits; bind `threadId` to a server-issued session;
   add a lock around `orders.json` writes~~ — **done** (findings 4-6).

All seven findings are closed. Remaining work is operational rather than a code weakness: keep
`TRUST_PROXY` in sync with the actual deployment topology, and treat the in-memory limits and
thread-owner map as per-instance (they reset on restart and do not coordinate across replicas).

## Rating

All seven findings are closed. The agent is now defensibly usable for public, untrusted exposure:
no shell, no real filesystem, no network egress, server-authoritative pricing and payment state,
no unguarded delegation, code-enforced verification limits, bounded turn duration, bound thread
ownership, serialised order writes, and hardened transport headers.

The residual concerns are operational scale rather than exploitable flaws: the rate limiters and
thread-owner map are in-process, so they reset on restart and are not shared across replicas.
