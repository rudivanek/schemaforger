# PimpMyCopy — Features Documentation

**Version:** 1.0.0
**Last Updated:** 2026-07-06T18:00:00Z
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

### 4a. robots.txt Qualitative Checklist

After the blocked-crawlers check, `geo-audit` now runs `analyzeRobotsTxt()` and returns a `robots_checklist` object:

| Field | Type | Description |
|---|---|---|
| `has_sitemap` | boolean | Whether a `Sitemap:` directive is present |
| `sitemap_url` | string \| null | The sitemap URL if found |
| `unusual_disallows` | string[] | Disallow paths that are NOT admin/system (not matching `/wp-admin/`, `/cgi-bin/`, `.php`, etc.) — flagged for manual review |
| `high_crawl_delay` | `{agent, delay}[]` | Any `Crawl-delay` > 5s per user-agent group |

The UI shows a **"Cómo está ahora / Cómo debería estar"** checklist panel inside the robots.txt card:
- ✓/✗ `Incluye directiva Sitemap` (shows URL if found)
- Amber badge list of unusual Disallow paths (advisory, not auto-flagged as wrong)
- Per-agent amber warning for high Crawl-delay values

### 4b. llms.txt Content Checklist

`geo-audit` runs `analyzeLlmsTxt()` on either `llms_txt_raw` (if file exists) or `generated_llms_txt` (draft) and returns `llms_checklist`:

| Field | Type | Heuristic |
|---|---|---|
| `has_business_info` | boolean | Top-level `# Heading` AND a `> blockquote` in first 10 lines |
| `priority_page_count` | number | Count of markdown links under a `## Páginas / pages / priority` heading, or lines starting `Priority:` |
| `has_contact` | boolean | Email pattern, phone-like digit sequence, or "contacto"/"contact" keyword |
| `has_services` | boolean | `## Servicios/Services` heading followed by at least one `- ` list item |

The UI shows a **"Cómo está ahora / Cómo debería estar"** checklist panel inside the llms.txt card with four ✓/✗ rows.

### 4c. New Tier 1 Recommendations (from checklists)

`buildRecommendations()` now generates additional Tier 1 entries from the checklist data:

- **Missing Sitemap directive** → "Agrega una línea 'Sitemap: [url]' a tu robots.txt…"
- **Unusual Disallow paths** → "Revisa las rutas bloqueadas en robots.txt: [paths]…" (advisory tone)
- **< 3 priority pages in llms.txt** → "Tu llms.txt tiene solo N página(s) prioritaria(s)…"
- **No contact info in llms.txt** → "Agrega información de contacto (teléfono, email) a tu llms.txt…"
- **No services section in llms.txt** → "Agrega una lista de tus servicios principales…"

### 4d. Storage

`robots_checklist` and `llms_checklist` are saved as JSONB columns on `geo_audits` when the operator clicks "Guardar auditoría". They are reloaded on page open alongside existing audit fields so the checklist panels remain visible between sessions.

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

## 9. Edge Function Contracts

- **`scrape-site`**: `{ url }` → `{ scraped: { page_url, title, meta_description, og_site_name, og_image, h1, phone, email, address_hint, hours_hint, same_as, existing_jsonld, existing_schema_types, visible_text_sample, script_signals, opportunities } }`. Internally calls Firecrawl `/v1/scrape` (formats: html, markdown) with a 30-second AbortController timeout. Falls back to a plain `fetch` if Firecrawl is not configured. Runs the full detector registry and returns `opportunities` array (see §11).
- **`generate-schema`**: `{ scraped, template, extra_info?, main_entity?, included_opportunities? }` → `{ jsonld }` (may include `_operator_notes` string). If `included_opportunities` is provided, deterministic schema nodes for each opportunity type are appended to `@graph` AFTER the Claude-generated base schema.
- **`discover-site-pages`**: `{ site_url }` → `{ pages: string[], source: "firecrawl_map" | "sitemap", total_found: number, truncated: boolean }`. Calls Firecrawl `/v1/map`; falls back to parsing `sitemap.xml`. Caps at 200 URLs. Used by the Full-Site Discovery section (§13).
- **`geo-audit`**: `{ site_url, business_data? }` → `{ robots_txt_found, robots_txt_raw, blocked_ai_crawlers, llms_txt_found, llms_txt_raw, generated_llms_txt, verdict }`

---

## 10. Firecrawl Integration

The `scrape-site` edge function uses [Firecrawl](https://firecrawl.dev) instead of raw `fetch` + HTML parsing to obtain fully-rendered page content.

- **Endpoint**: `POST https://api.firecrawl.dev/v1/scrape`
- **Formats requested**: `["html", "markdown"]`
- **Timeout**: 30 seconds via `AbortController`
- **Markdown usage**: stored as `visible_text_sample` — provides clean, rendered text for AI prompts
- **HTML usage**: parsed with deno_dom to extract phone, email, address, hours, social links, existing JSON-LD, and detector signals
- **Script tag signals**: `class` and `id` attributes are captured alongside `src` for richer detection heuristics
- **API key**: stored as `FIRECRAWL_API_KEY` edge function secret; if absent the function falls back to plain `fetch`

A hint below the Escanear button in Step 1 reads: *"El escaneo puede tardar unos segundos — la página se renderiza por completo antes de extraer datos."*

---

## 11. Opportunity Detector Framework

The `scrape-site` edge function runs an extensible **detector registry** against every scraped page. Detectors identify structured-data opportunities that may exist on the page but are not yet marked up.

### Detector Registry

Six built-in detectors, each returning an `OpportunityResult`:

```typescript
interface OpportunityResult {
  detector_id: string;       // machine key
  label_es: string;          // Spanish display label
  status: "detected" | "not_detected";
  actionable: boolean;       // true = can generate schema node
  extracted_data: unknown;   // structured payload for node builder
  suggestion_es: string;     // operator-facing advice
}
```

| `detector_id`       | Detects | ALWAYS_ADVISE | Schema type generated |
|---------------------|---------|---------------|-----------------------|
| `breadcrumb`        | `breadcrumb` class/aria-label, `BreadcrumbList` | Yes | `BreadcrumbList` |
| `faq`               | `<details>/<summary>`, `.faq`, `.accordion` | Yes | `FAQPage` + `Question/Answer` |
| `video`             | YouTube/Vimeo/Wistia iframes, `<video>` | No | `VideoObject` |
| `reviews_unmarked`  | Testimonial/review HTML patterns; skips if already marked up | No | `Review[]` |
| `howto`             | "Paso N / Step N" headings, process `<ol>` lists | No | `HowTo` |
| `jobposting`        | Career/vacancy keyword + job-class containers | No | `JobPosting[]` |

**ALWAYS_ADVISE rule**: `breadcrumb` and `faq` are always included in the opportunities list (even when `not_detected`) so the operator sees an advisory suggestion. All other detectors are silent when not detected.

### Step 1 UI — Oportunidades detectadas panel

Displayed in ProjectWorkspace after scanning a page. Three rendering modes per opportunity:

1. **`not_detected` (breadcrumb/faq only)** — amber advisory card with suggestion text; no checkbox
2. **`detected && actionable`** — blue card with checkbox (default: checked), expandable preview of extracted data, suggestion text
3. **`detected && !actionable`** — blue info card (no checkbox); signals the opportunity exists but data is insufficient to generate a node

### Schema Node Generation

When "Generar con IA" is clicked, the workspace passes `included_opportunities` (only checked + actionable opportunities) to `generate-schema`. The edge function builds deterministic schema nodes from `extracted_data` WITHOUT involving Claude:

- **`breadcrumb`** → `BreadcrumbList` with `ListItem[]` from extracted trail
- **`faq`** → `FAQPage` with `Question/Answer` pairs; cross-linked to main entity via `about`
- **`video`** → `VideoObject` with `embedUrl`; cross-linked via `publisher`
- **`reviews_unmarked`** → individual `Review` nodes; `reviewRating` only if explicit numeric rating present; **no fabricated `AggregateRating`**; cross-linked via `itemReviewed`
- **`howto`** → `HowTo` with `HowToStep[]`; cross-linked via `provider`
- **`jobposting`** → `JobPosting[]`; cross-linked via `hiringOrganization`

All nodes receive `@id` values following the pattern `{pageUrl}#{slug}` and are appended to `@graph`.

---

## 12. Untracked Live Nodes — "Adoptar versión en vivo"

In `ClientGraphPage` (`/client/:id`), the **Verificar en vivo** feature now detects Schema.org nodes present in the live page scrape but absent from any project in the DB.

### Detection Logic

After scraping the live page, the system builds `allKnownIds` from ALL projects for this client (any status: draft, validated, delivered). A live node is **untracked** if:

- Its `@type` + `@id` combination matches a known project's node but the content differs → **MODIFIED**
- Its `@id` does not appear in any known project → **UNKNOWN**

### UI

- An amber "Nodos no rastreados en vivo" subsection appears below the live-check results
- Each untracked node card shows: `@type`, `@id`, a content summary
- **MODIFIED nodes**: "Adoptar versión en vivo" button opens a confirmation modal explaining the replacement; on confirm, the project's `generated_jsonld` is updated with the live node, status is reset to `draft`, and an operator note is appended to `raw_scraped_data._operator_notes`
- **UNKNOWN nodes**: same button opens a modal with a project selector (all client projects listed); on confirm, the node is appended to the chosen project's `generated_jsonld`, status reset to `draft`, note appended

### Data Safety

- Adoption writes only to `generated_jsonld` and `raw_scraped_data` JSONB fields — no structural DB changes
- Operator notes are stored as an array inside `raw_scraped_data._operator_notes` using the underscore-prefix meta-data convention
- The "All match" banner only shows when `overallStatus === 'match' && untrackedNodes.length === 0`

---

## 13. Full-Site Discovery Scan

Section 4 of `ClientGraphPage` — allows the operator to discover and audit all pages on a client's domain for Schema.org coverage gaps.

### Discovery Flow

1. Click **Descubrir páginas** → calls `discover-site-pages` edge function with the client's website URL
2. Results shown as a scrollable checkbox list (capped at 200); discovery source (Firecrawl map or sitemap) and total count displayed
3. Operator selects pages to scan → **Escanear seleccionadas** scrapes each page via `scrape-site` and cross-checks `@id` values against all known project nodes

### Manual URL Path

An alternative textarea accepts up to 20 URLs (one per line). Off-domain URLs trigger an inline warning. **Escanear URLs manuales** runs the same scrape + cross-check pipeline.

### Shared Results

Each scanned page produces one of three result cards:

| Status | Label | Color | Meaning |
|--------|-------|-------|---------|
| `no_overlap` | Sin schema / Sin coincidencia | Neutral | Page has no JSON-LD or `@id` values not seen in any project |
| `match` | Rastreado | Green | All `@id` values from live page exist in a project |
| `conflict` | Conflicto | Red | Live page has `@id` values that conflict with or are absent from projects |

**Crear proyecto** quick-action button appears on `conflict` cards, pre-populating the new project's URL field and navigating to the workspace.
