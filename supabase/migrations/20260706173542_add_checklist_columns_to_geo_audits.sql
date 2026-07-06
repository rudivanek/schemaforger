alter table geo_audits
  add column if not exists robots_checklist jsonb,
  add column if not exists llms_checklist jsonb;
