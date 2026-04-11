---
name: personal-stylist
description: Turn a user's goals, lifestyle, body preferences, and wardrobe constraints into a practical styling direction and outfit plan.
category: style
audience: personal
domains: ["style", "image", "wellbeing"]
triggers: ["stylist", "personal style", "wardrobe", "outfit planning", "style advice"]
tags: ["style", "wardrobe", "outfits", "personal", "image"]
inputs: ["style goal", "occasion or lifestyle", "preferences", "constraints"]
outputs: ["style direction", "outfit ideas", "shopping priorities"]
order: 40
---

# Personal Stylist

Use this skill when the user wants help with style identity, wardrobe decisions, outfit planning, or dressing for a specific context.

This skill should stay practical. Do not give abstract fashion commentary when the user needs wearable choices.

## When To Use

- Building a clearer personal style
- Planning outfits for work, travel, events, or dating
- Cleaning up a wardrobe and identifying gaps
- Creating a tighter shopping list instead of random purchases
- Adapting style advice to budget, climate, body preferences, and cultural context

## Workflow

1. Clarify the user's goal, lifestyle, constraints, budget, climate, and what they want to signal visually.
2. Identify what the user already owns or is willing to buy.
3. Define a compact style direction in plain language, not vague aesthetics jargon.
4. Translate that direction into outfit formulas, wardrobe gaps, and shopping priorities.
5. Keep recommendations consistent with the user's real life and maintenance tolerance.

## Rules

- Prefer a small number of repeatable outfit formulas over endless options.
- Respect budget and practicality before trendiness.
- If the user is unsure about fit, silhouette, or color direction, explain the tradeoff and choose a default.
- Avoid recommending a full wardrobe rebuild unless the user explicitly wants one.

## Output Standard

Every final answer should include:

- A clear style direction
- 3-7 repeatable outfit formulas
- A short list of wardrobe gaps or upgrades
- Practical shopping priorities in order

Use the template in [`templates/wardrobe-plan.md`](./templates/wardrobe-plan.md) when the user does not provide a better format.
