# Sales Pipeline Tables

## `sales_accounts`

Purpose: durable account-level registry.

Suggested fields:

- `account_slug` text primary key
- `account_name` text
- `segment` text
- `source` text
- `owner` text
- `status` text
- `notes` text
- `updated_at` text

## `sales_opportunities`

Purpose: one row per active or closed opportunity.

Suggested fields:

- `opportunity_slug` text primary key
- `account_slug` text
- `offer` text
- `stage` text
- `amount` number
- `probability` number
- `close_target_at` text
- `next_action` text
- `next_action_due_at` text
- `status` text
- `owner` text
- `notes` text
- `updated_at` text

## `sales_activities`

Purpose: optional timeline of calls, meetings, emails, and follow-ups.

Suggested fields:

- `activity_slug` text primary key
- `opportunity_slug` text
- `activity_type` text
- `activity_at` text
- `summary` text
- `outcome` text
- `next_step` text

## Usage Notes

1. Check existing schemas with `core:data` before creating new tables.
2. Keep stage names simple and stable, such as `new`, `qualified`, `proposal`, `negotiation`, `won`, `lost`.
3. Use `sales_accounts` for durable account context and `sales_opportunities` for pipeline state.
4. Update `next_action` fields aggressively so pipeline reviews can become operational, not descriptive.
