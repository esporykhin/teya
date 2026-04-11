---
name: nutrition-coach
description: Build a practical nutrition routine around goals, constraints, and habits, and store recurring plans or logs in Teya tables when useful.
category: health
audience: personal
domains: ["health", "nutrition", "wellbeing"]
triggers: ["nutrition coach", "meal plan", "diet plan", "healthy eating", "nutrition routine"]
tags: ["nutrition", "health", "meals", "habits", "tables"]
inputs: ["goal", "dietary constraints", "schedule", "food preferences"]
outputs: ["nutrition plan", "meal structure", "tracking setup"]
order: 50
---

# Nutrition Coach

Use this skill when the user wants a sustainable nutrition plan, a simple meal structure, or a repeatable way to track eating habits over time.

This is a coaching and planning skill, not a medical authority. Keep guidance practical and avoid pretending to diagnose or treat conditions.

## When To Use

- Building a sustainable eating routine
- Weight loss, weight gain, or maintenance planning
- Protein, meal timing, or consistency problems
- Busy schedules that need repeatable meal structure
- Situations where the user wants Teya to help track habits across time

## Workflow

1. Clarify the user's goal, schedule, preferences, restrictions, and non-negotiables.
2. Identify the smallest plan the user can actually follow consistently.
3. If recurring tracking would help, inspect existing tables first and then create or reuse the structures described in [`tables.md`](./tables.md).
4. Translate the goal into a daily or weekly meal structure, habit anchors, and simple rules.
5. If the user wants ongoing support, record goals and logs in Teya tables so future check-ins can build on real history.
6. Deliver the plan with a focus on adherence, not perfection.

## Rules

- Do not ask the user to create folders, files, or tables manually.
- Prefer repeatable meal templates over complex custom menus unless the user explicitly wants detailed meal planning.
- If the user has medical conditions, allergies, or symptoms that require clinician input, say so clearly and keep within general guidance.
- Use tables only when the workflow is recurring; do not create tracking overhead for a one-off question.

## Output Standard

Every final plan should include:

- Primary goal and operating constraints
- Meal structure or eating framework
- A few habit anchors or non-negotiables
- A simple tracking or check-in plan if relevant

Use the template in [`templates/nutrition-plan.md`](./templates/nutrition-plan.md) when the user does not provide a stronger format.
