# Agent Governance for Homes & Small Teams — Product Thesis

**Status:** Thesis v1 · 2026-08-24 · Session 62
**Scope:** The unifying product story across memini-ai, neuralgentics (plugin/broker/web), and neuralgentics-gateway.

---

## Thesis

AI agents are becoming autonomous actors — they run shells, call tools, and cross the network with defaults that assume trust nobody granted. Enterprises are starting to buy governance for this; **homes and small teams have nothing**. We build the missing control plane, answerable in one sentence:

> **What may your agents touch, where may they go, and what did they actually do — checkable by a parent or a team lead from one screen.**

## Why now

Agent adoption crossed from novelty to daily-driver (our own workspace runs dozens of agentic sessions weekly). Every serious framework grants broad tool and network access by default. Incidents — leaked keys, runaway spend, kids reaching unsafe content or services through agent egress — are inevitable and visible. Meanwhile "AI governance" vendors target Fortune-500 procurement, not a parent with a homelab. The gap is structural: governance must sit **inside the stack** (tool layer, egress layer, ledger), not bolt on as SaaS policy PDFs.

## Three enforcement points — all already built, none yet integrated

| Layer          | Asset                        | State                                                                 | Governance role                                    |
| -------------- | ---------------------------- | --------------------------------------------------------------------- | -------------------------------------------------- |
| **Egress**         | `neuralgentics-gateway`      | Released: NRN policies, metadata-block, Postgres audit, dashboards    | Where agents may go                                |
| **Tool access**    | broker-go + `MEMINI_TOOL_GROUPS` (v1.6.0) | Group gating shipped; broker engine tested but not yet an MCP surface | What agents may touch, per role                    |
| **Ledger**         | memini-ai                    | Daily-driver (2.7K npm dl/mo); trust scores, audit log, persistent thought chains | What they did and why — the parent/boss readable record |

The plugin (`@veedubin/neuralgentics`) demotes to what it always should have been: installer and persona distribution — not the product.

## Who pays, and why us

- **Parents:** kid-safe agent sandboxes with a real activity feed — not browser-history guessing.
- **Solo professionals:** lock down their own sandbox (least privilege they don't have to hand-maintain).
- **Small teams (2–20):** see what employees' agents did, without enterprise procurement.
We're the credible builder here because we dogfood every layer daily — the ledger *is* our memory server; the policies protect our own keys.

## Wedge sequencing (breadth freeze in force)

1. **Live wedge — memory.** Proven pull. Keep shipping, now with governance-flavored features (role-scoped groups = v1.6.0).
2. **Next wedge — gateway.** Most differentiated, most standalone, best "stranger test" odds. Position as standalone product; measure pull via real promotion.
3. **Keystone — broker-as-MCP-server.** Completes the triangle: only-exposed-tools-are-possible-tools. Built *after* gateway shows direction, since both compete for the same build budget.
4. Web dashboards follow whichever two layers above earn users.

## Kill criteria (agreed in advance)

Two weeks of honest promotion per wedge. No stranger signups/stars/discussions → freeze integration work; keep components as personal infrastructure. The deprivation test remains the arbiter: whatever survives two weeks disabled is the actual product.

## Explicitly out of scope

Enterprise compliance certifications · hosted/cloud service before self-host adoption · new subsystems (skills brokering, KG expansion) while a wedge is unproven.
