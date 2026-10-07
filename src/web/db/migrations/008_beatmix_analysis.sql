-- Phase 7A scalar columns for beatmix eligibility filtering.
-- Beat/downbeat/phrase arrays stay in payload_json (see mix-transition-phase7.md
-- §13) — these three columns are the only ones needed outside the JSON blob.
-- migrate.js skips each ADD COLUMN when PRAGMA table_info already has the name,
-- so this file can be reapplied if schema_migrations lost the version row.
ALTER TABLE track_analysis ADD COLUMN downbeat_confidence REAL;
ALTER TABLE track_analysis ADD COLUMN phrase_confidence REAL;
ALTER TABLE track_analysis ADD COLUMN meter INTEGER;
