-- Vocal-activity columns for Phase 6 MIX transitions.
-- ADD COLUMN is idempotent: migrate.js ignores duplicate-column errors so this
-- file can be reapplied if schema_migrations lost the version row.
ALTER TABLE track_analysis ADD COLUMN last_vocal_end_sec REAL;
ALTER TABLE track_analysis ADD COLUMN vocal_gaps_json TEXT;
ALTER TABLE track_analysis ADD COLUMN analysis_source TEXT;
