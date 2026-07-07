import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Languages, Globe, Link2, Unlink,
  Download, Copy, Check, Plus, Info,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import type { Client, SchemaProject } from '../lib/database.types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function urlPath(u: string): string {
  try { const { pathname, search } = new URL(u); return (pathname || '/') + search; }
  catch { return u; }
}

function normalizeUrl(u: string): string {
  try { const x = new URL(u); return x.origin + x.pathname.replace(/\/$/, ''); }
  catch { return u.replace(/\/$/, ''); }
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

function downloadJson(project: SchemaProject, lang: string) {
  if (!project.generated_jsonld) return;
  const data = stripInternalKeys(project.generated_jsonld);
  const slug = pageSlugFromUrl(project.page_url);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}-${lang.toLowerCase()}-complete.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function getLanguageAlternates(p: SchemaProject): Array<{ lang: string; url: string }> {
  const s = p.raw_scraped_data as Record<string, unknown> | null;
  if (!s?.language_alternates || !Array.isArray(s.language_alternates)) return [];
  return s.language_alternates as Array<{ lang: string; url: string }>;
}

function getDetectedLanguage(p: SchemaProject): string | null {
  const s = p.raw_scraped_data as Record<string, unknown> | null;
  if (typeof s?.detected_language === 'string' && s.detected_language) {
    return s.detected_language.split('-')[0].toLowerCase();
  }
  return null;
}

const COMMON_LANGS = ['en', 'es', 'fr', 'de', 'pt', 'it', 'ja', 'zh', 'ar', 'nl', 'ko', 'ru', 'pl', 'sv', 'da', 'tr'];

const STATUS_CHIP: Record<string, string> = {
  draft: 'chip-orange', validated: 'chip-blue', delivered: 'chip-green',
};
const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador', validated: 'Validado', delivered: 'Entregado',
};

// ── Language group building ───────────────────────────────────────────────────

interface LanguageGroup {
  projectIds: string[];
  ghosts: Array<{ lang: string; url: string }>;
}

function buildLanguageGroups(projects: SchemaProject[]): LanguageGroup[] {
  const urlToId = new Map<string, string>();
  for (const p of projects) urlToId.set(normalizeUrl(p.page_url), p.id);

  const parent = new Map<string, string>(projects.map(p => [p.id, p.id]));
  function find(id: string): string {
    while (parent.get(id) !== id) {
      const gp = parent.get(parent.get(id)!)!;
      parent.set(id, gp);
      id = gp;
    }
    return id;
  }
  function union(a: string, b: string) { parent.set(find(a), find(b)); }

  // First pass: build unions
  for (const p of projects) {
    for (const alt of getLanguageAlternates(p)) {
      const matchId = urlToId.get(normalizeUrl(alt.url));
      if (matchId && matchId !== p.id) union(p.id, matchId);
    }
  }

  // Collect which roots have any alternates (these form groups)
  const rootsWithAlternates = new Set<string>();
  for (const p of projects) {
    if (getLanguageAlternates(p).length > 0) rootsWithAlternates.add(find(p.id));
  }

  // Second pass: collect ghosts (after union so roots are stable)
  const ghostsByRoot = new Map<string, Array<{ lang: string; url: string }>>();
  for (const p of projects) {
    const alts = getLanguageAlternates(p);
    if (alts.length === 0) continue;
    const root = find(p.id);
    for (const alt of alts) {
      const matchId = urlToId.get(normalizeUrl(alt.url));
      if (!matchId || matchId === p.id) {
        const list = ghostsByRoot.get(root) ?? [];
        if (!list.some(g => normalizeUrl(g.url) === normalizeUrl(alt.url))) {
          list.push(alt);
          ghostsByRoot.set(root, list);
        }
      }
    }
  }

  // Build final groups: every project whose root has alternates belongs to a group
  const groupMap = new Map<string, Set<string>>();
  for (const p of projects) {
    const root = find(p.id);
    if (rootsWithAlternates.has(root)) {
      if (!groupMap.has(root)) groupMap.set(root, new Set());
      groupMap.get(root)!.add(p.id);
    }
  }

  return [...groupMap.entries()].map(([root, ids]) => ({
    projectIds: [...ids],
    ghosts: ghostsByRoot.get(root) ?? [],
  }));
}

// ── Widget script ─────────────────────────────────────────────────────────────

function generateWidgetScript(
  proj1: SchemaProject, lang1: string,
  proj2: SchemaProject, lang2: string,
  jsonUrl1: string, jsonUrl2: string,
): string {
  const slug = pageSlugFromUrl(proj1.page_url);
  const var1 = `URL_JSON_${lang1.toUpperCase()}`;
  const var2 = `URL_JSON_${lang2.toUpperCase()}`;
  return `<script>
document.addEventListener("DOMContentLoaded", function () {
    const ${var1} =
        "${jsonUrl1}";
    const ${var2} =
        "${jsonUrl2}";
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
        const url = language.toLowerCase().startsWith("${lang2.toLowerCase()}")
            ? ${var2}
            : ${var1};
        fetch(url + "?v=" + Date.now(), {
            cache: "no-store"
        })
            .then(function (response) {
                if (!response.ok) {
                    throw new Error(
                        "Could not load JSON-LD: " + response.status
                    );
                }
                return response.json();
            })
            .then(injectSchema)
            .catch(function (error) {
                console.error("Schema JSON-LD error:", error);
            });
    }
    loadSchema(document.documentElement.lang || "${lang1.toLowerCase()}");
    if (
        window.Weglot &&
        typeof Weglot.on === "function"
    ) {
        Weglot.on("languageChanged", function (newLanguage) {
            loadSchema(newLanguage);
        });
    }
});
</script>`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function LanguagesPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [projects, setProjects] = useState<SchemaProject[]>([]);
  const [loading, setLoading] = useState(true);

  const [langEdits, setLangEdits] = useState<Record<string, string>>({});
  const [linking, setLinking] = useState<string | null>(null);
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [pairUrls, setPairUrls] = useState<Record<string, Record<string, string>>>({});
  const [copied, setCopied] = useState<string | null>(null);

  const loadData = async () => {
    if (!clientId) return;
    setLoading(true);
    const [{ data: c }, { data: p }] = await Promise.all([
      supabase.from('clients').select('*').eq('id', clientId).maybeSingle(),
      supabase.from('schema_projects').select('*').eq('client_id', clientId).order('created_at', { ascending: true }),
    ]);
    if (c) setClient(c);
    setProjects(p ?? []);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [clientId]);

  const effectiveLang = (proj: SchemaProject): string => {
    if (langEdits[proj.id] !== undefined) return langEdits[proj.id];
    if (proj.language_code) return proj.language_code;
    return getDetectedLanguage(proj) ?? '';
  };

  const handleSaveLangCode = async (projectId: string, code: string) => {
    await supabase.from('schema_projects').update({ language_code: code || null }).eq('id', projectId);
    setLangEdits(prev => { const n = { ...prev }; delete n[projectId]; return n; });
    await loadData();
  };

  const handleLinkPair = async (group: LanguageGroup) => {
    if (group.projectIds.length < 2) return;
    const [idA, idB] = group.projectIds;
    const projA = projects.find(p => p.id === idA)!;
    const projB = projects.find(p => p.id === idB)!;
    const langA = effectiveLang(projA);
    const langB = effectiveLang(projB);
    setLinking(group.projectIds.sort().join('-'));
    await Promise.all([
      supabase.from('schema_projects').update({
        language_pair_id: idB,
        ...(langA ? { language_code: langA } : {}),
      }).eq('id', idA),
      supabase.from('schema_projects').update({
        language_pair_id: idA,
        ...(langB ? { language_code: langB } : {}),
      }).eq('id', idB),
    ]);
    setLinking(null);
    await loadData();
  };

  const handleUnlinkPair = async (proj1: SchemaProject, proj2: SchemaProject) => {
    setUnlinking([proj1.id, proj2.id].sort().join('-'));
    await Promise.all([
      supabase.from('schema_projects').update({ language_pair_id: null }).eq('id', proj1.id),
      supabase.from('schema_projects').update({ language_pair_id: null }).eq('id', proj2.id),
    ]);
    setUnlinking(null);
    await loadData();
  };

  const getPairUrl = (pairKey: string, projectId: string) =>
    pairUrls[pairKey]?.[projectId] ?? '';

  const setPairUrl = (pairKey: string, projectId: string, value: string) => {
    setPairUrls(prev => ({
      ...prev,
      [pairKey]: { ...(prev[pairKey] ?? {}), [projectId]: value },
    }));
  };

  const handleCopy = async (key: string, text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(c => c === key ? null : c), 2000);
  };

  // ── Derived data ─────────────────────────────────────────────────────────────
  const groups = buildLanguageGroups(projects);
  const groupedProjectIds = new Set(groups.flatMap(g => g.projectIds));

  const pairedIds = new Set<string>();
  const pairs: Array<[SchemaProject, SchemaProject]> = [];
  for (const p of projects) {
    if (!p.language_pair_id || pairedIds.has(p.id)) continue;
    const partner = projects.find(q => q.id === p.language_pair_id);
    if (partner) {
      pairs.push([p, partner]);
      pairedIds.add(p.id);
      pairedIds.add(partner.id);
    }
  }

  const standaloneProjects = projects.filter(
    p => !groupedProjectIds.has(p.id) && !pairedIds.has(p.id),
  );

  const projectById = new Map(projects.map(p => [p.id, p]));

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
              <h1 className="text-base font-semibold text-ink">Multi-idioma / Weglot</h1>
            </div>
            <p className="text-xs font-mono text-ink-muted">
              Vincula versiones de idioma, descarga los JSON-LD y genera el widget Weglot
              para <span className="text-ink">{client?.name ?? '...'}</span>.
            </p>
          </div>
          <button onClick={() => navigate(`/client/${clientId}`)} className="btn-ghost text-xs py-1 px-2 shrink-0">
            Ver cliente
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-16 text-center text-xs font-mono text-ink-muted">Cargando proyectos...</div>
      ) : (
        <>
          {/* ── Section A: Grupos de idioma detectados ─────────────────────── */}
          <div className="proof-card p-5 space-y-4">
            <div>
              <h2 className="section-title text-ink mb-0.5">Grupos de idioma detectados</h2>
              <p className="text-[11px] font-mono text-ink-muted">
                Proyectos con etiquetas <code className="bg-proof px-1 rounded">hreflang</code> detectadas al escanear la página.
              </p>
            </div>

            {groups.length === 0 ? (
              <div className="py-6 text-center border border-dashed border-rule rounded">
                <Globe size={20} className="text-ink-muted mx-auto mb-2" />
                <p className="text-xs font-mono text-ink-muted">
                  Ningún proyecto tiene etiquetas <code>hreflang</code> aún.
                </p>
                <p className="text-[11px] font-mono text-ink-muted mt-1">
                  Escanea la página de inicio del cliente para detectarlas automáticamente.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {groups.map((group, gi) => {
                  const groupProjects = group.projectIds
                    .map(id => projectById.get(id))
                    .filter(Boolean) as SchemaProject[];
                  const alreadyLinked = groupProjects.length >= 2 &&
                    groupProjects.every(p => p.language_pair_id !== null);
                  const groupKey = group.projectIds.slice().sort().join('-');
                  const hasTwoProjects = groupProjects.length >= 2;

                  return (
                    <div key={gi} className="border border-rule rounded overflow-hidden">
                      <div className="divide-y divide-rule">
                        {/* Project rows */}
                        {groupProjects.map(proj => {
                          const detectedLang = getDetectedLanguage(proj);
                          const currentLang = effectiveLang(proj);
                          const isDirty = langEdits[proj.id] !== undefined ||
                            (currentLang !== '' && currentLang !== proj.language_code);
                          return (
                            <div key={proj.id} className="flex items-center gap-3 px-4 py-3 bg-white">
                              <div className="flex-1 min-w-0">
                                <Link
                                  to={`/client/${clientId}/project/${proj.id}`}
                                  className="font-mono text-sm text-ink hover:text-blue transition-colors"
                                >
                                  {urlPath(proj.page_url)}
                                </Link>
                                {detectedLang && !proj.language_code && (
                                  <span className="ml-2 text-[10px] font-mono text-ink-muted">
                                    detectado: {detectedLang}
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                <select
                                  value={currentLang}
                                  onChange={e => setLangEdits(prev => ({ ...prev, [proj.id]: e.target.value }))}
                                  className="input-field py-0.5 px-2 text-xs font-mono w-20"
                                  title="Código de idioma"
                                >
                                  <option value="">--</option>
                                  {COMMON_LANGS.map(l => (
                                    <option key={l} value={l}>{l}</option>
                                  ))}
                                </select>
                                {isDirty && (
                                  <button
                                    onClick={() => handleSaveLangCode(proj.id, currentLang)}
                                    className="btn-ghost text-xs py-0.5 px-2"
                                  >
                                    Guardar
                                  </button>
                                )}
                              </div>
                              <span className={`chip ${STATUS_CHIP[proj.status] ?? 'chip-ink'} shrink-0`}>
                                {STATUS_LABEL[proj.status] ?? proj.status}
                              </span>
                            </div>
                          );
                        })}

                        {/* Ghost rows */}
                        {group.ghosts.map(ghost => (
                          <div key={ghost.url} className="flex items-center gap-3 px-4 py-3 bg-proof">
                            <Info size={12} className="text-ink-muted shrink-0" />
                            <div className="flex-1 min-w-0">
                              <span className="font-mono text-xs text-ink-muted">
                                <span className="font-semibold text-ink">{ghost.lang}</span>:{' '}
                                <span className="truncate">{ghost.url}</span>
                              </span>
                              <span className="ml-2 text-[10px] font-mono text-ink-muted italic">sin proyecto</span>
                            </div>
                            <button
                              onClick={() => navigate(`/client/${clientId}/project/new?url=${encodeURIComponent(ghost.url)}`)}
                              className="btn-ghost text-xs py-1 px-2.5 flex items-center gap-1.5 shrink-0"
                            >
                              <Plus size={11} />
                              Crear proyecto
                            </button>
                          </div>
                        ))}
                      </div>

                      {/* Footer */}
                      <div className="px-4 py-2.5 bg-proof border-t border-rule flex items-center justify-between gap-3">
                        <span className="text-[11px] font-mono text-ink-muted">
                          {alreadyLinked ? (
                            <span className="flex items-center gap-1.5 text-green-700">
                              <Check size={11} className="text-green-600" />
                              Par vinculado
                            </span>
                          ) : hasTwoProjects ? (
                            'Listo para vincular'
                          ) : (
                            'Crea el proyecto para la URL marcada como "sin proyecto" para poder vincular.'
                          )}
                        </span>
                        {hasTwoProjects && !alreadyLinked && (
                          <button
                            onClick={() => handleLinkPair(group)}
                            disabled={linking === groupKey}
                            className="btn-primary text-xs py-1 px-3 flex items-center gap-1.5 shrink-0"
                          >
                            <Link2 size={12} />
                            {linking === groupKey ? 'Vinculando...' : 'Vincular como par de idiomas'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Section B: Pares vinculados ───────────────────────────────── */}
          {pairs.length > 0 && (
            <div className="proof-card p-5 space-y-5">
              <div>
                <h2 className="section-title text-ink mb-0.5">Pares vinculados — exportación</h2>
                <p className="text-[11px] font-mono text-ink-muted">
                  Descarga los JSON-LD, sube los archivos a WordPress, pega las URLs y genera el widget.
                </p>
              </div>

              {pairs.map(([proj1, proj2]) => {
                const lang1 = proj1.language_code ?? getDetectedLanguage(proj1) ?? 'en';
                const lang2 = proj2.language_code ?? getDetectedLanguage(proj2) ?? 'es';
                const pairKey = [proj1.id, proj2.id].sort().join('-');
                const jsonUrl1 = getPairUrl(pairKey, proj1.id);
                const jsonUrl2 = getPairUrl(pairKey, proj2.id);
                const bothReady = jsonUrl1.trim() && jsonUrl2.trim();
                const bothValidated =
                  ['validated', 'delivered'].includes(proj1.status) &&
                  ['validated', 'delivered'].includes(proj2.status);
                const script = bothReady && bothValidated
                  ? generateWidgetScript(proj1, lang1, proj2, lang2, jsonUrl1.trim(), jsonUrl2.trim())
                  : null;
                const pairUnlinkKey = [proj1.id, proj2.id].sort().join('-');

                return (
                  <div key={pairKey} className="border border-rule rounded overflow-hidden">
                    {/* Pair header */}
                    <div className="flex items-center justify-between gap-3 px-4 py-3 bg-proof border-b border-rule">
                      <div className="flex items-center gap-2">
                        <Globe size={13} className="text-blue shrink-0" />
                        <span className="font-mono text-xs font-semibold text-ink">
                          {urlPath(proj1.page_url)}
                        </span>
                        <span className="text-[10px] font-mono text-ink-muted">
                          {lang1.toUpperCase()} ↔ {lang2.toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {!bothValidated && (
                          <span className="text-[10px] font-mono text-orange">
                            Valida ambos proyectos para exportar
                          </span>
                        )}
                        <button
                          onClick={() => handleUnlinkPair(proj1, proj2)}
                          disabled={unlinking === pairUnlinkKey}
                          className="btn-ghost text-xs py-1 px-2 flex items-center gap-1 text-ink-muted hover:text-red"
                        >
                          <Unlink size={11} />
                          {unlinking === pairUnlinkKey ? 'Desvinculando...' : 'Desvincular'}
                        </button>
                      </div>
                    </div>

                    <div className="p-4 space-y-4">
                      {/* Per-language cards */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {([{ proj: proj1, lang: lang1 }, { proj: proj2, lang: lang2 }] as Array<{ proj: SchemaProject; lang: string }>).map(({ proj, lang }) => (
                          <div key={proj.id} className="border border-rule rounded p-3 space-y-3">
                            <div className="flex items-center justify-between">
                              <span className="font-mono text-xs font-semibold text-ink uppercase tracking-wide">
                                {lang}
                              </span>
                              <span className={`chip ${STATUS_CHIP[proj.status] ?? 'chip-ink'}`}>
                                {STATUS_LABEL[proj.status] ?? proj.status}
                              </span>
                            </div>
                            <p className="text-[10px] font-mono text-ink-muted truncate">{urlPath(proj.page_url)}</p>
                            <button
                              onClick={() => downloadJson(proj, lang)}
                              disabled={!proj.generated_jsonld}
                              className="w-full btn-ghost text-xs flex items-center justify-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Download size={12} />
                              Descargar JSON ({lang})
                            </button>
                            <div>
                              <label className="field-label text-[10px]">
                                URL del JSON subido ({lang})
                              </label>
                              <input
                                type="url"
                                value={getPairUrl(pairKey, proj.id)}
                                onChange={e => setPairUrl(pairKey, proj.id, e.target.value)}
                                className="input-field w-full text-xs font-mono py-1"
                                placeholder="https://ejemplo.com/wp-content/uploads/schema.json"
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Widget script */}
                      {script ? (
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] font-mono font-semibold text-ink">
                              Widget script generado
                            </p>
                            <button
                              onClick={() => handleCopy(pairKey, script)}
                              className="btn-ghost text-xs flex items-center gap-1.5 py-1 px-2"
                            >
                              {copied === pairKey
                                ? <Check size={12} className="text-green-600" />
                                : <Copy size={12} />}
                              {copied === pairKey ? 'Copiado' : 'Copiar'}
                            </button>
                          </div>
                          <pre className="bg-proof border border-rule rounded p-3 text-[10px] font-mono text-ink overflow-x-auto leading-relaxed max-h-72 overflow-y-auto whitespace-pre">
                            {script}
                          </pre>
                          <p className="text-[10px] font-mono text-ink-muted">
                            Pega este código en un widget HTML de Elementor en la página correspondiente.
                          </p>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2 bg-proof border border-rule rounded p-3">
                          <Info size={12} className="text-ink-muted shrink-0 mt-0.5" />
                          <p className="text-[11px] font-mono text-ink-muted">
                            {!bothValidated
                              ? 'Ambos proyectos deben estar validados o entregados para generar el widget.'
                              : 'Ingresa las URLs de los JSON subidos para generar el widget.'}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Section C: Standalone projects ───────────────────────────── */}
          {standaloneProjects.length > 0 && (
            <div className="proof-card p-5 space-y-3">
              <div>
                <h2 className="section-title text-ink mb-0.5">Sin versión de idioma detectada</h2>
                <p className="text-[11px] font-mono text-ink-muted">
                  Estos proyectos no tienen etiquetas <code className="bg-proof px-1 rounded">hreflang</code> y no forman parte de ningún par vinculado.
                </p>
              </div>
              <div className="border border-rule rounded overflow-hidden divide-y divide-rule">
                {standaloneProjects.map(proj => (
                  <div key={proj.id} className="flex items-center gap-3 px-4 py-2.5">
                    <Link
                      to={`/client/${clientId}/project/${proj.id}`}
                      className="flex-1 font-mono text-xs text-ink hover:text-blue transition-colors truncate"
                    >
                      {urlPath(proj.page_url)}
                    </Link>
                    <span className={`chip ${STATUS_CHIP[proj.status] ?? 'chip-ink'} text-[10px] shrink-0`}>
                      {STATUS_LABEL[proj.status] ?? proj.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {groups.length === 0 && pairs.length === 0 && projects.length === 0 && (
            <div className="proof-card p-10 text-center">
              <Languages size={24} className="text-ink-muted mx-auto mb-3" />
              <p className="text-sm font-mono text-ink-muted">Este cliente no tiene proyectos aún.</p>
              <button
                onClick={() => navigate(`/client/${clientId}`)}
                className="btn-primary text-xs mt-4 mx-auto flex items-center gap-1.5"
              >
                <ArrowRight size={12} />
                Ir al cliente
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
