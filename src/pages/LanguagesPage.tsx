import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Languages, Scan, Sparkles, Download,
  Copy, Check, Plus, Trash2, Info, AlertTriangle, ChevronDown, ChevronUp,
  Bug,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { validateJsonLd } from '../lib/validation';
import type { ValidationIssue } from '../lib/validation';
import type { Client, SchemaTemplate } from '../lib/database.types';

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpportunityResult {
  detector_id: string;
  status: 'detected' | 'not_detected';
  actionable: boolean;
  extracted_data: unknown;
}

interface ScrapedData {
  page_url?: string;
  title?: string;
  h1?: string;
  og_site_name?: string;
  visible_text_sample?: string;
  detected_language?: string;
  language_alternates?: Array<{ lang: string; url: string }>;
  opportunities?: OpportunityResult[];
  [key: string]: unknown;
}

interface LanguageRow {
  id: string;
  lang: string;
  url: string;
  isOriginal: boolean;
  checked: boolean;
  scrapedData: ScrapedData | null;
  jsonld: unknown | null;
  validationIssues: ValidationIssue[];
  generating: boolean;
  error: string | null;
  uploadedUrl: string;
  jsonExpanded: boolean;
}

type Phase = 'idle' | 'scanning' | 'selected' | 'generating' | 'generated';

// ── Constants ─────────────────────────────────────────────────────────────────

const VERTICALS = [
  { value: 'medical',    label: 'Clínica / Consultorio Médico' },
  { value: 'legal',      label: 'Despacho Legal / Abogados' },
  { value: 'restaurant', label: 'Restaurante / Café' },
  { value: 'realestate', label: 'Inmobiliaria' },
  { value: 'local',      label: 'Negocio Local / Retail' },
  { value: 'ecommerce',  label: 'Tienda en Línea' },
  { value: 'services',   label: 'Servicios Profesionales' },
];

const COMMON_LANGS = [
  'en', 'es', 'fr', 'de', 'pt', 'it', 'ja', 'zh', 'ar', 'nl', 'ko', 'ru',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function urlPath(u: string): string {
  try { const { pathname, search } = new URL(u); return (pathname || '/') + search; }
  catch { return u; }
}

function pageSlugFromUrl(u: string): string {
  try {
    const x = new URL(u);
    const host = x.hostname.replace(/^www\./, '').replace(/\./g, '-');
    const path = x.pathname.replace(/\//g, '-').replace(/^-|-$/g, '');
    return path ? `${host}-${path}` : host;
  } catch { return 'schema'; }
}

function stripInternalKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(stripInternalKeys);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, stripInternalKeys(v)]),
    );
  }
  return obj;
}

function downloadJson(jsonld: unknown, lang: string, sourceUrl: string) {
  const data = stripInternalKeys(jsonld);
  const slug = pageSlugFromUrl(sourceUrl);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}-${lang.toLowerCase()}-complete.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function generateWidgetScript(
  rows: LanguageRow[],
  sourceUrl: string,
): string {
  const ready = rows.filter(r => r.checked && r.uploadedUrl.trim());
  const slug = pageSlugFromUrl(sourceUrl);
  const defaultLang = ready[0]?.lang ?? 'en';
  const entries = ready
    .map(r => `        ${r.lang}: "${r.uploadedUrl.trim()}"`)
    .join(',\n');

  return `<script>
document.addEventListener("DOMContentLoaded", function () {
    const SCHEMA_URLS = {
${entries}
    };
    const SCRIPT_ID = "schema-script-${slug}";
    function injectSchema(data) {
        let script = document.getElementById(SCRIPT_ID);
        if (!script) {
            script = document.createElement("script");
            script.type = "application/ld+json";
            script.id = SCRIPT_ID;
            document.head.appendChild(script);
        }
        script.textContent = JSON.stringify(data);
    }
    function loadSchema(language) {
        const lang = language.toLowerCase().slice(0, 2);
        const url = SCHEMA_URLS[lang] || Object.values(SCHEMA_URLS)[0];
        fetch(url + "?v=" + Date.now(), { cache: "no-store" })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error("Could not load JSON-LD: " + response.status);
                }
                return response.json();
            })
            .then(injectSchema)
            .catch(function (error) {
                console.error("Schema JSON-LD error:", error);
            });
    }
    loadSchema(document.documentElement.lang || "${defaultLang}");
    if (window.Weglot && typeof Weglot.on === "function") {
        Weglot.on("languageChanged", function (newLanguage) {
            loadSchema(newLanguage);
        });
    }
});
</script>`;
}

function newRow(lang: string, url: string, isOriginal: boolean, scraped: ScrapedData | null): LanguageRow {
  return {
    id: crypto.randomUUID(),
    lang,
    url,
    isOriginal,
    checked: true,
    scrapedData: scraped,
    jsonld: null,
    validationIssues: [],
    generating: false,
    error: null,
    uploadedUrl: '',
    jsonExpanded: false,
  };
}

// ── Debug markdown export ─────────────────────────────────────────────────────

function buildDebugMarkdown(
  client: Client | null,
  sourceUrl: string,
  vertical: string,
  rows: LanguageRow[],
  script: string | null,
): string {
  const lines: string[] = [];

  lines.push('# SchemaForge — Idiomas Debug Export');
  lines.push('');
  lines.push(`**Cliente:** ${client?.name ?? '(desconocido)'}`);
  lines.push(`**URL fuente:** ${sourceUrl}`);
  lines.push(`**Vertical:** ${vertical || '(no seleccionado)'}`);
  lines.push(`**Fecha:** ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## Idiomas detectados');
  lines.push('');
  for (const row of rows) {
    const label = row.isOriginal ? '— URL original' : '— alternativa detectada';
    lines.push(`- **${row.lang}**: ${row.url} ${label}`);
  }
  lines.push('');

  lines.push('## Resultados de generación');
  lines.push('');
  const generatedRows = rows.filter(r => r.checked && r.jsonld !== null);
  for (const row of generatedRows) {
    lines.push(`### ${row.lang} — ${row.url}`);
    lines.push('');
    const errors = row.validationIssues.filter(i => i.severity === 'error');
    const warnings = row.validationIssues.filter(i => i.severity === 'warning');
    if (errors.length === 0 && warnings.length === 0) {
      lines.push('**Validación:** Schema válido');
    } else {
      lines.push(`**Validación:** ${errors.length} error${errors.length !== 1 ? 'es' : ''}, ${warnings.length} advertencia${warnings.length !== 1 ? 's' : ''}`);
    }
    lines.push('');
    if (errors.length > 0) {
      lines.push('Errores:');
      for (const e of errors) lines.push(`- ${e.node}: ${e.message}`);
      lines.push('');
    }
    if (warnings.length > 0) {
      lines.push('Advertencias:');
      for (const w of warnings) lines.push(`- ${w.node}: ${w.message}`);
      lines.push('');
    }
    lines.push('```json');
    lines.push(JSON.stringify(row.jsonld, null, 2));
    lines.push('```');
    lines.push('');
  }

  lines.push('## URLs subidas (Paso 4)');
  lines.push('');
  for (const row of generatedRows) {
    const uploaded = row.uploadedUrl.trim() || '— no subido aún —';
    lines.push(`**${row.lang}:** ${uploaded}`);
  }
  lines.push('');

  lines.push('## Script Weglot generado (Paso 5)');
  lines.push('');
  if (script) {
    lines.push('```html');
    lines.push(script);
    lines.push('```');
  } else {
    lines.push('— aún no generado, faltan URLs —');
  }

  return lines.join('\n');
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LanguagesPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');

  // Step 1
  const [sourceUrl, setSourceUrl] = useState('');

  // Step 2
  const [rows, setRows] = useState<LanguageRow[]>([]);
  const [vertical, setVertical] = useState('');
  const [template, setTemplate] = useState<SchemaTemplate | null>(null);
  const [templateLoading, setTemplateLoading] = useState(false);
  const [customLang, setCustomLang] = useState('');
  const [customUrl, setCustomUrl] = useState('');

  // Widget copy
  const [copied, setCopied] = useState(false);
  // Debug export copy
  const [debugToast, setDebugToast] = useState(false);

  const loadClient = async () => {
    if (!clientId) return;
    const { data: c } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (c) {
      setClient(c);
      setSourceUrl(c.website_url);
      setVertical(c.vertical);
    }
    // Check for saved export
    const { data: saved } = await supabase
      .from('language_exports')
      .select('*')
      .eq('client_id', clientId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (saved && Array.isArray(saved.languages) && saved.languages.length > 0) {
      setSourceUrl(saved.source_url);
      setVertical(saved.vertical ?? c?.vertical ?? '');
      const restored = (saved.languages as Array<{
        lang: string; url: string; generated_jsonld: unknown | null; uploaded_url: string | null; checked: boolean;
      }>).map(l => {
        const issues = l.generated_jsonld
          ? validateJsonLd(l.generated_jsonld as { '@type'?: string | string[]; [key: string]: unknown })
          : [];
        return {
          id: crypto.randomUUID(),
          lang: l.lang,
          url: l.url,
          isOriginal: l.url === saved.source_url,
          checked: l.checked ?? true,
          scrapedData: null,
          jsonld: l.generated_jsonld ?? null,
          validationIssues: issues,
          generating: false,
          error: null,
          uploadedUrl: l.uploaded_url ?? '',
          jsonExpanded: false,
        } satisfies LanguageRow;
      });
      setRows(restored);
      setPhase('generated');
    }
  };

  useEffect(() => { loadClient(); }, [clientId]);

  const loadTemplate = async (v: string) => {
    if (!v) return;
    setTemplateLoading(true);
    const { data } = await supabase
      .from('schema_templates')
      .select('*')
      .eq('vertical', v)
      .limit(1)
      .maybeSingle();
    setTemplate(data ?? null);
    setTemplateLoading(false);
  };

  useEffect(() => { if (vertical) loadTemplate(vertical); }, [vertical]);

  const saveToDb = async (currentRows: LanguageRow[], currentSrc: string, currentVertical: string) => {
    if (!clientId) return;
    const languages = currentRows.map(r => ({
      lang: r.lang,
      url: r.url,
      generated_jsonld: r.jsonld,
      uploaded_url: r.uploadedUrl || null,
      checked: r.checked,
    }));
    await supabase.from('language_exports').upsert(
      {
        client_id: clientId,
        source_url: currentSrc,
        vertical: currentVertical,
        languages,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id' },
    );
  };

  // ── Step 1: Scan ────────────────────────────────────────────────────────────

  const handleScan = async () => {
    if (!sourceUrl.trim()) return;
    setPhase('scanning');
    setRows([]);
    try {
      const { data, error } = await supabase.functions.invoke('scrape-site', {
        body: { url: sourceUrl.trim() },
      });
      if (error || data?.error) throw new Error(data?.error ?? error?.message ?? 'Scrape failed');
      const scraped: ScrapedData = data.scraped;
      const detectedLang = (scraped.detected_language ?? 'en').split('-')[0].toLowerCase();
      const alts = (scraped.language_alternates ?? []) as Array<{ lang: string; url: string }>;

      const initialRows: LanguageRow[] = [
        newRow(detectedLang, sourceUrl.trim(), true, scraped),
        ...alts.map(a => newRow(a.lang.split('-')[0].toLowerCase(), a.url, false, null)),
      ];
      setRows(initialRows);
      setPhase('selected');
    } catch (e) {
      setPhase('idle');
      alert(`Error al escanear: ${String(e)}`);
    }
  };

  // ── Step 2: Add custom row ──────────────────────────────────────────────────

  const handleAddCustomRow = () => {
    if (!customLang || !customUrl.trim()) return;
    setRows(prev => [...prev, newRow(customLang, customUrl.trim(), false, null)]);
    setCustomLang('');
    setCustomUrl('');
  };

  const toggleRowChecked = (id: string) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, checked: !r.checked } : r));
  };

  const removeRow = (id: string) => {
    setRows(prev => prev.filter(r => r.id !== id));
  };

  const updateRowField = <K extends keyof LanguageRow>(id: string, key: K, value: LanguageRow[K]) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, [key]: value } : r));
  };

  // ── Step 3: Generate ────────────────────────────────────────────────────────

  const handleGenerate = async () => {
    if (!template) return;
    setPhase('generating');

    const checkedRows = rows.filter(r => r.checked);
    const updatedRows = [...rows];

    for (const row of checkedRows) {
      const idx = updatedRows.findIndex(r => r.id === row.id);
      updatedRows[idx] = { ...updatedRows[idx], generating: true, error: null };
      setRows([...updatedRows]);

      try {
        // Scrape if not original (alternates haven't been scraped yet)
        let scraped = row.scrapedData;
        if (!scraped) {
          const { data: sd, error: se } = await supabase.functions.invoke('scrape-site', {
            body: { url: row.url },
          });
          if (se || sd?.error) throw new Error(sd?.error ?? se?.message ?? 'Scrape failed');
          scraped = sd.scraped as ScrapedData;
        }

        // Generate schema
        const { data: gd, error: ge } = await supabase.functions.invoke('generate-schema', {
          body: {
            scraped,
            template: {
              vertical: template.vertical,
              schema_type_combo: template.schema_type_combo,
              required_fields: template.required_fields,
              recommended_fields: template.recommended_fields,
              prompt_notes: template.prompt_notes,
            },
            included_opportunities: (scraped.opportunities ?? [])
              .filter((o: OpportunityResult) => o.status === 'detected' && o.actionable),
          },
        });
        if (ge || gd?.error) throw new Error(gd?.error ?? ge?.message ?? 'Generation failed');

        const jsonld = gd.jsonld;
        const issues = validateJsonLd(jsonld as { '@type'?: string | string[]; [key: string]: unknown });

        updatedRows[idx] = {
          ...updatedRows[idx],
          generating: false,
          scrapedData: scraped,
          jsonld,
          validationIssues: issues,
          error: null,
        };
      } catch (e) {
        updatedRows[idx] = {
          ...updatedRows[idx],
          generating: false,
          error: String(e),
        };
      }
      setRows([...updatedRows]);
    }

    setPhase('generated');
    await saveToDb(updatedRows, sourceUrl, vertical);
  };

  // ── Upload URL change + auto-save ───────────────────────────────────────────

  const handleUploadUrlChange = (id: string, value: string) => {
    const next = rows.map(r => r.id === id ? { ...r, uploadedUrl: value } : r);
    setRows(next);
    // Debounced save omitted for simplicity — save happens when widget renders
  };

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    await saveToDb(rows, sourceUrl, vertical);
  };

  const handleCopyDebug = async () => {
    const markdown = buildDebugMarkdown(client, sourceUrl, vertical, rows, script);
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      // Fallback: insert textarea, select all, execCommand copy
      const ta = document.createElement('textarea');
      ta.value = markdown;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setDebugToast(true);
    setTimeout(() => setDebugToast(false), 2500);
  };

  const handleReset = async () => {
    if (!clientId) return;
    await supabase.from('language_exports').delete().eq('client_id', clientId);
    setRows([]);
    setPhase('idle');
    setSourceUrl(client?.website_url ?? '');
    setVertical(client?.vertical ?? '');
  };

  // ── Derived ─────────────────────────────────────────────────────────────────

  const checkedRows = rows.filter(r => r.checked);
  const generatedRows = rows.filter(r => r.checked && r.jsonld !== null);
  const allGenerated = checkedRows.length > 0 && generatedRows.length === checkedRows.length;
  const allUrlsFilled = allGenerated && checkedRows.every(r => r.uploadedUrl.trim().length > 0);
  const script = allUrlsFilled ? generateWidgetScript(checkedRows, sourceUrl) : null;

  const showStep2 = phase === 'selected' || phase === 'generating' || phase === 'generated';
  const showStep3 = phase === 'generating' || phase === 'generated';
  const showStep4 = allGenerated;
  const showStep5 = allUrlsFilled && !!script;

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs font-mono text-ink-muted">
        <button onClick={() => navigate('/')} className="hover:text-ink flex items-center gap-1">
          <ArrowLeft size={12} />
          Clientes
        </button>
        <span>/</span>
        <button onClick={() => navigate(`/client/${clientId}`)} className="hover:text-ink">
          {client?.name ?? '...'}
        </button>
        <span>/</span>
        <span className="text-ink">Idiomas</span>
      </div>

      {/* Header */}
      <div className="proof-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <Languages size={16} className="text-blue shrink-0" />
              <h1 className="text-base font-semibold text-ink">JSON-LD multi-idioma</h1>
            </div>
            <p className="text-xs font-mono text-ink-muted">
              Genera JSON-LD independiente por idioma y produce el widget Weglot. No requiere proyectos previos.
            </p>
          </div>
          {phase !== 'idle' && (
            <button
              onClick={handleReset}
              className="btn-ghost text-xs py-1 px-2 shrink-0 text-ink-muted"
              title="Reiniciar y borrar sesión guardada"
            >
              Reiniciar
            </button>
          )}
        </div>
      </div>

      {/* ── Step 1: Escanear URL ── */}
      <div className="proof-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-blue text-white text-[10px] font-bold flex items-center justify-center shrink-0">1</span>
          <h2 className="section-title text-ink">Escanear página de inicio</h2>
        </div>
        <p className="text-[11px] font-mono text-ink-muted pl-7">
          Ingresa la URL de la versión principal del sitio. El escáner detectará las versiones de idioma disponibles.
        </p>
        <div className="flex gap-2 pl-7">
          <input
            type="url"
            value={sourceUrl}
            onChange={e => setSourceUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && phase === 'idle' && handleScan()}
            className="input-field flex-1 font-mono text-sm"
            placeholder="https://ejemplo.com"
            disabled={phase !== 'idle'}
          />
          <button
            onClick={handleScan}
            disabled={phase !== 'idle' || !sourceUrl.trim()}
            className="btn-primary flex items-center gap-1.5 text-xs shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Scan size={13} />
            {phase === 'scanning' ? 'Escaneando...' : 'Escanear'}
          </button>
        </div>
        {phase === 'scanning' && (
          <p className="text-[11px] font-mono text-ink-muted pl-7 animate-pulse">
            Analizando la página, detectando etiquetas hreflang...
          </p>
        )}
      </div>

      {/* ── Step 2: Seleccionar idiomas ── */}
      {showStep2 && (
        <div className="proof-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-blue text-white text-[10px] font-bold flex items-center justify-center shrink-0">2</span>
            <h2 className="section-title text-ink">Idiomas a generar</h2>
          </div>
          <p className="text-[11px] font-mono text-ink-muted pl-7">
            Selecciona las versiones para las que se generará JSON-LD. Puedes desmarcar las que no necesites o agregar una URL manualmente.
          </p>

          {/* Language rows */}
          <div className="pl-7 space-y-2">
            {rows.map(row => (
              <div key={row.id} className="flex items-center gap-3 py-2 px-3 border border-rule rounded bg-white">
                <input
                  type="checkbox"
                  checked={row.checked}
                  onChange={() => toggleRowChecked(row.id)}
                  disabled={phase === 'generating' || phase === 'generated'}
                  className="w-3.5 h-3.5 rounded border-rule accent-ink cursor-pointer shrink-0"
                />
                <span className="font-mono text-[11px] font-semibold text-ink uppercase w-8 shrink-0">
                  {row.lang}
                </span>
                <span className="font-mono text-xs text-ink-muted flex-1 truncate">{row.url}</span>
                {row.isOriginal && (
                  <span className="text-[10px] font-mono text-ink-muted shrink-0">
                    (escaneada)
                  </span>
                )}
                {phase === 'idle' || phase === 'selected' ? (
                  <button
                    onClick={() => removeRow(row.id)}
                    className="text-ink-muted hover:text-red transition-colors shrink-0"
                    title="Eliminar fila"
                  >
                    <Trash2 size={12} />
                  </button>
                ) : null}
              </div>
            ))}

            {/* Add custom row */}
            {(phase === 'selected') && (
              <div className="flex items-center gap-2 mt-2">
                <select
                  value={customLang}
                  onChange={e => setCustomLang(e.target.value)}
                  className="input-field py-1 px-2 text-xs font-mono w-20"
                >
                  <option value="">Lang</option>
                  {COMMON_LANGS.map(l => <option key={l} value={l}>{l}</option>)}
                </select>
                <input
                  type="url"
                  value={customUrl}
                  onChange={e => setCustomUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddCustomRow()}
                  placeholder="https://ejemplo.com/es/"
                  className="input-field flex-1 font-mono text-xs py-1"
                />
                <button
                  onClick={handleAddCustomRow}
                  disabled={!customLang || !customUrl.trim()}
                  className="btn-ghost text-xs py-1 px-2.5 flex items-center gap-1 disabled:opacity-40"
                >
                  <Plus size={11} />
                  Agregar
                </button>
              </div>
            )}
          </div>

          {/* Vertical selector */}
          <div className="pl-7 space-y-1.5">
            <label className="field-label">Vertical del negocio</label>
            <select
              value={vertical}
              onChange={e => setVertical(e.target.value)}
              disabled={phase === 'generating' || phase === 'generated'}
              className="input-field w-full max-w-xs"
            >
              <option value="">Seleccionar vertical...</option>
              {VERTICALS.map(v => (
                <option key={v.value} value={v.value}>{v.label}</option>
              ))}
            </select>
            {vertical && !template && !templateLoading && (
              <p className="text-[10px] font-mono text-orange">
                No se encontró plantilla para este vertical.
              </p>
            )}
            {templateLoading && (
              <p className="text-[10px] font-mono text-ink-muted">Cargando plantilla...</p>
            )}
            {template && (
              <p className="text-[10px] font-mono text-ink-muted">
                Plantilla: {template.label_es} · {template.schema_type_combo.join(' + ')}
              </p>
            )}
          </div>

          {/* Generate button */}
          {phase === 'selected' && (
            <div className="pl-7">
              <button
                onClick={handleGenerate}
                disabled={checkedRows.length === 0 || !template}
                className="btn-primary flex items-center gap-1.5 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Sparkles size={13} />
                Generar JSON-LD para los seleccionados ({checkedRows.length})
              </button>
              {!template && vertical && (
                <p className="text-[11px] font-mono text-orange mt-1.5">
                  Selecciona un vertical con plantilla disponible para continuar.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Step 3: Resultados de generación ── */}
      {showStep3 && (
        <div className="proof-card p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 rounded-full bg-blue text-white text-[10px] font-bold flex items-center justify-center shrink-0">3</span>
              <h2 className="section-title text-ink">JSON-LD generado</h2>
            </div>
            {generatedRows.length > 0 && (
              <div className="flex items-center gap-2 shrink-0">
                {debugToast && (
                  <span className="text-[10px] font-mono text-green-700 flex items-center gap-1">
                    <Check size={11} />
                    Copiado al portapapeles
                  </span>
                )}
                <button
                  onClick={handleCopyDebug}
                  className="btn-ghost text-xs py-1 px-2 flex items-center gap-1.5 text-ink-muted"
                  title="Copiar sesión completa como Markdown para diagnóstico"
                >
                  <Bug size={12} />
                  Copiar como Markdown (debug)
                </button>
              </div>
            )}
          </div>

          <div className="pl-7 space-y-3">
            {checkedRows.map(row => (
              <div key={row.id} className="border border-rule rounded overflow-hidden">
                {/* Card header */}
                <div className="flex items-center justify-between gap-3 px-4 py-3 bg-proof border-b border-rule">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold text-ink uppercase">{row.lang}</span>
                    <span className="text-[10px] font-mono text-ink-muted truncate max-w-xs">{urlPath(row.url)}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {row.generating && (
                      <span className="text-[10px] font-mono text-ink-muted animate-pulse">
                        {row.scrapedData ? 'Generando schema...' : 'Escaneando página...'}
                      </span>
                    )}
                    {!row.generating && row.jsonld && (
                      <>
                        {/* Validation summary */}
                        {row.validationIssues.length > 0 ? (
                          <span className="flex items-center gap-1 text-[10px] font-mono text-orange">
                            <AlertTriangle size={10} />
                            {row.validationIssues.filter(i => i.severity === 'error').length} err,{' '}
                            {row.validationIssues.filter(i => i.severity === 'warning').length} warn
                          </span>
                        ) : (
                          <span className="flex items-center gap-1 text-[10px] font-mono text-green-700">
                            <Check size={10} />
                            Sin errores
                          </span>
                        )}
                        <button
                          onClick={() => downloadJson(row.jsonld, row.lang, sourceUrl)}
                          className="btn-ghost text-xs py-1 px-2 flex items-center gap-1"
                        >
                          <Download size={11} />
                          Descargar JSON
                        </button>
                      </>
                    )}
                    {!row.generating && row.error && (
                      <span className="text-[10px] font-mono text-red truncate max-w-xs" title={row.error}>
                        Error — {row.error.slice(0, 60)}
                      </span>
                    )}
                  </div>
                </div>

                {/* JSON preview */}
                {!row.generating && row.jsonld && (
                  <div>
                    <button
                      onClick={() => updateRowField(row.id, 'jsonExpanded', !row.jsonExpanded)}
                      className="w-full flex items-center justify-between px-4 py-2 text-[10px] font-mono text-ink-muted hover:bg-proof transition-colors"
                    >
                      <span>Vista previa JSON</span>
                      {row.jsonExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                    </button>
                    {row.jsonExpanded && (
                      <pre className="px-4 pb-3 text-[10px] font-mono text-ink overflow-x-auto max-h-48 overflow-y-auto bg-white leading-relaxed">
                        {JSON.stringify(stripInternalKeys(row.jsonld), null, 2).slice(0, 2000)}
                        {JSON.stringify(stripInternalKeys(row.jsonld), null, 2).length > 2000 ? '\n... (truncado)' : ''}
                      </pre>
                    )}
                  </div>
                )}

                {/* Generating skeleton */}
                {row.generating && (
                  <div className="px-4 py-3">
                    <div className="h-2 bg-rule rounded animate-pulse mb-1.5 w-3/4" />
                    <div className="h-2 bg-rule rounded animate-pulse mb-1.5 w-1/2" />
                    <div className="h-2 bg-rule rounded animate-pulse w-2/3" />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 4: Subir archivos y pegar URLs ── */}
      {showStep4 && (
        <div className="proof-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-blue text-white text-[10px] font-bold flex items-center justify-center shrink-0">4</span>
            <h2 className="section-title text-ink">Subir a WordPress y pegar URLs</h2>
          </div>
          <p className="text-[11px] font-mono text-ink-muted pl-7">
            Sube los archivos JSON a la biblioteca de medios de WordPress, luego pega las URLs resultantes abajo.
          </p>

          <div className="pl-7 space-y-3">
            {checkedRows.filter(r => r.jsonld).map(row => (
              <div key={row.id} className="flex items-center gap-3">
                <span className="font-mono text-xs font-semibold text-ink uppercase w-8 shrink-0">
                  {row.lang}
                </span>
                <input
                  type="url"
                  value={row.uploadedUrl}
                  onChange={e => handleUploadUrlChange(row.id, e.target.value)}
                  placeholder={`https://ejemplo.com/wp-content/uploads/${pageSlugFromUrl(sourceUrl)}-${row.lang}.json`}
                  className="input-field flex-1 font-mono text-xs py-1.5"
                />
                {row.uploadedUrl.trim() && (
                  <Check size={14} className="text-green-600 shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Step 5: Widget script ── */}
      {showStep5 && script && (
        <div className="proof-card p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-green-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">5</span>
            <h2 className="section-title text-ink">Widget Weglot generado</h2>
          </div>

          <div className="pl-7 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-[11px] font-mono text-ink-muted">
                Script listo para {checkedRows.filter(r => r.uploadedUrl).length} idiomas.
              </p>
              <button
                onClick={() => handleCopy(script)}
                className="btn-ghost text-xs flex items-center gap-1.5 py-1 px-2"
              >
                {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
                {copied ? 'Copiado' : 'Copiar'}
              </button>
            </div>

            <pre className="bg-proof border border-rule rounded p-3 text-[10px] font-mono text-ink overflow-x-auto leading-relaxed max-h-96 overflow-y-auto whitespace-pre">
              {script}
            </pre>

            <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded p-3">
              <Info size={12} className="text-blue shrink-0 mt-0.5" />
              <p className="text-[11px] font-mono text-blue-700">
                Pega este código en un widget HTML de Elementor en la página correspondiente.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Partial URL fill hint */}
      {showStep4 && !showStep5 && allGenerated && (
        <div className="flex items-center gap-2 px-5 py-3 bg-proof border border-rule rounded text-[11px] font-mono text-ink-muted">
          <ArrowRight size={12} />
          El widget se generará cuando ingreses todas las URLs de los JSON subidos.
        </div>
      )}
    </div>
  );
}
