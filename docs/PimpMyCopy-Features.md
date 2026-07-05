# PimpMyCopy — Features Documentation

**Version:** 1.0.0
**Last Updated:** 2026-07-05T00:00:00Z
**Project:** SchemaForge — JSON-LD + GEO Auditor (Sharpen.Studio)

---

## 1. Authentication

**Single-operator email/password login** via Supabase Auth. No public signup — access is granted by the operator manually via the Supabase dashboard. Session is persisted across reloads. Protected routes redirect unauthenticated users to `/login`. Sign-out is available in the app header.

---

## 2. Dashboard — Client List (`/`)

The root view shows all clients in a card list with:
- Client name, website URL, vertical badge, project count
- Last GEO audit verdict (number of blocked AI crawlers, or "Sin bloqueos detectados")
- Search bar filtering by name or URL
- Quick-action links to start a new project or open GEO audit per client
- **Nuevo cliente** modal — collects name, website URL, vertical (dropdown from 7 supported verticals)

Verticals supported: medical, legal, restaurant, realestate, local, ecommerce, services.

---

## 3. Project Workspace — 3-Step Wizard (`/client/:id/project/:projectId`)

The core generation screen. Project state (status: `draft` → `validated` → `delivered`) is persisted to `schema_projects` on every step.

### Step 1 — Escanear
- URL input pre-filled with client website
- Calls `scrape-site` edge function → returns extracted data: title, H1, phone, email, address hint, hours hint, social links, existing JSON-LD
- Warning banner if existing schema detected on page: "Esta página ya tiene schema"
- "Notas del operador" textarea for corrections/additions

### Step 2 — Generar
- Shows the vertical's schema type combo from `schema_templates`
- "Generar con IA" button calls `generate-schema` edge function with scraped data + template + operator notes
- Dual synchronized panel view:
  - **Editable form view**: fields grouped by schema type, missing required fields highlighted in red with "requerido" label — no placeholder fill for empty required fields
  - **Live JSON preview**: read-only, syntax-highlighted, `_operator_notes` stripped from display
- Amber alert banner if model returned `_operator_notes`

### Step 3 — Validar y exportar
- Local `validateJsonLd()` checks: errors in red, warnings in amber
- Button to open Google Rich Results Test in a new tab
- Export panel: copy-to-clipboard `<script type="application/ld+json">` block (via `toScriptTag()`, which strips `_operator_notes`)
- Collapsible **Instrucciones WordPress** section: WPCode plugin method + manual `header.php` method
- "Marcar como entregado" sets status to `delivered`

---

## 4. GEO Audit (`/client/:id/geo`)

Audits a client site for AI-crawler visibility:
- Calls `geo-audit` edge function with site URL + latest schema project business data
- **robots.txt card**: found/not found status, list of blocked AI crawlers as red badges (GPTBot, ClaudeBot, PerplexityBot, etc.), collapsible raw file viewer
- **llms.txt card**: exists (show content) or missing → editable draft textarea with copy button
- Plain-language **verdict** banner at top
- "Guardar auditoría" persists result to `geo_audits`
- Loads previous audit on page open if one exists

---

## 5. Templates (`/templates`)

Read/edit view of the `schema_templates` table — the vetted per-vertical type combos that drive schema generation. Displays:
- Vertical label (Spanish), internal key, schema type combo chips
- Required fields summary
- `prompt_notes` field — editable inline, with a caution banner explaining it affects AI generation behavior

Editing `prompt_notes` updates the Supabase row immediately.

---

## 6. Validation Library (`src/lib/validation.ts`)

- `validateJsonLd(jsonld)` — runs local checks for `@type`, `@context`, type-specific required fields, and common warnings (missing image, missing hours, invalid ratingValue range). Returns `{ valid, errors, warnings, richResultsTestUrl }`.
- `toScriptTag(jsonld)` — wraps JSON-LD in a `<script>` tag. Strips `_operator_notes` before export — this field NEVER appears in exported code.

---

## 7. Design System

- **Color palette**: `#EDEBE6` background (proof), `#1A1B1E` ink, `#E8500A` orange (actions/errors), `#2B5C8A` blue (links/validated), `#D6D3CC` hairline borders
- **Typography**: IBM Plex Sans for UI, IBM Plex Mono for all data/code (URLs, JSON, robots.txt, phone numbers)
- **Chips**: uppercase mono labels — DRAFT / VALIDATED / DELIVERED
- No gradients, no glassmorphism, 2px border radius
- Keyboard focus visible everywhere; respects `prefers-reduced-motion`
- Spanish UI labels throughout; code/comments in English

---

## 8. Database Schema

Tables: `clients`, `schema_projects`, `schema_templates`, `validation_log`, `geo_audits`.
RLS enabled on all tables. Single authenticated user — policies grant full access via `USING (true)` to the `authenticated` role (appropriate for single-operator internal tool).

`schema_templates` seeded with 7 validated vertical rows (medical, legal, restaurant, realestate, local, ecommerce, services).

---

## 9. Edge Function Contracts (Placeholders — implementations provided separately)

- **`scrape-site`**: `{ url }` → `{ scraped: { page_url, title, meta_description, og_site_name, og_image, h1, phone, email, address_hint, hours_hint, same_as, existing_jsonld, visible_text_sample } }`
- **`generate-schema`**: `{ scraped, template, extra_info? }` → `{ jsonld }` (may include `_operator_notes` string)
- **`geo-audit`**: `{ site_url, business_data? }` → `{ robots_txt_found, robots_txt_raw, blocked_ai_crawlers, llms_txt_found, llms_txt_raw, generated_llms_txt, verdict }`
