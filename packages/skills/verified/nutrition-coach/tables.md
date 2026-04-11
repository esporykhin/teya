# Nutrition Tracking Tables

## `nutrition_goals`

Purpose: stable registry of nutrition goals and constraints.

Suggested fields:

- `goal_slug` text primary key
- `goal_type` text
- `status` text
- `target_notes` text
- `dietary_constraints` text
- `schedule_notes` text
- `started_at` text
- `updated_at` text

## `nutrition_checkins`

Purpose: lightweight tracking across time.

Suggested fields:

- `checkin_slug` text primary key
- `goal_slug` text
- `checkin_at` text
- `energy` text
- `adherence_score` number
- `meals_summary` text
- `wins` text
- `friction` text
- `next_adjustment` text

## Usage Notes

1. Check for existing health or habit tables before creating new ones.
2. Keep the schema lightweight enough that the user can maintain it through normal conversations.
3. Use `nutrition_goals` for durable setup and `nutrition_checkins` for periodic reviews.
4. If the workflow is not recurring, skip table creation and just deliver the plan.
