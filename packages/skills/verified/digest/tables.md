# Digest Tables

Use `core:data` to inspect existing tables first. If there is no suitable setup yet, create the following shared tables.

## `digest_sources`

Purpose: the source registry for recurring digests.

Suggested columns:

- `slug` `text` `unique` `not_null`
- `title` `text` `not_null`
- `source_type` `text` `not_null`
- `source_ref` `text` `not_null`
- `topic` `text`
- `audience` `text`
- `cadence` `text`
- `status` `text`
- `owner` `text`
- `notes` `text`
- `meta` `json`

Suggested indexes:

- unique index on `slug`
- index on `topic`
- index on `status`

## `digest_issues`

Purpose: one row per published or drafted digest issue.

Suggested columns:

- `slug` `text` `unique` `not_null`
- `title` `text` `not_null`
- `time_window` `text`
- `audience` `text`
- `status` `text`
- `summary` `text`
- `output_format` `text`
- `notes` `text`
- `meta` `json`

Suggested indexes:

- unique index on `slug`
- index on `status`
- index on `audience`

## `digest_items`

Purpose: optional item-level traceability for larger or recurring digests.

Suggested columns:

- `issue_slug` `text` `not_null`
- `source_slug` `text`
- `item_key` `text` `not_null`
- `title` `text` `not_null`
- `url` `text`
- `published_at` `datetime`
- `score` `real`
- `theme` `text`
- `summary` `text`
- `why_it_matters` `text`
- `meta` `json`

Suggested indexes:

- unique index on `item_key`
- index on `issue_slug`
- index on `source_slug`
- index on `published_at`

## Example Flow

1. `schema` to check whether these tables already exist.
2. `create_table` for missing tables.
3. `upsert` rows into `digest_sources` as the source registry changes.
4. `insert` or `upsert` a row in `digest_issues` for each new digest.
5. Optionally persist the chosen items in `digest_items`.
