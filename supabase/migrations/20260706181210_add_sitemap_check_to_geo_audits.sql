alter table geo_audits
  add column if not exists sitemap_check jsonb;