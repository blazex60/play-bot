-- Spotify support (OAuth routes, DB tokens, import pipeline) was fully
-- removed from the product — only YouTube remains. service_links.service's
-- CHECK constraint still allowed 'spotify' as a past-remnant leftover from
-- before that removal (001_init.sql is immutable, so this can't be edited in
-- place). SQLite has no ALTER TABLE ... DROP CONSTRAINT, so tighten the
-- constraint via the standard rebuild-and-copy: recreate the table with the
-- narrowed CHECK, copy existing rows, then swap it in.
CREATE TABLE service_links_new (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id     TEXT NOT NULL REFERENCES discord_users(discord_id),
  service             TEXT NOT NULL CHECK (service IN ('youtube')),
  access_token_enc    BLOB NOT NULL,
  refresh_token_enc   BLOB,
  key_id              TEXT NOT NULL,
  scope               TEXT,
  token_expires_at    INTEGER,
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','needs_relink')),
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (discord_user_id, service)
);

-- A database that was ever live before the Spotify removal can still hold a
-- 'spotify' row here; the backend has had no code path that reads/refreshes
-- it since removal, so it's already dead data. Purge it first — copying it
-- unfiltered into service_links_new would violate the narrowed CHECK above
-- and abort this migration on exactly the databases it's meant to clean up.
DELETE FROM service_links WHERE service <> 'youtube';

INSERT INTO service_links_new
  SELECT id, discord_user_id, service, access_token_enc, refresh_token_enc,
         key_id, scope, token_expires_at, status, created_at, updated_at
  FROM service_links;

DROP TABLE service_links;
ALTER TABLE service_links_new RENAME TO service_links;
