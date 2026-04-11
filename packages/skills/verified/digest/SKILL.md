---
name: digest
description: Build a reusable digest from structured sources, keeping the source registry and release log in Teya tables instead of ad hoc notes.
category: content
audience: both
domains: ["content", "research", "operations"]
triggers: ["digest", "newsletter", "briefing", "weekly update", "media roundup", "content summary"]
tags: ["digest", "newsletter", "sources", "tables", "content"]
inputs: ["digest goal", "source list", "cadence or time window", "audience"]
outputs: ["source registry", "digest issue outline", "publishable digest"]
order: 10
---

# Digest

Use this skill when the user wants a recurring or one-off digest built from multiple sources in a repeatable way.

The key rule: do not keep the source list only in the conversation. Store it in Teya tables with `core:data` so the digest can be updated, audited, and reused later.

## When To Use

- Weekly or daily digests
- Thematic briefings across feeds, channels, sites, or notes
- Founder, operator, research, or team updates
- Personal learning, health, style, or interest digests
- A digest that should become a repeatable workflow instead of a one-off answer

## Workflow

1. Clarify the digest goal, audience, cadence, output format, and what counts as a high-signal item.
2. Inspect existing tables first with `core:data` `schema` or `list` before creating anything new.
3. If no suitable structure exists, create or reuse the standard tables described in [`tables.md`](./tables.md):
   - `digest_sources`
   - `digest_issues`
   - optional `digest_items`
4. Register each source in `digest_sources` with a stable slug, type, owner, cadence, and notes.
5. Collect material from those sources for the requested window.
6. Score and compress the material into a small set of items that match the audience and digest goal.
7. Save the issue metadata in `digest_issues`; if the digest needs traceability, store per-item rows in `digest_items`.
8. Deliver the final digest in the requested format, with clear sections and explicit source references where possible.

## Table-First Setup

- Prefer a shared source registry over a one-off source list in chat.
- If the user has not defined sources yet, create the required Teya tables yourself with `core:data`.
- Record source metadata in tables so future digest runs can reuse, update, or deactivate sources without redefining them.
- If the user wants separate digest programs, distinguish them with a `topic`, `audience`, or `owner` field instead of creating a new schema each time.

## Source Registry Contract

- The agent creates and updates source tables itself through `core:data`.
- The user should not create folders, files, or tables manually.
- Prefer stable table names shared across digest tasks instead of creating new tables per digest.
- Reuse existing rows with `upsert` where possible, keyed by a stable slug.

## Output Standard

Every final digest should include:

- A title with the covered time window
- 3-10 high-signal items grouped by theme when helpful
- Why each item matters for the target audience
- A short closing summary or next actions

Use the outline in [`templates/digest-outline.md`](./templates/digest-outline.md) when the user does not provide a stronger format.

## Notes

- If the user already has sources in Teya tables, reuse them before asking for more input.
- If the user wants a recurring digest, keep the schema stable and append new issues over time.
- If the digest is for a niche workflow, adapt the source types and item fields but keep the same overall structure.
- If the user asks for a business digest or a personal digest, keep the same skill and adapt sources, framing, and scoring rather than inventing a separate workflow.
