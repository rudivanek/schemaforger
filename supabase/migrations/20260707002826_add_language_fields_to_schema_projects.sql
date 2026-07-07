-- Add multilingual fields to schema_projects
ALTER TABLE schema_projects
  ADD COLUMN IF NOT EXISTS language_code text,
  ADD COLUMN IF NOT EXISTS language_pair_id uuid REFERENCES schema_projects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS schema_projects_language_pair_id_idx ON schema_projects (language_pair_id);
