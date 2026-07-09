# Astra Campaign Studio

The full-chain agentic campaign platform (spec §4.1): one runtime spine, built
once, carrying a campaign from **brief intake through planning, content planning,
creation, roll-out, campaign optimisation and content optimisation** — closed by
the learning loop (§6.7) that writes outcomes back into the knowledge fabric.

> Status: **Foundation + full Stage 0–3 catalogue + Figma moment + Experience
> layer + Postgres persistence + model-graded evals + role-based access** — the
> six Common Foundation services (spec §9) are wired into a single runtime; all 25
> MVP-1 specialist agents (spec §7.3) run through stage orchestrators; the MCP-first
> Figma integration (spec §10.3) maps approved content onto a live board with
> round-trip sync; a Campaign Canvas web UI (spec §8) with an **on-screen persona
> role switcher** (spec §5) drives it all; the event log is durable on Postgres;
> and the quality gates are golden-set-anchored, model-graded evals; an Admin-only
> Settings page sets the Claude key at runtime. Reviewers **see and edit** content:
> a working review loop (view content → approve / request-changes-with-redraft) and
> **inline, versioned editing** ("edit anything, lose nothing") that re-runs the
> gates, a **Mission Control portfolio** for the CMO/Leader (pipeline, cycle time,
> quality, pending, budget), an **Admin console** (autonomy dial, agent catalogue,
> integration status, model gateway), and **conversational brief intake** — the
> Intake Agent interviews the requester and asks only what's missing (form fallback). Fully
> local — no external identity provider or cloud dependency. Grounding is real
> vector retrieval: documents are chunked, embedded and indexed in **pgvector**
> (embedded Postgres), with a runtime ingestion path in the Admin console. Proven
> by an end-to-end demo, **68 unit/integration tests, and 16 Playwright browser
> scenarios**.

## Quick start

```bash
npm install
npm run serve        # Campaign Canvas web UI at http://localhost:4000 (PORT to override)
npm run walkthrough  # one campaign through ALL SEVEN ROLES in the terminal (no server needed)
npm run demo         # runtime slice: brief → planning → content planning → creation → Figma board
npm test             # 152 unit/integration tests (full chain, gates, HITL, go-live, rollback, eval tuning, RBAC, guests, mentions, grounding, connectors, Claude Design MCP, SFMC data, deliverables & Office round-trip, intake, safety, telemetry, Postgres)
npm run e2e          # 27 Playwright browser scenarios, incl. the full chain: brief → go-live → rollback & readout → learnings
npm run demo:video   # records the captioned ~4-min product demo and renders demo/astra-demo.mp4 (needs ffmpeg)
npm run typecheck
```

**Demoing to an audience?** Follow [DEMO.md](DEMO.md) — a ~15-minute presenter script that
walks one campaign through every persona in the live UI (intake wizard → review loop →
inline edit → Figma moment → portfolio → admin console), with the governance beats called
out. `npm run walkthrough` is the same narrative, automated.

### Reasoning provider / Anthropic key

The app runs with **no API key** on a deterministic built-in **mock provider** (which is
why the demo, tests and e2e all work offline). For real Claude reasoning and genuine
model-graded evals, provide a key one of two ways:

- **At launch:** set `ANTHROPIC_API_KEY` (copy `.env.example` → `.env`), or
- **In the app:** open the UI as **Marketing Ops / Admin** → the **⚙ Admin settings** card
  lets you paste a key at runtime.

The key is held **in memory only** — never written to disk, never logged, never returned to
the client (the status API only ever shows a masked `••••1234` hint). The gateway switches to
routing through Claude the moment a key is set, and falls back to mock if it's cleared.

### Connecting Claude Design (Claude.ai Pro/Max/Team)

**Zero-credential demo path (built in):** Astra bundles a local Claude Design demo MCP
server at `POST /mcp/claude-design`. In **Admin console → Integrations → Claude Design**,
click **Use bundled demo server** — the connector performs the real MCP flow against it
(`initialize` → `tools/list` → `tools/call`), and from then on the Image Generation Agent
creates the campaign hero through its governed `create_design` tool. Designs render as
on-brand artwork served from `/assets/design-<id>.svg`, so asset cards and the Figma board
show actual images. With a real token (below), the same client talks to Anthropic's server
instead — nothing else changes.

Claude Design is an Anthropic Labs research preview at [claude.ai/design](https://claude.ai/design)
(Pro/Max/Team; default-off on Enterprise). Its MCP server (`https://api.anthropic.com/v1/design/mcp`)
authenticates via an **OAuth sign-in**, not a static API key:

1. **Verify product access** — open claude.ai/design with your subscription.
2. **Authenticate once via Claude Code** (the documented path):
   `claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp`
   then run `/design-login` inside Claude Code — this performs the OAuth flow and stores the token
   in Claude Code's credential store.
3. **Bridge to Astra**: paste the stored access token as the Bearer token in
   **Admin console → Integrations → Claude Design** (endpoint is pre-filled). On connect, Astra's
   MCP client discovers the server's design tools and exposes them through the governed registry.
   Note: OAuth access tokens expire — reconnect with a fresh token when calls start failing.
4. **Proper fix (roadmap)**: a built-in OAuth 2.1 sign-in (dynamic client registration + localhost
   callback) so step 2's bridging isn't needed. The connector seam is ready for it.

## What M0 delivers (maps to spec §9 Common Foundation)

| Foundation service | Where | Spec |
|---|---|---|
| **Campaign object** (event-sourced, versioned, replayable "blackboard"; memory/file/**Postgres** backends) | `src/domain`, `src/store` | §7.1, §11.2, §12 |
| **Orchestration** (master + per-stage orchestrators, gates, `propose→review→approve→execute`) | `src/orchestration` | §7.1 |
| **Model gateway** (Claude-first routing, fallback, per-campaign token budget, runtime key via Admin Settings) | `src/gateway` | §9.4 |
| **Grounding & context** — hybrid **vector (pgvector) + lexical** retrieval over chunked, embedded docs; runtime **ingestion** via the Admin console; citations + source versioning | `src/grounding` | §9.3 |
| **Eval & quality gates** — deterministic (grounding, accessibility) + **model-graded, golden-set-anchored** (brand/tone, compliance, localisation equivalence) | `src/evals` | §9.2 |
| **Governance & guardrails** (policy/autonomy engine, immutable audit trail) | `src/governance` | §9.1 |
| **Full Stage 0–3 agent catalogue** (25 specialist agents) | `src/agents` | §6.0–6.3, §7.3 |
| **MCP integration layer + Figma** — governed connectors; Figma is **token-optional** (live REST API when `FIGMA_TOKEN`+`FIGMA_FILE_KEY` or Admin-configured; mock board otherwise). **Two-phase mapping (§11.3)**: the board + named placeholder frames are created the moment the Campaign Scope Brief is approved, enforced as a precondition before any content agent fires; approved content then fills the frames (the populated board supersedes the placeholders, full lineage) | `src/integrations`, `src/agents/figmaAgents.ts` | §10.1, §10.3, §11.3 |
| **SFMC Data Extensions (read, MVP-1)** — token-optional governed connector (live SFMC REST when configured, bundled local dataset otherwise); the Audience Agent sizes segments from it (contacts + consented reach per market), audited like every connector call | `src/integrations/sfmcData.ts` | §4.2, §6.1, §11.2 |
| **Claude Design (Anthropic Labs)** — MCP-over-HTTP connector; discovers the server's design tools at connect time, governed like every connector. Ships with a **bundled local demo MCP server** (one-click connect, no credentials) through which the Image Generation Agent creates rendered hero artwork | `src/integrations` | §10.1 |
| **Microsoft Teams / M365** — token-optional notifications (in-app feed always, Adaptive Cards to a Workflows webhook when configured, budgeted per §8.4) + an HMAC-verified inbound endpoint that runs the intake interview from a Teams channel / Copilot Studio | `src/integrations/teams.ts`, `src/experience/notifications.ts` | §6.0, §8.4, §10.2 |
| **Artifact rendering layer** — brand-templated **PowerPoint & Excel deliverables** generated live from the campaign object (Marcom strategy deck, Marcom Plan workbook, concept deck, Campaign Scope Brief, copy matrix, launch runbook, performance report), each with an embedded lineage sheet/slide; **Office round-trip**: edit the Marcom Plan in Excel, re-upload, and the platform diffs the structured regions and applies confirmed changes as attributed human versions; **template conformance is a quality gate** — generated files are validated (typography, palette, mandatory footer, lineage) before download and at the stage gate | `src/rendering`, `src/evals/templateConformance.ts` | §9, §9.5, §9.6 |
| **Experience layer** (Campaign Canvas UI, Mission Control, **Asset Studio** — the creator/designer workbench with content grouped by channel and the board alongside, **unified cross-campaign Review & Approvals inbox**, Deliverables rail, **natural-language orchestrator commands** — "add a LinkedIn variant for the DACH market", "status" — plus projections + API) | `src/experience` | §8 |
| **Role-based access** (persona catalogue, RACI authority, on-screen role switcher, enforced) | `src/security` | §5 |
| **Transparency & SLAs** — every artifact carries an **AI / Human provenance badge** (EU AI Act transparency), and in-review items carry a **per-stage review SLA** with overdue flags in the canvas and inbox. **Email intake**: `POST /api/inbound/email` runs the same interview on a mail thread — asks only what's missing, creates on a complete brief | `src/experience` | §6.0, §10.1, §14 |
| **Content safety** — PII/secret redaction on outbound model prompts, injection defences on connector results and ingested docs, Trust & safety counters in the Admin console | `src/security/contentSafety.ts` | §9.5, §13, §14.1 |
| **MVP-2: Roll-out** — 9 publishing agents, deployments as reviewable artifacts, **go-live** gated on approved deployments + a passing consent check, irreversible connector calls doubly enforced (Contentful, DAM, SFMC, ad networks, Jira as governed connectors) | `src/agents/rollout.ts`, `src/integrations/publishing.ts` | §6.4, §10.2 |
| **MVP-2: Campaign optimisation** — analytics connector (deterministic synthetic metrics), 6 agents, **bounded autonomy**: within-guardrail moves apply at L3, material moves require a human regardless of the dial | `src/agents/optimisation.ts`, `src/integrations/analytics.ts` | §6.5 |
| **MVP-2: Performance surface** — live KPIs vs the targets locked at planning, per-channel fatigue trends, budget moves with governance badges, experiments & anomalies; the Performance Marketer's home view | `src/experience/projections.ts` (`performanceView`) | §8.2 |
| **MVP-2: Optimisation honesty** — one-click **rollback** of applied moves (compensating, audited artifacts), a **regression eval** so refreshes never degrade a winning asset, and the **experiment readout → apply-winner** loop (readout auto at L3; the creative change waits for a human and re-passes brand/compliance) | `Orchestrator.rollbackArtifact`, `regressionEvaluator`, `src/agents/optimisation.ts` | §6.5, §9.2, §6.6 |
| **Localisation Workbench** — market-by-market, side-by-side source/target with the equivalence eval inline; approve or request-changes per variant; the Localisation persona's home | `localisationView`, `#localisationView` | §8.2 |
| **12 personas incl. scoped guests** — Localisation/Regional Marketer, Data/Insights Analyst (signs off learnings), and the **External Agency Partner**: campaign-scoped guest access assigned from the Admin console and enforced centrally on every campaign route | `src/security/roles.ts`, `src/security/guestAccess.ts` | §5.1, §13 |
| **Eval feedback loop + admin-editable golden set** — human rejections of gate-passing copy land in an Admin adjudication inbox; accepting one anchors future model-graded runs as an off-brand exemplar; banned terms and exemplars are curated live (the gate flips immediately) | `GoldenSetStore`, Admin console → "Quality gates · golden set" | §9.2 |
| **Diff-first editing** — every new artifact version (edit, redraft, applied winner) carries a word-level **View changes** diff against its predecessor | `#artifacts` cards (`diffWords`) | §8.4 |
| **Command palette** — Ctrl+K anywhere: fuzzy-filtered, **role-aware** actions (navigate, run stage, approve queue, advance, go-live when applicable, switch persona, open campaign, new intake) | `#palette` | §8.4 |
| **@mentions / hand-offs** — pull any persona (incl. agency guests) into an artifact; event-sourced and audited; threads on the card, lands in the target's **"Your hand-offs"** queue with a priority notification; only the mentioned role (or an admin) closes it | `MentionAdded/Resolved` events, `Astra.addMention` | §8.4 |
| **Delivery telemetry** — **rework rate**, **human-edit distance** (word-level vs. predecessor) and **tokens per approved item**, computed from the event log and shown as canvas pills | `campaignCanvas` telemetry, `editDistanceRatio` | §14.1 |
| **MVP-2: Content optimisation + learning loop** — fatigue detection, refresh/persona variants re-entering the same brand/compliance gates, and approved **Learnings written back to the knowledge fabric** so the next campaign starts smarter | `src/agents/contentOptimisation.ts` | §6.6, §6.7 |

## Architecture in one paragraph

Every change to a campaign is an **append-only event**; the campaign object is a fold
over that log, so state is auditable and replayable (`CampaignRepository`). Agents never
mutate state — they **propose** artifacts (`Orchestrator.runAgent`), which are graded by
**stage-appropriate evals** before a human (per the **autonomy policy**) approves at a HITL
checkpoint. Only approved artifacts satisfy a **stage gate** and let the campaign advance.
All model calls go through the **gateway** (Claude-first, budgeted); all knowledge retrieval
goes through the **grounding fabric** (cited). The **audit trail** is a projection of the log —
who/what/when/why on every action, for free.

## Layout

```
src/
  domain/         campaign object types, events, ids
  store/          append-only event store (memory, file, Postgres/PGlite) + repository (fold)
  gateway/        model gateway + providers (mock, anthropic)
  grounding/      knowledge fabric: chunking + local embedder + in-memory & pgvector retrieval
  evals/          async eval harness + model-graded evaluators + golden set + gate config
  governance/     policy/autonomy engine + immutable audit trail
  orchestration/  agent contract + factory, stage state machine, master & stage orchestrators
  integrations/   MCP connector framework (governed) + Figma connector & placeholder schema
  security/       persona catalogue + RACI authority + access-control enforcement
  experience/     read-model projections + zero-dep HTTP API + Campaign Canvas web UI (role switcher + admin settings)
  agents/         full MVP-1 stage 0–3 catalogue + Figma mapping / round-trip agents
  app.ts          Astra composition root (wires all six services + connectors)
scripts/demo.ts            runnable end-to-end §16 narrative slice
scripts/roleWalkthrough.ts one campaign through all seven roles (the DEMO.md narrative, automated)
test/             foundation invariant tests (54)
e2e/              Playwright browser scenarios (15: role lenses, RBAC, review loop, admin, layout)
DEMO.md           presenter script for the live UI demo
```

## What's next (build order from here)

1. ~~**Full agent catalogue** — stages 0–3 to the complete §7.3 set.~~ ✅ **done** (25 agents).
2. ~~**MCP connector framework + Figma** — the "Figma moment" (§10.3).~~ ✅ **done**.
3. ~~**Experience layer** — Campaign Canvas / Mission Control / Review inbox.~~ ✅ **done**.
4. ~~**Persistence** — Postgres event store behind the `EventStore` seam.~~ ✅ **done**
   (embedded PGlite by default; real Postgres via `DATABASE_URL`).
5. ~~**Real evals** — model-graded + golden-set-anchored scoring (§9.2 hardening).~~ ✅ **done**
   (deterministic where objective; model-graded brand/tone, compliance, localisation).
6. ~~**Role-based access** — persona catalogue + RACI authority, enforced.~~ ✅ **done**
   (on-screen role switcher, no external IdP — fully local).

**Deferred (enterprise/cloud, out of local scope for now):** Entra ID SSO, ABAC by
market/brand, and Azure-native IaC deployment (§13). The `AccessControl` service and
`EventStore`/`ModelProvider` seams are where these slot in when the platform moves to
a hosted environment.
