/*
# SchemaForge Initial Schema

## Summary
Creates all tables, RLS policies, and seeds template data for SchemaForge —
a JSON-LD structured-data generator and AI-visibility (GEO) auditor for a design/SEO studio.

## New Tables

1. `clients` — stores client name, website URL, and vertical category
2. `schema_projects` — per-client schema generation projects with scraped data,
   generated JSON-LD, and status lifecycle (draft → validated → delivered)
3. `schema_templates` — vetted per-vertical type combos that drive generation
4. `validation_log` — per-project validation run results with error details
5. `geo_audits` — AI-visibility audit results per client (robots.txt, llms.txt)

## Security
- RLS enabled on all tables.
- Single authenticated user (internal tool): policies grant full access to `authenticated` role.
- `USING (true) WITH CHECK (true)` is appropriate here — this is a single-operator internal tool.

## Notes
- schema_templates seeded with 7 validated vertical rows.
- updated_at trigger applied to schema_projects.
- All policies use FOR ALL with (true) predicates — correct for a single-operator tool.
*/

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  website_url text not null,
  vertical text not null,
  created_at timestamptz default now()
);

create table if not exists schema_projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  page_url text not null,
  business_type text,
  schema_types text[] not null default '{}',
  raw_scraped_data jsonb,
  generated_jsonld jsonb,
  status text not null default 'draft' check (status in ('draft','validated','delivered')),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists schema_templates (
  id uuid primary key default gen_random_uuid(),
  vertical text not null unique,
  label_es text not null,
  schema_type_combo text[] not null,
  required_fields jsonb not null,
  recommended_fields jsonb not null default '{}',
  prompt_notes text
);

create table if not exists validation_log (
  id uuid primary key default gen_random_uuid(),
  schema_project_id uuid references schema_projects(id) on delete cascade,
  is_valid boolean not null,
  errors jsonb not null default '[]',
  checked_at timestamptz default now()
);

create table if not exists geo_audits (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references clients(id) on delete cascade,
  robots_txt_found boolean,
  blocked_ai_crawlers text[] default '{}',
  llms_txt_found boolean,
  generated_llms_txt text,
  notes text,
  created_at timestamptz default now()
);

-- RLS
alter table clients enable row level security;
alter table schema_projects enable row level security;
alter table schema_templates enable row level security;
alter table validation_log enable row level security;
alter table geo_audits enable row level security;

drop policy if exists "authenticated full access clients" on clients;
create policy "authenticated full access clients" on clients for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access projects" on schema_projects;
create policy "authenticated full access projects" on schema_projects for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access templates" on schema_templates;
create policy "authenticated full access templates" on schema_templates for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access validation" on validation_log;
create policy "authenticated full access validation" on validation_log for all to authenticated using (true) with check (true);

drop policy if exists "authenticated full access geo" on geo_audits;
create policy "authenticated full access geo" on geo_audits for all to authenticated using (true) with check (true);

-- Seed templates (upsert so migration is idempotent)
insert into schema_templates (vertical, label_es, schema_type_combo, required_fields, recommended_fields, prompt_notes) values

('medical', 'Clínica / Consultorio Médico',
 array['MedicalBusiness','Physician','AggregateRating'],
 '{"MedicalBusiness":["name","address","telephone","url"],"Physician":["name","medicalSpecialty"],"AggregateRating":["ratingValue","reviewCount"]}',
 '{"MedicalBusiness":["openingHoursSpecification","image","priceRange","geo","hasMap","sameAs"],"Physician":["worksFor","image","alumniOf"],"AggregateRating":["bestRating"]}',
 'Nest Physician inside MedicalBusiness via employee or use @graph. AggregateRating attaches to MedicalBusiness, never to Physician unless reviews are doctor-specific. Only include ratings actually visible on the page.'),

('legal', 'Despacho Legal / Abogados',
 array['LegalService','Attorney'],
 '{"LegalService":["name","address","telephone","url"],"Attorney":["name"]}',
 '{"LegalService":["areaServed","openingHoursSpecification","priceRange","sameAs"],"Attorney":["jobTitle","knowsAbout","alumniOf"]}',
 'Use @graph linking Attorney to LegalService via memberOf/employee. knowsAbout should list practice areas as plain strings.'),

('restaurant', 'Restaurante / Café',
 array['Restaurant','Menu'],
 '{"Restaurant":["name","address","telephone","servesCuisine"],"Menu":["name"]}',
 '{"Restaurant":["openingHoursSpecification","priceRange","acceptsReservations","image","geo","aggregateRating","hasMenu"],"Menu":["hasMenuSection","url"]}',
 'Link Menu via hasMenu. Only include aggregateRating if ratings are visible on the page. servesCuisine as array of strings.'),

('realestate', 'Inmobiliaria',
 array['RealEstateAgent'],
 '{"RealEstateAgent":["name","address","telephone","url"]}',
 '{"RealEstateAgent":["areaServed","openingHoursSpecification","image","sameAs","aggregateRating"]}',
 'For individual listings use RealEstateListing per property page, not on the agency homepage.'),

('local', 'Negocio Local / Retail',
 array['LocalBusiness'],
 '{"LocalBusiness":["name","address","telephone"]}',
 '{"LocalBusiness":["openingHoursSpecification","priceRange","image","geo","hasMap","sameAs","aggregateRating","url"]}',
 'Prefer the most specific subtype when obvious (HairSalon, AutoRepair, Dentist...) — set business_type to the subtype but keep required fields from LocalBusiness.'),

('ecommerce', 'Tienda en Línea',
 array['Product','Offer','AggregateRating'],
 '{"Product":["name","image"],"Offer":["price","priceCurrency","availability"],"AggregateRating":["ratingValue","reviewCount"]}',
 '{"Product":["description","brand","sku","gtin"],"Offer":["url","priceValidUntil","itemCondition"],"AggregateRating":["bestRating"]}',
 'Product schema goes on individual product pages, never the homepage — for the store homepage use Organization or OnlineStore. Offer nests inside Product via offers. Omit AggregateRating entirely if no visible reviews.'),

('services', 'Servicios Profesionales',
 array['ProfessionalService','Service'],
 '{"ProfessionalService":["name","address","telephone"],"Service":["name","provider"]}',
 '{"ProfessionalService":["url","openingHoursSpecification","sameAs","areaServed"],"Service":["description","serviceType","areaServed","offers"]}',
 'One Service node per distinct service offered, all pointing provider back to the ProfessionalService node via @id references.')

on conflict (vertical) do update set
  label_es = excluded.label_es,
  schema_type_combo = excluded.schema_type_combo,
  required_fields = excluded.required_fields,
  recommended_fields = excluded.recommended_fields,
  prompt_notes = excluded.prompt_notes;

-- updated_at trigger
create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists schema_projects_updated_at on schema_projects;
create trigger schema_projects_updated_at before update on schema_projects
for each row execute function set_updated_at();
