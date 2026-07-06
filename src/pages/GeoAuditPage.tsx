import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, GeoAudit, SchemaProject, SchemaTemplate } from '../lib/database.types';
import {
  ArrowLeft, Bot, FileText, Shield, ShieldOff, Copy, Check,
  AlertTriangle, CheckCircle, RefreshCw, Save, Zap, Lightbulb, Info, ArrowRight,
  XCircle, ChevronDown, ChevronRight, Sparkles, Globe,
} from 'lucide-react';

const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Googlebot-Extended', 'CCBot', 'anthropic-ai', 'cohere-ai', 'FacebookBot'];

// ── Types ────────────────────────────────────────────────────────────────────

interface SitemapCheck {
  found: boolean;
  source: 'sitemap_index' | 'sitemap' | null;
  actual_sitemap_url: string | null;
  url_count: number;
  referenced_in_robots: boolean;
  robots_sitemap_mismatch: boolean;
  known_pages_missing: string[];
}

interface RobotsChecklist {
  has_sitemap: boolean;
  sitemap_url: string | null;
  unusual_disallows: string[];
  high_crawl_delay: { agent: string; delay: number }[];
}

interface LlmsChecklist {
  has_business_info: boolean;
  priority_page_count: number;
  has_contact: boolean;
  has_services: boolean;
}

interface AuditResult {
  robots_txt_found: boolean;
  robots_txt_raw: string;
  blocked_ai_crawlers: string[];
  llms_txt_found: boolean;
  llms_txt_raw: string;
  generated_llms_txt: string;
  verdict: string;
  robots_checklist?: RobotsChecklist | null;
  llms_checklist?: LlmsChecklist | null;
  sitemap_check?: SitemapCheck | null;
  suggested_robots_snippet?: string | null;
  improved_llms_txt?: string | null;
}

interface OpportunityResult {
  detector_id: string;
  label_es: string;
  status: 'detected' | 'not_detected';
  actionable: boolean;
  extracted_data: unknown;
  suggestion_es: string;
}

interface ScrapedData {
  opportunities?: OpportunityResult[];
  visible_text_sample?: string;
}

interface Recommendation {
  id: string;
  tier: 1 | 2;
  text: string;
  linkTo?: string;
  linkLabel?: string;
  scrollToLlms?: boolean;
  scrollToSitemap?: boolean;
}

// detector_id → Schema.org type that gets added to @graph when opportunity is included
const OPPORTUNITY_SCHEMA_TYPE: Record<string, string> = {
  video: 'VideoObject',
  faq: 'FAQPage',
  breadcrumb: 'BreadcrumbList',
  reviews_unmarked: 'Review',
  howto: 'HowTo',
  jobposting: 'JobPosting',
};

// ── Utilities ────────────────────────────────────────────────────────────────

function urlPath(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return (pathname || '/') + search;
  } catch { return url; }
}

function extractNodes(jsonld: unknown): Record<string, unknown>[] {
  if (!jsonld || typeof jsonld !== 'object') return [];
  const jld = jsonld as Record<string, unknown>;
  if (Array.isArray(jld['@graph'])) return jld['@graph'] as Record<string, unknown>[];
  if (jld['@type']) return [jld];
  return [];
}

function getNodeType(node: Record<string, unknown>): string | null {
  const t = node['@type'];
  if (typeof t === 'string') return t;
  if (Array.isArray(t) && t.length > 0) return t[0] as string;
  return null;
}

function collectTypesInJsonLd(jsonld: unknown): Set<string> {
  const types = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (obj['@type']) {
        ([] as string[]).concat(obj['@type'] as string | string[]).forEach(t => t && types.add(t));
      }
      Object.values(obj).forEach(walk);
    }
  };
  walk(jsonld);
  return types;
}

// ── Recommendations ──────────────────────────────────────────────────────────

function buildRecommendations(
  projects: SchemaProject[],
  template: SchemaTemplate | null,
  client: Client | null,
  display: AuditResult | null,
): Recommendation[] {
  const recs: Recommendation[] = [];
  const seen = new Set<string>();

  const add = (r: Omit<Recommendation, 'id'>) => {
    const key = `${r.tier}|${r.text.slice(0, 80)}`;
    if (!seen.has(key)) { seen.add(key); recs.push({ ...r, id: key }); }
  };

  // ── Tier 1 — Schema gaps ─────────────────────────────────────────────
  if (template) {
    const reqFields = template.required_fields as Record<string, string[]>;
    const recFields = template.recommended_fields as Record<string, string[]>;

    for (const proj of projects) {
      if (!proj.generated_jsonld) continue;
      const nodes = extractNodes(proj.generated_jsonld);
      const linkTo = `/client/${proj.client_id}/project/${proj.id}`;
      const pageLabel = urlPath(proj.page_url);

      for (const node of nodes) {
        const type = getNodeType(node);
        if (!type || type.startsWith('_')) continue;
        const existing = Object.keys(node).filter(k => !k.startsWith('@') && !k.startsWith('_'));
        const req = reqFields[type] ?? [];
        const rec = recFields[type] ?? [];

        for (const field of req) {
          if (!existing.includes(field)) {
            add({
              tier: 1,
              text: `Agrega "${field}" al schema ${type} en "${pageLabel}" — es un campo requerido para este vertical.`,
              linkTo,
              linkLabel: 'Ver proyecto',
            });
          }
        }
        for (const field of rec) {
          if (!existing.includes(field) && !req.includes(field)) {
            add({
              tier: 1,
              text: `Considera agregar "${field}" al schema ${type} en "${pageLabel}" — campo recomendado para mejorar visibilidad.`,
              linkTo,
              linkLabel: 'Ver proyecto',
            });
          }
        }
      }
    }
  }

  // ── Tier 1 — Opportunity scanner ─────────────────────────────────────
  for (const proj of projects) {
    const scraped = proj.raw_scraped_data as ScrapedData | null;
    if (!scraped?.opportunities) continue;
    const presentTypes = collectTypesInJsonLd(proj.generated_jsonld);
    const linkTo = `/client/${proj.client_id}/project/${proj.id}`;

    for (const opp of scraped.opportunities) {
      if (opp.status === 'not_detected') {
        add({
          tier: 1,
          text: `${opp.label_es} (${urlPath(proj.page_url)}): ${opp.suggestion_es}`,
          linkTo,
          linkLabel: 'Ver proyecto',
        });
      } else if (opp.status === 'detected' && opp.actionable) {
        const schemaType = OPPORTUNITY_SCHEMA_TYPE[opp.detector_id];
        if (schemaType && !presentTypes.has(schemaType)) {
          add({
            tier: 1,
            text: `Se detectó ${opp.label_es} en "${urlPath(proj.page_url)}" pero aún no está incluido en el schema — actívalo en el paso Generar.`,
            linkTo,
            linkLabel: 'Ir al Paso 2',
          });
        }
      }
    }
  }

  // ── Tier 1 — robots.txt checklist (unusual disallows + crawl-delay only) ──
  if (display?.robots_checklist) {
    const rc = display.robots_checklist;
    if (rc.unusual_disallows.length > 0) {
      add({
        tier: 1,
        text: `Revisa las rutas bloqueadas en robots.txt: ${rc.unusual_disallows.join(', ')} — confirma que no estén ocultando contenido que quieres que las IA vean.`,
      });
    }
  }

  // ── Tier 1 — sitemap check ────────────────────────────────────────────
  if (display?.sitemap_check) {
    const sc = display.sitemap_check;
    if (!sc.found) {
      add({
        tier: 1,
        text: 'No se detectó sitemap.xml — agrega uno (los plugins Yoast/Rank Math lo generan automáticamente) para ayudar a los motores de búsqueda e IA a descubrir todo tu contenido.',
        scrollToSitemap: true,
      });
    } else {
      if (!sc.referenced_in_robots) {
        add({
          tier: 1,
          text: `Tu sitemap existe pero robots.txt no lo menciona — agrega la línea 'Sitemap: ${sc.actual_sitemap_url ?? '[url]'}' para ayudar a los crawlers a encontrarlo más rápido.`,
          scrollToSitemap: true,
        });
      }
      if (sc.robots_sitemap_mismatch) {
        add({
          tier: 1,
          text: 'La línea Sitemap en robots.txt no coincide con el sitemap real — verifica cuál URL es correcta.',
          scrollToSitemap: true,
        });
      }
      if (sc.known_pages_missing.length > 0 && sc.known_pages_missing.length <= 3) {
        for (const url of sc.known_pages_missing) {
          add({
            tier: 1,
            text: `La página '${urlPath(url)}' ya tiene schema generado pero no aparece en tu sitemap.xml — agrégala para mejorar su descubribilidad.`,
            scrollToSitemap: true,
          });
        }
      } else if (sc.known_pages_missing.length > 3) {
        add({
          tier: 1,
          text: `${sc.known_pages_missing.length} páginas con schema generado no aparecen en tu sitemap.xml (${sc.known_pages_missing.slice(0, 2).map(urlPath).join(', ')} y más) — agrégralas para mejorar su descubribilidad.`,
          scrollToSitemap: true,
        });
      }
    }
  } else if (display?.robots_checklist && !display.robots_checklist.has_sitemap) {
    // Fallback for older saved audits that pre-date sitemap_check
    add({
      tier: 1,
      text: "Agrega una línea 'Sitemap: [url]' a tu robots.txt para ayudar a los crawlers a descubrir tu contenido de forma más eficiente.",
    });
  }

  // ── Tier 1 — llms.txt checklist ──────────────────────────────────────
  if (display?.llms_checklist && (display.llms_txt_found || display.generated_llms_txt)) {
    const lc = display.llms_checklist;
    if (lc.priority_page_count < 3) {
      add({
        tier: 1,
        text: `Tu llms.txt tiene solo ${lc.priority_page_count} página${lc.priority_page_count !== 1 ? 's' : ''} prioritaria${lc.priority_page_count !== 1 ? 's' : ''} — agrega tus páginas de servicios y contacto más importantes (recomendado: mínimo 3).`,
        scrollToLlms: true,
      });
    }
    if (!lc.has_contact) {
      add({
        tier: 1,
        text: "Agrega información de contacto (teléfono, email) a tu llms.txt para que las herramientas de IA puedan responder preguntas de contacto directamente.",
        scrollToLlms: true,
      });
    }
    if (!lc.has_services) {
      add({
        tier: 1,
        text: "Agrega una lista de tus servicios principales a tu llms.txt bajo un encabezado '## Servicios'.",
        scrollToLlms: true,
      });
    }
  } else if (display && !display.llms_txt_found) {
    if (display.generated_llms_txt) {
      add({
        tier: 1,
        text: 'No tienes llms.txt — hay un borrador generado abajo, listo para revisar y publicar.',
        scrollToLlms: true,
      });
    } else {
      add({
        tier: 1,
        text: 'No tienes llms.txt — ejecuta una auditoría para generar un borrador con los datos de tu negocio.',
      });
    }
  }

  // ── Tier 2 — Credential/number check ─────────────────────────────────
  let credChecked = false;
  for (const proj of projects) {
    if (credChecked) break;
    const scraped = proj.raw_scraped_data as ScrapedData | null;
    if (!scraped?.visible_text_sample) continue;
    const sample = scraped.visible_text_sample;
    const hasCredibilityNumber =
      /\b\d{1,4}\+?\s*(años|year|clientes|proyectos|pacientes|patients|clients|projects)\b/i.test(sample) ||
      /\b(más de|over)\s*\d{1,4}\b/i.test(sample);
    const hasCredentials =
      /(años de experiencia|certificad|acreditad|graduad|egresad|licenciatura|maestría|doctorado|especialidad|certif|credenci)/i.test(sample);
    if (!hasCredibilityNumber && !hasCredentials) {
      add({
        tier: 2,
        text: 'No se detectaron cifras o credenciales específicas en el texto visible (años de experiencia, certificaciones, número de pacientes atendidos). Contenido con datos concretos tiende a ser mejor citado por herramientas de IA.',
      });
    }
    credChecked = true;
  }

  // ── Tier 2 — alumniOf for medical/legal ──────────────────────────────
  if (client?.vertical === 'medical' || client?.vertical === 'legal') {
    for (const proj of projects) {
      if (!proj.generated_jsonld) continue;
      const nodes = extractNodes(proj.generated_jsonld);
      for (const node of nodes) {
        const type = getNodeType(node);
        if ((type === 'Physician' || type === 'Attorney') && !node['alumniOf']) {
          const role = type === 'Physician' ? 'médico/a' : 'abogado/a';
          add({
            tier: 2,
            text: `Considera agregar las credenciales o institución académica del ${role} en el campo "alumniOf" en "${urlPath(proj.page_url)}" — refuerza señales de autoridad (E-E-A-T) que las IA consideran al recomendar profesionales.`,
            linkTo: `/client/${proj.client_id}/project/${proj.id}`,
            linkLabel: 'Ver schema',
          });
        }
      }
    }
  }

  return recs;
}

// ── CheckItem helper ─────────────────────────────────────────────────────────

function CheckItem({ ok, label, note }: { ok: boolean; label: string; note?: string }) {
  return (
    <div className="flex items-start gap-2">
      {ok
        ? <CheckCircle size={12} className="text-green shrink-0 mt-0.5" />
        : <XCircle size={12} className="text-orange shrink-0 mt-0.5" />}
      <div className="min-w-0">
        <span className={`text-[11px] font-mono ${ok ? 'text-ink' : 'text-ink-muted'}`}>{label}</span>
        {note && <span className="text-[11px] font-mono text-ink-muted ml-1">— {note}</span>}
      </div>
    </div>
  );
}

// ── RecommendationsSection ────────────────────────────────────────────────────

function RecommendationsSection({
  projects,
  template,
  client,
  display,
}: {
  projects: SchemaProject[];
  template: SchemaTemplate | null;
  client: Client | null;
  display: AuditResult | null;
}) {
  const hasProjects = projects.length > 0;
  const recs = buildRecommendations(projects, template, client, display);
  const tier1 = recs.filter(r => r.tier === 1);
  const tier2 = recs.filter(r => r.tier === 2);

  return (
    <div className="proof-card p-5 space-y-5">
      {/* Section header */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <Zap size={15} className="text-blue shrink-0" />
          <h2 className="section-title text-ink">Recomendaciones priorizadas para visibilidad en IA</h2>
        </div>
        <p className="text-[11px] font-mono text-ink-muted leading-relaxed">
          Estas recomendaciones mejoran las probabilidades de visibilidad en herramientas de IA — no garantizan que un asistente de IA cite o recomiende el negocio.
        </p>
      </div>

      {/* No projects yet */}
      {!hasProjects && (
        <div className="flex items-start gap-2 bg-proof rounded p-3 border border-rule">
          <Info size={13} className="text-ink-muted shrink-0 mt-0.5" />
          <p className="text-xs font-mono text-ink-muted">
            Genera al menos un proyecto de schema para este cliente para ver recomendaciones basadas en tipos de schema. Las recomendaciones sobre llms.txt aparecerán después de ejecutar una auditoría.
          </p>
        </div>
      )}

      {/* Tier 1 — Acciones directas */}
      <div>
        <div className="flex items-center gap-2 mb-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-blue shrink-0" />
          <h3 className="text-xs font-semibold font-mono text-blue uppercase tracking-wider">
            Acciones directas
          </h3>
          {tier1.length > 0 && (
            <span className="chip chip-blue text-[10px]">{tier1.length}</span>
          )}
        </div>

        {tier1.length === 0 ? (
          <div className="flex items-center gap-2 text-xs font-mono text-green py-1">
            <CheckCircle size={13} className="shrink-0" />
            Sin acciones directas pendientes
          </div>
        ) : (
          <div className="space-y-2">
            {tier1.map(rec => (
              <div
                key={rec.id}
                className="flex items-start gap-2.5 bg-blue/5 border border-blue/20 rounded px-3 py-2.5"
              >
                <ArrowRight size={12} className="text-blue shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-ink leading-relaxed">{rec.text}</p>
                  {rec.linkTo && (
                    <Link
                      to={rec.linkTo}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] font-mono text-blue hover:underline"
                    >
                      {rec.linkLabel ?? 'Ver proyecto'}
                      <ArrowRight size={10} />
                    </Link>
                  )}
                  {rec.scrollToLlms && !rec.linkTo && (
                    <button
                      onClick={() => document.getElementById('llms-section')?.scrollIntoView({ behavior: 'smooth' })}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] font-mono text-blue hover:underline"
                    >
                      Ver llms.txt abajo
                      <ArrowRight size={10} />
                    </button>
                  )}
                  {rec.scrollToSitemap && !rec.linkTo && (
                    <button
                      onClick={() => document.getElementById('sitemap-section')?.scrollIntoView({ behavior: 'smooth' })}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] font-mono text-blue hover:underline"
                    >
                      Ver sitemap abajo
                      <ArrowRight size={10} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tier 2 — Sugerencias de contenido */}
      <div>
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
          <h3 className="text-xs font-semibold font-mono text-amber-700 uppercase tracking-wider">
            Sugerencias de contenido
          </h3>
          {tier2.length > 0 && (
            <span className="text-[10px] font-mono bg-amber-100 text-amber-700 border border-amber-200 rounded px-1.5 py-0.5">{tier2.length}</span>
          )}
        </div>
        <p className="text-[10px] font-mono text-ink-muted mb-2 leading-relaxed">
          Sugerencias basadas en patrones generales de contenido citado por IA — no automatizamos ni garantizamos resultados; requieren criterio humano.
        </p>

        {tier2.length === 0 ? (
          <div className="flex items-center gap-2 text-xs font-mono text-green py-1">
            <CheckCircle size={13} className="shrink-0" />
            Sin sugerencias adicionales
          </div>
        ) : (
          <div className="space-y-2">
            {tier2.map(rec => (
              <div
                key={rec.id}
                className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded px-3 py-2.5"
              >
                <Lightbulb size={12} className="text-amber-600 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-amber-800 leading-relaxed">{rec.text}</p>
                  {rec.linkTo && (
                    <Link
                      to={rec.linkTo}
                      className="inline-flex items-center gap-1 mt-1 text-[11px] font-mono text-amber-700 hover:underline"
                    >
                      {rec.linkLabel ?? 'Ver proyecto'}
                      <ArrowRight size={10} />
                    </Link>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function GeoAuditPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [lastAudit, setLastAudit] = useState<GeoAudit | null>(null);
  const [projects, setProjects] = useState<SchemaProject[]>([]);
  const [template, setTemplate] = useState<SchemaTemplate | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [robotsExpanded, setRobotsExpanded] = useState(false);
  const [snippetCopied, setSnippetCopied] = useState(false);
  const [llmsText, setLlmsText] = useState('');
  const [llmsCopied, setLlmsCopied] = useState(false);
  const [improvedLlmsText, setImprovedLlmsText] = useState('');
  const [improvedExpanded, setImprovedExpanded] = useState(false);
  const [improvedCopied, setImprovedCopied] = useState(false);

  useEffect(() => {
    loadData();
  }, [clientId]);

  const loadData = async () => {
    if (!clientId) return;
    const { data: c } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (c) setClient(c);

    const [auditRes, projectsRes] = await Promise.all([
      supabase
        .from('geo_audits')
        .select('*')
        .eq('client_id', clientId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('schema_projects')
        .select('id, page_url, client_id, generated_jsonld, raw_scraped_data, status, schema_types')
        .eq('client_id', clientId)
        .in('status', ['validated', 'delivered'])
        .order('updated_at', { ascending: false }),
    ]);

    if (auditRes.data) {
      setLastAudit(auditRes.data);
      if (auditRes.data.generated_llms_txt) setLlmsText(auditRes.data.generated_llms_txt);
    }
    if (projectsRes.data) setProjects(projectsRes.data as SchemaProject[]);

    if (c?.vertical) {
      const { data: tmpl } = await supabase
        .from('schema_templates')
        .select('*')
        .eq('vertical', c.vertical)
        .maybeSingle();
      if (tmpl) setTemplate(tmpl);
    }
  };

  const handleAudit = async () => {
    if (!client) return;
    setAuditError('');
    setAuditing(true);
    try {
      const { data, error } = await supabase.functions.invoke('geo-audit', {
        body: {
          site_url: client.website_url,
          business_data: projects[0]?.generated_jsonld ?? undefined,
          page_urls: projects.map(p => p.page_url),
        },
      });
      if (error) throw error;
      if (!data) throw new Error('Sin respuesta del servidor');
      setResult(data as AuditResult);
      if (data.generated_llms_txt) setLlmsText(data.generated_llms_txt);
      if (data.improved_llms_txt) { setImprovedLlmsText(data.improved_llms_txt); setImprovedExpanded(false); }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al auditar';
      setAuditError(msg);
    }
    setAuditing(false);
  };

  const handleSave = async () => {
    if (!result || !clientId) return;
    setSaving(true);
    const { error } = await supabase.from('geo_audits').insert({
      client_id: clientId,
      robots_txt_found: result.robots_txt_found,
      blocked_ai_crawlers: result.blocked_ai_crawlers,
      llms_txt_found: result.llms_txt_found,
      generated_llms_txt: llmsText,
      notes: result.verdict,
      robots_checklist: result.robots_checklist ?? null,
      llms_checklist: result.llms_checklist ?? null,
      sitemap_check: result.sitemap_check ?? null,
    });
    setSaving(false);
    if (!error) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      loadData();
    }
  };

  const handleCopyLlms = async () => {
    await navigator.clipboard.writeText(llmsText);
    setLlmsCopied(true);
    setTimeout(() => setLlmsCopied(false), 2000);
  };

  const handleCopySnippet = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setSnippetCopied(true);
    setTimeout(() => setSnippetCopied(false), 2000);
  };

  const handleCopyImproved = async () => {
    await navigator.clipboard.writeText(improvedLlmsText);
    setImprovedCopied(true);
    setTimeout(() => setImprovedCopied(false), 2000);
  };

  const display = result ?? (lastAudit ? {
    robots_txt_found: lastAudit.robots_txt_found ?? false,
    robots_txt_raw: '',
    blocked_ai_crawlers: lastAudit.blocked_ai_crawlers ?? [],
    llms_txt_found: lastAudit.llms_txt_found ?? false,
    llms_txt_raw: '',
    generated_llms_txt: lastAudit.generated_llms_txt ?? '',
    verdict: lastAudit.notes ?? '',
    robots_checklist: (lastAudit.robots_checklist as RobotsChecklist | null) ?? undefined,
    llms_checklist: (lastAudit.llms_checklist as LlmsChecklist | null) ?? undefined,
    sitemap_check: (lastAudit.sitemap_check as SitemapCheck | null) ?? undefined,
  } as AuditResult : null);

  return (
    <div className="max-w-3xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-5 text-xs font-mono text-ink-muted">
        <button onClick={() => navigate('/')} className="hover:text-ink flex items-center gap-1">
          <ArrowLeft size={12} />
          Clientes
        </button>
        <span>/</span>
        <button onClick={() => navigate(`/client/${clientId}`)} className="hover:text-ink text-ink">
          {client?.name ?? '...'}
        </button>
        <span>/</span>
        <span>GEO Audit</span>
      </div>

      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Auditoría GEO</h1>
          <p className="text-xs font-mono text-ink-muted mt-0.5">
            Visibilidad para crawlers de IA — {client?.website_url}
          </p>
        </div>
        <button
          onClick={handleAudit}
          disabled={auditing}
          className="btn-orange flex items-center gap-2"
        >
          <RefreshCw size={14} className={auditing ? 'animate-spin' : ''} />
          {auditing ? 'Auditando...' : 'Auditar visibilidad AI'}
        </button>
      </div>

      {auditError && (
        <div className="mb-4 flex items-start gap-2 bg-orange/8 border border-orange/30 rounded p-3">
          <AlertTriangle size={14} className="text-orange shrink-0 mt-0.5" />
          <p className="text-xs font-mono text-orange">{auditError}</p>
        </div>
      )}

      {display ? (
        <div className="space-y-4">
          {/* Verdict banner */}
          {display.verdict && (
            <div className={`proof-card p-4 flex items-start gap-3 ${
              display.blocked_ai_crawlers.length > 0 ? 'border-orange' : 'border-green'
            }`}>
              {display.blocked_ai_crawlers.length > 0 ? (
                <ShieldOff size={18} className="text-orange shrink-0 mt-0.5" />
              ) : (
                <Shield size={18} className="text-green shrink-0 mt-0.5" />
              )}
              <div>
                <p className="text-xs font-mono text-ink-muted uppercase tracking-wider mb-0.5">Veredicto</p>
                <p className="text-sm font-semibold text-ink">{display.verdict}</p>
              </div>
            </div>
          )}

          {/* robots.txt */}
          <div className="proof-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Bot size={15} className="text-ink-muted" />
              <h2 className="section-title">robots.txt</h2>
              <span className={`chip ${display.robots_txt_found ? 'chip-blue' : 'chip-orange'}`}>
                {display.robots_txt_found ? 'Encontrado' : 'No encontrado'}
              </span>
            </div>

            {display.blocked_ai_crawlers.length > 0 ? (
              <div>
                <p className="text-xs font-mono text-ink-muted mb-2">Crawlers de IA bloqueados:</p>
                <div className="flex flex-wrap gap-1.5">
                  {display.blocked_ai_crawlers.map(bot => (
                    <span key={bot} className="chip chip-orange font-mono">{bot}</span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {AI_CRAWLERS.map(bot => (
                  <span key={bot} className="chip chip-blue font-mono opacity-50">{bot}</span>
                ))}
                <p className="w-full text-xs font-mono text-ink-muted mt-1">
                  Ningún crawler de IA conocido está bloqueado.
                </p>
              </div>
            )}

            {/* robots.txt checklist */}
            {display.robots_checklist && (
              <div className="mt-4 pt-4 border-t border-rule space-y-2">
                <p className="text-[10px] font-mono text-ink-muted uppercase tracking-wider mb-2">
                  Cómo está ahora / Cómo debería estar
                </p>
                <CheckItem
                  ok={display.robots_checklist.has_sitemap}
                  label="Incluye directiva Sitemap"
                  note={display.robots_checklist.sitemap_url ?? undefined}
                />
                {display.robots_checklist.unusual_disallows.length > 0 && (
                  <div className="mt-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-[11px] font-mono text-amber-700">
                          Rutas bloqueadas para revisar — confirma que no ocultan contenido indexable:
                        </p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {display.robots_checklist.unusual_disallows.map(p => (
                            <code key={p} className="text-[10px] font-mono bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 text-amber-800">
                              {p}
                            </code>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {display.robots_checklist.high_crawl_delay.map(({ agent, delay }) => (
                  <div key={agent} className="flex items-start gap-2">
                    <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] font-mono text-amber-700">
                      Crawl-delay alto para {agent}: {delay}s — ralentiza (no bloquea) el rastreo de ese crawler.
                    </p>
                  </div>
                ))}
              </div>
            )}

            {display.robots_txt_raw && (
              <div className="mt-3">
                <button
                  onClick={() => setRobotsExpanded(v => !v)}
                  className="text-xs font-mono text-ink-muted hover:text-ink"
                >
                  {robotsExpanded ? 'Ocultar' : 'Ver'} robots.txt completo
                </button>
                {robotsExpanded && (
                  <pre className="proof-code mt-2 text-xs overflow-auto max-h-48">{display.robots_txt_raw}</pre>
                )}
              </div>
            )}

            {/* Suggested additive snippet — only when Sitemap directive is missing */}
            {display.suggested_robots_snippet && (
              <div className="mt-4 pt-4 border-t border-rule">
                <div className="flex items-start gap-2 mb-2">
                  <Sparkles size={12} className="text-blue shrink-0 mt-0.5" />
                  <p className="text-[11px] font-mono text-blue font-medium">
                    Línea sugerida para agregar a tu robots.txt existente (no reemplaces el archivo completo):
                  </p>
                </div>
                <div className="flex items-center gap-2 bg-proof border border-rule rounded px-3 py-2">
                  <code className="flex-1 text-xs font-mono text-ink">{display.suggested_robots_snippet}</code>
                  <button
                    onClick={() => handleCopySnippet(display.suggested_robots_snippet!)}
                    className="btn-ghost flex items-center gap-1 text-[11px] shrink-0"
                  >
                    {snippetCopied ? <Check size={11} /> : <Copy size={11} />}
                    {snippetCopied ? 'Copiado' : 'Copiar'}
                  </button>
                </div>
                <p className="text-[10px] font-mono text-ink-muted mt-1.5">
                  Agrega esta línea al final de tu archivo robots.txt actual. No es necesario modificar ninguna otra línea existente.
                </p>
              </div>
            )}

          </div>

          {/* sitemap.xml */}
          <div id="sitemap-section" className="proof-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <Globe size={15} className="text-ink-muted" />
              <h2 className="section-title">sitemap.xml</h2>
              {display.sitemap_check ? (
                <span className={`chip ${display.sitemap_check.found ? 'chip-blue' : 'chip-orange'}`}>
                  {display.sitemap_check.found ? 'Encontrado' : 'No encontrado'}
                </span>
              ) : (
                <span className="chip chip-orange">Ejecuta auditoría</span>
              )}
            </div>

            {display.sitemap_check ? (
              display.sitemap_check.found ? (
                <div className="space-y-3">
                  <p className="text-xs font-mono text-ink">
                    {display.sitemap_check.url_count.toLocaleString('es-MX')} URLs
                    <span className="text-ink-muted ml-1.5">
                      (vía {display.sitemap_check.source === 'sitemap_index' ? 'sitemap_index.xml' : 'sitemap.xml'})
                    </span>
                  </p>

                  {!display.sitemap_check.referenced_in_robots && (
                    <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded px-3 py-2.5">
                      <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                      <p className="text-[11px] font-mono text-amber-700">
                        Tu sitemap existe pero robots.txt no lo menciona — agregar la línea{' '}
                        <code className="bg-amber-100 px-1 rounded">
                          Sitemap: {display.sitemap_check.actual_sitemap_url}
                        </code>
                        {' '}ayuda a los crawlers a encontrarlo más rápido.
                      </p>
                    </div>
                  )}

                  {display.sitemap_check.robots_sitemap_mismatch && (
                    <div className="flex items-start gap-2 bg-orange/8 border border-orange/30 rounded px-3 py-2.5">
                      <XCircle size={12} className="text-orange shrink-0 mt-0.5" />
                      <p className="text-[11px] font-mono text-orange">
                        La línea Sitemap en robots.txt no coincide con el sitemap real — verifica cuál URL es correcta.
                      </p>
                    </div>
                  )}

                  {display.sitemap_check.known_pages_missing.length > 0 && (
                    <div className="flex items-start gap-2">
                      <AlertTriangle size={12} className="text-amber-500 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="text-[11px] font-mono text-amber-700 mb-1.5">
                          Páginas con schema ya generado que no aparecen en el sitemap:
                        </p>
                        <div className="space-y-1">
                          {display.sitemap_check.known_pages_missing.map(url => (
                            <code key={url} className="block text-[10px] font-mono text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1 break-all">
                              {url}
                            </code>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-xs font-mono text-ink-muted">
                  Sin sitemap.xml detectado — la mayoría de plugins SEO de WordPress (Yoast, Rank Math) lo generan automáticamente; verifica que esté habilitado.
                </p>
              )
            ) : (
              <p className="text-xs font-mono text-ink-muted">
                Ejecuta una auditoría para analizar el sitemap.xml del sitio.
              </p>
            )}
          </div>

          {/* llms.txt */}
          <div id="llms-section" className="proof-card p-5">
            <div className="flex items-center gap-2 mb-3">
              <FileText size={15} className="text-ink-muted" />
              <h2 className="section-title">llms.txt</h2>
              <span className={`chip ${display.llms_txt_found ? 'chip-blue' : 'chip-orange'}`}>
                {display.llms_txt_found ? 'Encontrado' : 'No encontrado'}
              </span>
            </div>

            {display.llms_txt_found && display.llms_txt_raw ? (
              <pre className="proof-code text-xs overflow-auto max-h-48 mb-3">{display.llms_txt_raw}</pre>
            ) : (
              <p className="text-xs font-mono text-ink-muted mb-3">
                No se encontró llms.txt en el sitio. Se generó un borrador para el cliente:
              </p>
            )}

            {!display.llms_txt_found && (
              <div>
                <textarea
                  value={llmsText}
                  onChange={e => setLlmsText(e.target.value)}
                  rows={8}
                  className="input-field w-full font-mono text-xs resize-none mb-2"
                  placeholder="# llms.txt — generando..."
                />
                <button onClick={handleCopyLlms} className="btn-ghost flex items-center gap-1.5 text-xs">
                  {llmsCopied ? <Check size={12} /> : <Copy size={12} />}
                  {llmsCopied ? 'Copiado' : 'Copiar llms.txt'}
                </button>
              </div>
            )}

            {/* llms.txt checklist */}
            {display.llms_checklist && (
              <div className="mt-4 pt-4 border-t border-rule space-y-2">
                <p className="text-[10px] font-mono text-ink-muted uppercase tracking-wider mb-2">
                  Cómo está ahora / Cómo debería estar
                </p>
                <CheckItem
                  ok={display.llms_checklist.has_business_info}
                  label="Incluye nombre y descripción del negocio"
                />
                <CheckItem
                  ok={display.llms_checklist.priority_page_count >= 3}
                  label="Incluye al menos 3 páginas prioritarias"
                  note={`${display.llms_checklist.priority_page_count} detectada${display.llms_checklist.priority_page_count !== 1 ? 's' : ''}`}
                />
                <CheckItem
                  ok={display.llms_checklist.has_contact}
                  label="Incluye información de contacto"
                />
                <CheckItem
                  ok={display.llms_checklist.has_services}
                  label="Incluye lista de servicios"
                />
              </div>
            )}

            {display.llms_txt_found && !display.llms_checklist && (
              <p className="mt-3 text-[11px] font-mono text-ink-muted">
                Ejecuta una nueva auditoría para ver el análisis detallado de este archivo.
              </p>
            )}

            {/* Improved llms.txt — collapsible, only when existing file has gaps */}
            {display.llms_txt_found && improvedLlmsText && (
              <div className="mt-4 pt-4 border-t border-rule">
                <button
                  onClick={() => setImprovedExpanded(v => !v)}
                  className="flex items-center gap-2 w-full text-left group"
                >
                  <Sparkles size={12} className="text-blue shrink-0" />
                  <span className="text-[11px] font-mono font-medium text-blue flex-1">
                    Versión mejorada sugerida (copiar y pegar)
                  </span>
                  {improvedExpanded
                    ? <ChevronDown size={12} className="text-ink-muted shrink-0" />
                    : <ChevronRight size={12} className="text-ink-muted shrink-0" />}
                </button>

                {improvedExpanded && (
                  <div className="mt-3 space-y-2">
                    <textarea
                      value={improvedLlmsText}
                      onChange={e => setImprovedLlmsText(e.target.value)}
                      rows={12}
                      className="input-field w-full font-mono text-xs resize-none"
                    />
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-[10px] font-mono text-ink-muted">
                          Reemplaza el contenido de tu archivo /llms.txt actual con esta versión.
                        </p>
                        <p className="text-[10px] font-mono text-amber-600">
                          Los textos entre corchetes [ ] son marcadores — completa o elimínalos antes de publicar.
                        </p>
                      </div>
                      <button
                        onClick={handleCopyImproved}
                        className="btn-ghost flex items-center gap-1.5 text-xs shrink-0"
                      >
                        {improvedCopied ? <Check size={12} /> : <Copy size={12} />}
                        {improvedCopied ? 'Copiado' : 'Copiar'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Recommendations */}
          <RecommendationsSection
            projects={projects}
            template={template}
            client={client}
            display={display}
          />

          {result && (
            <div className="flex justify-end">
              <button
                onClick={handleSave}
                disabled={saving}
                className="btn-primary flex items-center gap-2"
              >
                {saved ? <CheckCircle size={14} /> : <Save size={14} />}
                {saved ? 'Guardado' : saving ? 'Guardando...' : 'Guardar auditoría'}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="proof-card p-12 text-center">
            <Bot size={36} className="text-rule mx-auto mb-3" />
            <p className="text-sm text-ink-muted font-mono">
              Haz clic en "Auditar visibilidad AI" para comenzar.
            </p>
            {lastAudit && (
              <p className="text-xs font-mono text-ink-muted mt-2">
                Última auditoría: {new Date(lastAudit.created_at).toLocaleDateString('es-MX')}
              </p>
            )}
          </div>

          {/* Show recommendations even without a fresh audit if we have projects */}
          {projects.length > 0 && (
            <RecommendationsSection
              projects={projects}
              template={template}
              client={client}
              display={null}
            />
          )}
        </div>
      )}
    </div>
  );
}
