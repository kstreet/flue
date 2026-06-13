# Channel Follow-Ups Roadmap

## Status

The ten-provider first-party channel plan is implemented and audited. This
document records release work, deferred product decisions, and candidate
expansions without reopening the completed ingress design.

Scope decisions confirmed after implementation:

- channel examples prove Node and Cloudflare compatibility; they are not
  turnkey deployment projects and do not own Wrangler migration history;
- provider installation, credentials, webhook registration, and outbound
  behavior are developer-owned application concerns, not future channel-core
  work;
- long-lived transports are unsupported for now; a provider that requires one
  is ineligible until Flue intentionally adds that transport class;
- recurring conformance work should be captured as an agent skill, not a
  repository script.

## Principles

- Preserve the current ownership boundary: Flue owns verified ingress,
  provider identity, protocol responses, and routing; applications own SDK
  clients, credentials, tools, and broad outbound behavior.
- End the first-party channel responsibility at successful HTTP webhook
  receipt and response. App installation and lifecycle management remain
  outside the core even when a provider commonly pairs them with webhooks.
- Require Node and Cloudflare Workers execution for every canonical path.
- Add provider-specific behavior only when official protocol semantics justify
  it. Do not introduce a universal event schema, outbound client, or tool set.
- Do not add a provider whose useful ingress requires a socket, polling loop,
  or other long-lived process under the current channel model.
- Continue using primary provider sources and original synthetic fixtures.

## 1. Release The Completed Channels

This is the immediate next milestone.

- Choose the release version and publish the ten `@flue/*` channel packages
  together with the runtime and CLI changes they require.
- Deploy `apps/www` so the public connector registry serves all ten named
  recipes before announcing `flue add <provider>`.
- Publish the updated documentation and verify every public guide, API page,
  and connector markdown URL.
- Repeat the packed-artifact consumer check against the actual published
  versions.

Release exit criteria:

- every package is installable from the registry;
- every public `flue add` command returns the intended recipe;
- Node and Cloudflare examples build from published artifacts;
- no guide points at an unpublished package or undeployed connector.

The existing missing-Durable-Object-migration warning is not a channel release
blocker. These examples are compatibility and integration fixtures, not
deployment-ready Wrangler projects, and the channel plans never committed to
owning deployment migration history.

## 2. Capture Channel Conformance As An Agent Skill

The final audit required judgment as well as commands, so it should not become
another repository-owned script.

- Add a repository agent skill for researching, implementing, auditing, and
  releasing one first-party HTTP channel.
- Teach the skill to inspect the current provider package and example set
  rather than relying on a hard-coded list.
- Let the skill delegate independent provider research, package review,
  workerd review, docs review, and artifact inspection to subagents when useful.
- Require delegated subagents not to spawn their own subagents.
- Require the implementing agent to reconcile subagent findings and retain
  responsibility for final correctness.
- Include package build, strict types, Node tests, workerd tests, Node and
  Cloudflare example builds, fake outbound transports, packed artifacts, clean
  consumers, connector output, documentation consistency, and focused security
  review.
- Keep provider protocol assertions in provider suites. The skill should
  orchestrate and audit durable public contracts, not duplicate them in a
  generic test harness.

## 3. Core Non-Goals

The following are intentionally outside the first-party channel core:

- app, bot, account, and marketplace installation flows;
- OAuth callbacks, consent, credential encryption, refresh, rotation, and
  revocation;
- tenant or workspace credential lookup;
- webhook registration, renewal, and unregistration;
- broad outbound provider APIs, tools, rich UI builders, uploads, history, and
  search;
- application authorization policy and provider-backed idempotency claims;
- multi-tenant installation orchestration.

Examples and connector guides may explain the minimum configuration needed to
receive a webhook, but Flue should not grow core abstractions for these
application responsibilities. Conversation keys remain identifiers, never
authorization capabilities.

## 4. Expand Existing HTTP Surfaces Only From Concrete Demand

Expand packages only when verified ingress normalization or provider response
semantics require package work. Keep outbound behavior in project-owned
clients and tools.

- Slack: richer HTTP event families and attachment metadata.
- Discord: richer HTTP interaction families and command registration guidance.
- Teams: additional HTTP activity families and file-card metadata that arrives
  directly in verified activity payloads.
- Google Chat: Workspace Events subscription lifecycle, cards, reactions, and
  other verified HTTP event families.
- Linear: broader issue and project events plus agent-activity policy examples.
- Telegram: additional webhook Update families, typing, and media examples.
- WhatsApp: additional incoming message, status, media, Flow callback, and edit
  semantics when Meta documents a stable protocol.
- Twilio: add Messaging webhook families only; treat Voice, Conversations, and
  Verify as separate provider-channel research.
- Messenger: additional incoming webhook families only after concrete demand.

## 5. Research New First-Party Channels

Each candidate starts with the same clean-room provider process. It is eligible
only when its useful inbound integration fits stateless HTTP webhook receipt
and has a defensible Node and Cloudflare Workers path. Defer it immediately if
it requires a long-lived transport, provider-managed process, Node-only
runtime, or installation system inside Flue core.

### Stripe

High priority because the channel API was originally shaped around Stripe's
verified event construction model and Stripe webhooks are common agent
triggers.

- Verify the current Stripe SDK's exact request-byte verification path in
  workerd.
- Support a fixed `/webhook` route with typed `Stripe.Event` delivery if the
  official SDK executes on both targets.
- Keep all Stripe API operations and tools project-owned through the exported
  SDK client.

### Inbound Email / Resend

High priority for support, sales, and operations agents. Vercel's public adapter
directory highlights inbound email through Resend as a useful platform class.

- Research Resend inbound email webhook verification, batching, attachment
  retrieval, retries, and canonical thread identity.
- Prefer the official Fetch-based client if it passes workerd.
- Treat outbound email composition and reply policy as project-owned behavior.

### Notion

- Confirm the current webhook verification, supported event families, retry
  behavior, workspace identity, and resource identity.
- Ship only if useful inbound behavior works with developer-owned OAuth and
  installation state.

### Shopify

- Research webhook HMAC verification, topic and shop identity, retry behavior,
  API versioning, batching, and stable resource identity.
- Keep app installation, access tokens, and outbound Admin API behavior
  developer-owned.

### Intercom

- Research webhook verification, workspace identity, delivery retries, event
  families, and stable conversation or ticket identity.
- Do not take ownership of app installation, OAuth, inbox policy, or outbound
  support operations.

### Zendesk

- Research webhook authenticity, account identity, ticket and conversation
  event semantics, retries, and any provider-required response behavior.
- Defer if a trustworthy inbound path requires a long-lived integration
  service rather than developer-owned setup plus stateless webhooks.

Research these one at a time. A provider being popular is not enough to relax
the HTTP, clean-room, or Cloudflare gates.

## 6. Keep These As Separate Product Decisions

### Generic HTTP or webhook adapter

Flue already supports `flue add <provider-docs-url> --category channel` and a
custom-channel guide. A generic package cannot safely supply provider
verification, identity, retry, or response semantics.

Improve the custom-channel recipe, reusable test fixtures, and conformance
helpers before considering a generic runtime abstraction. Public demand:
<https://github.com/vercel/chat/issues/96>.

### Agent Client Protocol

ACP may be a direct agent transport rather than a provider webhook channel.
Evaluate its routing, session identity, streaming, and authentication against
Flue's existing agent HTTP and WebSocket surfaces before assigning ownership.
Public request: <https://github.com/vercel/chat/issues/552>.

## 7. Unsupported Transport Classes

Slack Socket Mode, Discord Gateway, Telegram polling, and similar persistent
connections are out of scope. They require lifecycle, reconnection, cursor,
heartbeat, and durable ownership semantics that the current HTTP channel model
does not provide.

Do not add a provider that requires one of these transports. Reconsider this
only through a separate product decision that intentionally introduces a
long-lived transport model; do not approximate it through channel route
declarations.

## Suggested Sequence

1. Release and deploy the completed ten-provider work.
2. Add the channel implementation and conformance agent skill.
3. Research Stripe, Notion, Resend, Shopify, Intercom, and Zendesk one at a
   time, shipping only after the HTTP and Cloudflare gates are proven.
4. Reassess existing HTTP provider expansions from user demand after the first
   channel release has real adoption data.

No additional channel was added during the final audit. Starting another
provider after the completed cross-provider review would require a fresh
research, implementation, testing, and audit cycle; the candidates above are
better handled as independent workstreams.
