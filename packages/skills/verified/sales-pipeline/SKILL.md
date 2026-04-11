---
name: sales-pipeline
description: Build and maintain a lightweight sales pipeline in Teya tables, from lead capture to next action and close status.
category: sales
audience: business
domains: ["sales", "operations", "crm"]
triggers: ["sales pipeline", "crm", "lead tracking", "deal flow", "follow up leads"]
tags: ["sales", "pipeline", "crm", "leads", "tables"]
inputs: ["offer", "pipeline stages", "lead sources", "sales owner"]
outputs: ["pipeline schema", "lead registry", "next-action review"]
order: 30
---

# Sales Pipeline

Use this skill when the user needs a practical CRM-like workflow inside Teya without setting up a separate system first.

The core rule: keep the pipeline in Teya tables, not as a one-off chat summary. The agent should create, update, and review the pipeline through `core:data`.

## When To Use

- Early-stage founder sales
- Service business lead tracking
- Simple B2B outbound or inbound pipeline management
- Weekly pipeline review and follow-up planning
- Situations where the user wants clear next actions instead of vague sales advice

## Workflow

1. Clarify the offer, sales owner, lead sources, and the stages that matter.
2. Inspect existing tables first with `core:data` before creating anything new.
3. If needed, create or reuse the tables described in [`tables.md`](./tables.md):
   - `sales_accounts`
   - `sales_opportunities`
   - optional `sales_activities`
4. Register active leads and accounts with stable identifiers and owner fields.
5. Track each opportunity by stage, value, probability, next action, and deadline.
6. During reviews, identify stalled deals, missing follow-ups, and stage bottlenecks.
7. Deliver a concrete pipeline summary with recommended actions by priority.

## Table-First Rules

- The user should not create folders, files, or tables manually.
- Prefer one stable pipeline schema over creating a new table set for each campaign.
- Use `upsert` for accounts and opportunities whenever records should persist across sessions.
- Keep `next_action` and `next_action_due_at` current so Teya can help the user operate the pipeline later.

## Output Standard

Every final pipeline review should include:

- Current pipeline by stage
- Highest-priority deals
- Stalled or at-risk opportunities
- Next actions with owners and timing

Use the outline in [`templates/pipeline-review.md`](./templates/pipeline-review.md) when the user does not provide a stronger reporting format.
