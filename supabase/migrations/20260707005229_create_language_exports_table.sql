/*
# Create language_exports table

## Purpose
Provides lightweight persistence for the standalone multi-language JSON-LD generation flow
on the Idiomas page (/client/:id/languages). Saves the operator's in-progress session so
it can be restored on page reload — no dependency on schema_projects.

## New Tables
- `language_exports`
  - `id` (uuid, primary key)
  - `client_id` (uuid, FK → clients.id ON DELETE CASCADE)
  - `source_url` (text) — the URL the operator scanned as the starting point
  - `vertical` (text) — the vertical/template chosen for generation
  - `languages` (jsonb) — array of {lang, url, generated_jsonld, uploaded_url, checked}
  - `created_at` (timestamptz)
  - `updated_at` (timestamptz) — bumped on every save so we always load the most recent

## Constraints
- Unique index on `client_id` — one active export session per client at a time.
  Upserts with onConflict: 'client_id' update the existing row so sessions are restored on reload.

## Security
- RLS enabled.
- Single-operator app (has sign-in screen) → policies scoped TO authenticated.
*/

CREATE TABLE IF NOT EXISTS language_exports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_url  text NOT NULL,
  vertical    text,
  languages   jsonb NOT NULL DEFAULT '[]',
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS language_exports_client_id_idx ON language_exports (client_id);

ALTER TABLE language_exports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_language_exports" ON language_exports;
CREATE POLICY "select_language_exports" ON language_exports FOR SELECT
  TO authenticated USING (true);

DROP POLICY IF EXISTS "insert_language_exports" ON language_exports;
CREATE POLICY "insert_language_exports" ON language_exports FOR INSERT
  TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "update_language_exports" ON language_exports;
CREATE POLICY "update_language_exports" ON language_exports FOR UPDATE
  TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "delete_language_exports" ON language_exports;
CREATE POLICY "delete_language_exports" ON language_exports FOR DELETE
  TO authenticated USING (true);
