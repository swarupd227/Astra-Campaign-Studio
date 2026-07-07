# Demo script — one campaign, every role

A ~15-minute live walkthrough of Astra Campaign Studio: one campaign travels from a
structured brief to a populated Figma board, and you play each persona along the way
using the **role switcher** (header, "Signed in as"). Every beat below is real,
enforced behaviour — nothing is staged.

> **Prep (2 min).** Fresh state reads best:
> ```bash
> # stop any running server, then:
> rm -rf .data          # PowerShell: Remove-Item -Recurse -Force .data
> npm run serve         # → http://localhost:4000
> ```
> The app seeds one campaign at Intake. Optional: as **Marketing Ops / Admin**, paste an
> Anthropic key in **Model gateway** so generation runs on Claude; without it the mock
> provider keeps everything deterministic and free.
>
> **No-UI fallback:** `npm run walkthrough` runs this entire narrative in the terminal.

---

## Scene 1 · Campaign Manager — a structured brief, not a chat prompt

*Role:* **Campaign Manager** (default)

1. Click **New campaign**. The **conversational intake** opens (spec §6.0 — intake is
   where you win or lose the cycle). The Intake Agent interviews you and **asks only
   what's missing**.
2. Answer the first question with one rich sentence:
   `Launch the new Hilti cordless tool platform across DACH and the US, budget €750k` —
   watch it acknowledge objective, markets *and* budget, then skip straight to the
   success metric. Answer `qualified leads`, then give the mandatory claim:
   `Cordless performance claims require a test-condition footnote.`
3. It summarises the brief and asks to confirm — say `yes` → campaign created, brief
   drafted from the interview. (Prefer fields? The **Form** tab is the same intake.)
4. On the brief card, the content is open by default — point at **Mandatory Claims**:
   > "Everything downstream is grounded in this. Watch this exact claim police the copy later."
5. Note the eval chip **Sourced** and the **Sources** line — every artifact is grounded and cited.

**Governance beat:** switch to **Legal / Compliance**. The same brief now shows
*"Awaiting review by the role that owns this sign-off"* — no Approve button. Legal has no
authority at Intake; that's the RACI enforced server-side, not hidden buttons.

Switch back to **Campaign Manager** → **Approve** all three intake items → **Advance to
next stage** unlocks (the stage gate needs an approved brief).

## Scene 2 · Planning — eight specialists, one approval flow

*Role:* **Campaign Manager**

1. **Run current stage** → watch **Live activity**: 8 planning agents draft strategy,
   audiences, value prop, messaging, media plan, budget, competitive read, **locked KPIs**.
2. Open **View content** on *Channel & media plan* and *Locked KPIs*:
   > "KPIs locked at planning are what optimisation later steers toward — the platform
   > optimises the metric a human agreed, not one it invented."
3. Switch to **Marketing Leader / CMO**, approve *Campaign strategy* (their sign-off),
   switch back, then use the **command rail**: type `approve all`, then `advance`.

## Scene 3 · Content planning — Brand joins the loop

*Role:* **Content Strategist** → **Brand Guardian**

1. As **Content Strategist**: **Run current stage** → concept, storyboard, calendar,
   channel briefs (the Campaign Scope Brief), nurture journey, PDP plan.
2. As **Brand Guardian**: your queue shows the brand-relevant items. Approve
   *Selected concept* — concept selection is a human call, supported by a ranked rationale.
3. Back as **Content Strategist**: `approve all`, then as **Campaign Manager**: `advance`.

## Scene 4 · Content creation — the heart of the demo

*Role:* **Creator** → **Legal** → **Creator** → **Brand Guardian**

0. **Optional 20-second setup that pays off big:** as **Marketing Ops / Admin**, in the
   Admin console under *Integrations → Claude Design*, click **Use bundled demo server**.
   The connector runs the real MCP handshake locally and discovers `create_design` /
   `refine_design`. The hero image in step 1 will now be *created through Claude Design*
   — watch for “Generated the hero via Claude Design (governed MCP)” in its rationale
   and the `claude-design · create design` entry in the audit trail.
1. As **Creator**: **Run current stage** → copy, landing page, email, module, hero image,
   channel crops, LinkedIn variant, German transcreation. Every card carries five eval
   chips: **Sourced · On brand · Compliant · Accessible · Localised**. The **Hero image**
   card shows the actual rendered artwork — click it to open full size.
2. **The review loop.** Switch to **Legal / Compliance**, open *Paid-social copy* →
   **Request changes** → feedback: `Lead with jobsite uptime and cite the runtime footnote
   explicitly.` → the producing agent **redrafts with that feedback**; v1 shows *Changes
   requested*, a v2 arrives in review, and its rationale quotes your feedback verbatim.
3. **Edit anything, lose nothing.** Switch to **Creator**, click **Edit** on the redraft,
   change the headline (e.g. `Zero downtime. Total control.`) → **Save changes** → a v3
   appears, re-evaluated, back in review; v2 is *Superseded*, history intact.
   > If time allows: edit again and *delete the footnote* — the **Compliant** chip fails
   > and the save is blocked at the gate. The mandatory claim from Scene 1, doing its job.
4. As **Legal**: approve the copy. As **Brand Guardian**: `approve all`.
5. **The Figma moment.** The instant its sources are approved, the **Figma board** card
   populates — all six named frames (paid headline/body, hero image, email subject/hero,
   landing hero) filled deterministically from *approved* content via the governed MCP tool.
   The hero frame shows the artwork itself, large — this is the money shot.
6. **Round-trip:** in the Figma card, pick *Paid headline*, type new text, **Sync** —
   the designer's edit flows back as a new board version. Approve the board, then as
   **Campaign Manager**: `advance` → the campaign reaches **Roll-out** (MVP-2 territory).

## Scene 4b · Roll-out — go-live is a human decision

*Role:* **Marketing Ops / Admin** (or Channel Specialist)

1. `advance` to **Roll-out**, then **Run current stage** → 9 publishing agents prepare
   deployments (Contentful entry, DAM pack, ad campaign, SFMC journey), plus the QA
   pre-flight and the **consent & preference check** — all as reviewable artifacts.
   Nothing has touched an external channel yet.
2. Try the red **Go live** button *before* approving → blocked: *"the consent &
   preference check must be approved and passing first."* The §6.4 non-negotiable, live.
3. `approve all`, then **Go live** → confirm → *"Live — executed 4 deployments:
   contentful, dam, ads, sfmc."* Point at **Live activity**: each publish/send/launch is
   an audited `irreversible` connector call — the registry independently refuses these
   without the explicit human approval flag.

## Scene 4c · Optimisation — bounded autonomy earns its keep

*Role:* **Performance Marketer** (lands on the **Performance** surface automatically)

1. As Marketing Ops: `advance`, **Run current stage** → six optimisation agents pull
   analytics and act. Switch to **Performance** (top nav):
   - KPI cards: **leads vs the target locked at planning**, blended CPL vs the guardrail,
     spend, live channels.
   - **Channel trend**: paid-social CTR bars visibly decay (creative fatigue) while email
     holds — synthetic but deterministic, so the story always tells.
   - **Budget moves**: the 8% shift is badged *applied automatically* (L3, within the 10%
     guardrail); the 25% shift sits *awaiting approval* — material moves need a human
     **regardless of the autonomy dial**.
2. Click **Pull fresh metrics** a couple of times — each snapshot deepens the fatigue trend.
3. **Experiments panel:** the A/B test has been **read out** — *"winner: Variant B, +N% CTR
   at 96% confidence."* The **Apply Winner** change sits in the review queue: a creative
   change never auto-applies, and it re-passes brand/compliance (§6.6 no-bypass). Approve
   it → the live paid-social copy is superseded by the proven headline.
4. **Rollback beat:** on the applied 8% budget move, click **Roll back** ("CPL worsened
   after the shift") → a compensating, audited move reverses it and the original is badged
   *rolled back*. §6.5's "every optimisation is reversible" — literally.

## Scene 4d · Content optimisation + the learning loop

*Role:* **Performance Marketer** → **Brand Guardian**

1. `advance`, **Run current stage** → fatigue report, a **refreshed hero**, an MEP-persona
   variant, SEO refresh, the backlog — and **Campaign learnings**.
2. The refreshed creative carries the same eval chips as net-new work: *"no optimisation
   bypasses brand, compliance or accessibility"* (§6.6). Brand re-approves it.
3. Approve **Campaign learnings** → the notification: *"Learnings written back to the
   knowledge fabric."* Open Admin → Knowledge fabric: the campaign's insight is now an
   indexed source — **the next campaign starts smarter** (§6.7). That's the compounding
   close of the pitch.

## Scene 4e · Localisation Workbench + the agency guest (optional, 60s)

*Role:* **Localisation / Regional Marketer** → **Marketing Ops** → **External Agency Partner**

1. Switch to **Localisation / Regional Marketer** — they land on the **Workbench**: the DE
   transcreation **side-by-side with its English source**, market chip, and the
   equivalence eval inline. Approve or send back per variant (§8.2).
2. Switch to **External Agency Partner** — the campaign picker is **empty**: guests see
   nothing until an admin shares work with them. As **Marketing Ops**, open **Guest
   access** in the Admin console and *Share with agency* → switch back: the agency now
   sees exactly that one campaign, can contribute — and has **no approve buttons** (§5.1
   scoped guest workspace, §13).

## Scene 5 · Marketing Leader — Mission Control

*Role:* **Marketing Leader / CMO** (lands on **Portfolio** automatically)

- Six KPI cards: active campaigns, pending approvals, items approved/produced,
  quality-check pass, planned budget, open risks.
- **Pipeline by stage** and **cycle time by stage** — computed from the event log, not typed in.
- Click the campaign row → drills straight into its Canvas.
- Spend/ROI is labelled **MVP-2** — honest about what connects when finance/analytics land.

## Scene 6 · Marketing Ops — the platform is configurable

*Role:* **Marketing Ops / Admin**

The **Admin console** (only this role sees it): **Model gateway** (runtime Claude key,
masked, in-memory only) · **Knowledge fabric** · **Autonomy dial** — flip content
creation from L1 to **L3 · Bounded** and agents there now act within guardrails without
per-action approval (spec §7.2's dial, live) · **Agent catalogue** (24 agents by stage) ·
**Integrations** — both creative connectors are **token-optional and configurable live**:
paste a Figma personal-access token + file key and the board tools read your *real* file
(mapped copy lands as comments on it); paste a Claude Design bearer token and the MCP
connector discovers the server's design tools on the spot. SFMC, Contentful, DAM, Jira,
ad networks and analytics stay flagged MVP-2.

**The Teams beat (30 seconds).** The **Notifications** card (right column) has been filling
up all demo long — campaign created, items awaiting review, stage advanced, changes
requested — each one a governed, budgeted connector call (§8.4). Paste a Teams Workflows
webhook in the **Microsoft Teams** panel and the same notifications post to a channel as
Adaptive Cards; point a Teams outgoing webhook at `POST /api/inbound/teams` and the intake
interview runs *inside Teams* (§6.0's "capture requests from any entry point").

**The grounding beat (worth 60 seconds).** In **Knowledge fabric**, paste a new document —
title `TE 60 rotary hammer spec sheet`, text: `The TE 60 rotary hammer delivers SDS max
chiseling power with active vibration reduction. Approved claim: best-in-class drilling
speed in concrete under standard test conditions.` → **Index document** (chunked, embedded,
stored in pgvector). Now create a new campaign whose objective mentions the TE 60 — the
intake brief's **Sources** line cites your document *first*. Nothing was retrained;
the fabric is live, versioned, and every agent retrieves from it.

## Closing beat — production-grade, not a puppet show

Scroll **Live activity**: every draft, quality check, approval, denial, edit, redraft and
Figma call — who, what, why — is an immutable, replayable event stream (the audit trail is
a projection of it). Then the pills up top: stage, review load, **quality-check pass**,
items. *"The demo you just saw is the product's first vertical slice — the same runtime,
governance and UX carry through to MVP-2."*

---

### Cheat sheet

| Scene | Role | Do |
|---|---|---|
| 1 | Campaign Manager | New campaign wizard → approve intake → advance |
| 1b | Legal | Show denied lens at intake |
| 2 | CM → CMO | Run planning → CMO approves strategy → `approve all`, `advance` |
| 3 | Strategist → Brand | Run content planning → Brand approves concept → advance |
| 4 | Creator → Legal → Creator → Brand | Draft → request changes → inline edit → approve → **Figma board** → round-trip |
| 4b | Marketing Ops | Roll-out: deployments → consent gate blocks → **Go live** |
| 4c | Performance Marketer | **Performance surface**: fatigue trend, auto vs. approval-required budget moves |
| 4d | Perf. Marketer → Brand | Refresh re-gated → **learnings written back** to the fabric |
| 5 | Marketing Leader | Portfolio: KPIs, pipeline, cycle time, drill-in |
| 6 | Marketing Ops | Admin: gateway key, knowledge fabric, autonomy dial, agents, integrations |

Command rail shortcuts: `run stage` · `approve all` · `advance`.
