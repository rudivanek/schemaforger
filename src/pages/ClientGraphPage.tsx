import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Json } from '../lib/database.types';
import type { Client, SchemaProject } from '../lib/database.types';
import {
  ArrowLeft, CheckCircle, AlertTriangle, AlertCircle,
  RefreshCw, ExternalLink, ChevronDown, ChevronUp, Download,
  X, Globe, Search, Plus,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface FlatNode {
  node: Record<string, unknown>;
  sourcePageUrl: string;
  sourceProjectId: string;
}

interface BareRef {
  id: string;
  sourcePageUrl: string;
  sourceProjectId: string;
  inField: string;
}

interface FieldDiff {
  field: string;
  dbVal: unknown;
  liveVal: unknown;
}

interface IdCollision {
  id: string;
  pageA: string; projectIdA: string; nodeA: Record<string, unknown>;
  pageB: string; projectIdB: string; nodeB: Record<string, unknown>;
  diffs: FieldDiff[];
}

interface PossibleDuplicate {
  type: string;
  nodeA: Record<string, unknown>; pageA: string; projectIdA: string;
  nodeB: Record<string, unknown>; pageB: string; projectIdB: string;
  similarity: number;
}

type LiveStatus = 'match' | 'modified' | 'missing';

interface LiveNodeResult {
  id: string;
  status: LiveStatus;
  diffs?: FieldDiff[];
  liveNode?: Record<string, unknown>;
}

interface UntrackedNode {
  node: Record<string, unknown>;
  id?: string;
}

// ── Discovery types ───────────────────────────────────────────────────────────

type DiscoveryStatus = 'no_overlap' | 'match' | 'conflict';

interface DiscoveryConflict {
  id: string;
  knownProjectId: string;
  knownPageUrl: string;
  knownNode: Record<string, unknown>;
  liveNode: Record<string, unknown>;
  diffs: FieldDiff[];
}

interface DiscoveryPageResult {
  url: string;
  status: DiscoveryStatus;
  conflicts: DiscoveryConflict[];
  error?: string;
}

interface LivePageResult {
  projectId: string;
  pageUrl: string;
  overallStatus: LiveStatus;
  nodeResults: LiveNodeResult[];
  untrackedNodes: UntrackedNode[];
  error?: string;
}

interface AdoptModifiedTarget {
  projectId: string;
  project: SchemaProject;
  nodeId: string;
  liveNode: Record<string, unknown>;
  diffs: FieldDiff[];
}

interface AdoptUnknownTarget {
  sourcePageUrl: string;
  node: Record<string, unknown>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectTypedNodes(
  jsonld: unknown,
  pageUrl: string,
  projectId: string,
): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const obj = v as Record<string, unknown>;
    if (obj['@type']) out.push({ node: obj, sourcePageUrl: pageUrl, sourceProjectId: projectId });
    for (const [k, val] of Object.entries(obj)) {
      if (!k.startsWith('_')) walk(val);
    }
  };
  walk(jsonld);
  return out;
}

function collectBareRefs(root: unknown, pageUrl: string, projectId: string): BareRef[] {
  const refs: BareRef[] = [];
  const walk = (v: unknown, parentField: string) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(item => walk(item, parentField)); return; }
    const obj = v as Record<string, unknown>;
    if (typeof obj['@id'] === 'string' && !obj['@type']) {
      refs.push({ id: obj['@id'], sourcePageUrl: pageUrl, sourceProjectId: projectId, inField: parentField });
    }
    for (const [k, val] of Object.entries(obj)) {
      if (!k.startsWith('_')) walk(val, k);
    }
  };
  walk(root, 'root');
  return refs;
}

function getNodeTypes(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  if (!t) return [];
  return ([] as string[]).concat(t as string | string[]);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a as object).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.join('\0') !== bKeys.join('\0')) return false;
    return aKeys.every(k =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

function diffNodes(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): FieldDiff[] {
  const allKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diffs: FieldDiff[] = [];
  for (const k of allKeys) {
    if (k.startsWith('@') || k.startsWith('_')) continue;
    if (!deepEqual(a[k], b[k])) diffs.push({ field: k, dbVal: a[k], liveVal: b[k] });
  }
  return diffs;
}

function normalizeText(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.toLowerCase().trim().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ');
}

function diceSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const bigrams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      m.set(bg, (m.get(bg) ?? 0) + 1);
    }
    return m;
  };
  const totalA = Math.max(0, a.length - 1);
  const totalB = Math.max(0, b.length - 1);
  if (totalA === 0 || totalB === 0) return 0;
  const aBg = bigrams(a);
  const bBg = bigrams(b);
  let intersection = 0;
  aBg.forEach((count, bg) => { intersection += Math.min(count, bBg.get(bg) ?? 0); });
  return (2 * intersection) / (totalA + totalB);
}

function getSimilarityText(node: Record<string, unknown>): string {
  return [node['name'], node['headline'], node['description']]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function nodeSummary(node: Record<string, unknown>): string {
  const v = node['name'] ?? node['headline'] ?? node['legalName'] ?? node['@id'];
  if (!v) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let idx = 0;
  const worker = async () => {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function urlPath(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return (pathname || '/') + search;
  } catch { return url; }
}

function formatVal(v: unknown): string {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function replaceNodeById(
  jsonld: unknown,
  targetId: string,
  newNode: Record<string, unknown>,
): unknown {
  if (!jsonld || typeof jsonld !== 'object') return jsonld;
  if (Array.isArray(jsonld)) {
    return jsonld.map(item => replaceNodeById(item, targetId, newNode));
  }
  const obj = jsonld as Record<string, unknown>;
  if (obj['@id'] === targetId && obj['@type']) return { ...newNode };
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[k] = replaceNodeById(v, targetId, newNode);
  }
  return result;
}

function appendNodeToJsonld(jsonld: unknown, newNode: Record<string, unknown>): unknown {
  if (!jsonld) return [newNode];
  if (Array.isArray(jsonld)) return [...jsonld, newNode];
  const obj = jsonld as Record<string, unknown>;
  if (Array.isArray(obj['@graph'])) {
    return { ...obj, '@graph': [...(obj['@graph'] as unknown[]), newNode] };
  }
  return [jsonld, newNode];
}

function appendOperatorNote(rawData: unknown, note: string): Record<string, unknown> {
  const existing = ((rawData as Record<string, unknown>)?._operator_notes ?? []) as string[];
  return { ...(rawData as object ?? {}), _operator_notes: [...existing, note] };
}

function adoptionNote(action: string, types: string[], id: string): string {
  const date = new Date().toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
  return `${action} el ${date}: nodo ${types.join('/')}#${id}`;
}

function crossCheckJsonld(
  scannedUrl: string,
  scannedJsonld: unknown,
  knownNodes: Map<string, { node: Record<string, unknown>; projectId: string; pageUrl: string }>,
): DiscoveryPageResult {
  const liveNodes = collectTypedNodes(scannedJsonld ?? [], scannedUrl, '');
  const conflicts: DiscoveryConflict[] = [];
  let hasOverlap = false;
  for (const fn of liveNodes) {
    const id = fn.node['@id'];
    if (typeof id !== 'string') continue;
    const known = knownNodes.get(id);
    if (!known) continue;
    hasOverlap = true;
    if (!deepEqual(fn.node, known.node)) {
      conflicts.push({
        id,
        knownProjectId: known.projectId,
        knownPageUrl: known.pageUrl,
        knownNode: known.node,
        liveNode: fn.node,
        diffs: diffNodes(known.node, fn.node),
      });
    }
  }
  return {
    url: scannedUrl,
    status: !hasOverlap ? 'no_overlap' : conflicts.length > 0 ? 'conflict' : 'match',
    conflicts,
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function DiffTable({ diffs }: { diffs: FieldDiff[] }) {
  return (
    <div className="mt-2 border border-rule rounded overflow-hidden text-xs font-mono">
      <div className="grid grid-cols-3 gap-0 bg-proof border-b border-rule px-2 py-1 text-[10px] uppercase tracking-wider text-ink-muted">
        <span>Campo</span>
        <span>Guardado (DB)</span>
        <span>En vivo</span>
      </div>
      {diffs.map(d => (
        <div key={d.field} className="grid grid-cols-3 gap-0 border-b border-rule last:border-0 px-2 py-1.5">
          <span className="text-ink font-medium">{d.field}</span>
          <span className="text-ink-muted truncate pr-2">{formatVal(d.dbVal)}</span>
          <span className="text-orange truncate">{formatVal(d.liveVal)}</span>
        </div>
      ))}
    </div>
  );
}

function IdDiffTable({ diffs }: { diffs: FieldDiff[] }) {
  return (
    <div className="mt-2 border border-rule rounded overflow-hidden text-xs font-mono">
      <div className="grid grid-cols-3 gap-0 bg-proof border-b border-rule px-2 py-1 text-[10px] uppercase tracking-wider text-ink-muted">
        <span>Campo</span>
        <span>Página A</span>
        <span>Página B</span>
      </div>
      {diffs.map(d => (
        <div key={d.field} className="grid grid-cols-3 gap-0 border-b border-rule last:border-0 px-2 py-1.5">
          <span className="text-ink font-medium">{d.field}</span>
          <span className="text-ink-muted truncate pr-2">{formatVal(d.dbVal)}</span>
          <span className="text-orange truncate">{formatVal(d.liveVal)}</span>
        </div>
      ))}
    </div>
  );
}

// ── SiteDiscoverySection ──────────────────────────────────────────────────────

function SiteDiscoverySection({
  clientId,
  client,
  allProjects,
  onProjectCreated,
}: {
  clientId: string;
  client: Client;
  allProjects: SchemaProject[];
  onProjectCreated: () => Promise<void>;
}) {
  const navigate = useNavigate();

  const [expanded, setExpanded] = useState(false);

  // Full-site discovery
  const [discovering, setDiscovering] = useState(false);
  const [discoveredPages, setDiscoveredPages] = useState<Array<{ url: string; hasProject: boolean }> | null>(null);
  const [discoveryMeta, setDiscoveryMeta] = useState<{ source: string; total: number; truncated: boolean } | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Scanning
  const [scanStatus, setScanStatus] = useState<Record<string, 'scanning' | 'done' | 'error'>>({});
  const [results, setResults] = useState<Record<string, DiscoveryPageResult>>({});
  const [scanning, setScanning] = useState(false);

  // Manual entry
  const [manualInput, setManualInput] = useState('');
  const [scanningManual, setScanningManual] = useState(false);

  // Create project
  const [creatingProject, setCreatingProject] = useState<string | null>(null);

  const buildKnownNodes = () => {
    const map = new Map<string, { node: Record<string, unknown>; projectId: string; pageUrl: string }>();
    allProjects.forEach(p => {
      if (!p.generated_jsonld) return;
      collectTypedNodes(p.generated_jsonld, p.page_url, p.id).forEach(fn => {
        const id = fn.node['@id'];
        if (typeof id === 'string' && !map.has(id)) {
          map.set(id, { node: fn.node, projectId: p.id, pageUrl: p.page_url });
        }
      });
    });
    return map;
  };

  const handleDiscoverSite = async () => {
    setDiscovering(true);
    setDiscoveryError(null);
    setDiscoveredPages(null);
    setDiscoveryMeta(null);
    setResults({});
    setScanStatus({});
    setSelected(new Set());
    try {
      const { data, error } = await supabase.functions.invoke('discover-site-pages', {
        body: { site_url: client.website_url },
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      const projectUrls = new Set(allProjects.map(p => p.page_url));
      const pages = (data.pages as string[]).map(url => ({
        url,
        hasProject: projectUrls.has(url),
      }));
      setDiscoveredPages(pages);
      setDiscoveryMeta({ source: data.source, total: data.total_found, truncated: !!data.truncated });
      setSelected(new Set(pages.filter(p => !p.hasProject).map(p => p.url)));
    } catch (e) {
      setDiscoveryError(e instanceof Error ? e.message : String(e));
    }
    setDiscovering(false);
  };

  const runScanUrls = async (urls: string[]) => {
    const knownNodes = buildKnownNodes();
    setScanStatus(prev => {
      const next = { ...prev };
      urls.forEach(u => { next[u] = 'scanning'; });
      return next;
    });
    const tasks = urls.map(url => async () => {
      try {
        const { data, error } = await supabase.functions.invoke('scrape-site', { body: { url } });
        if (error) throw error;
        const liveJsonld = data?.scraped?.existing_jsonld ?? [];
        const result = crossCheckJsonld(url, liveJsonld, knownNodes);
        setResults(prev => ({ ...prev, [url]: result }));
        setScanStatus(prev => ({ ...prev, [url]: 'done' }));
      } catch (e) {
        setResults(prev => ({ ...prev, [url]: { url, status: 'no_overlap', conflicts: [], error: String(e) } }));
        setScanStatus(prev => ({ ...prev, [url]: 'error' }));
      }
    });
    await runWithConcurrency(tasks, 3);
  };

  const handleScanSelected = async () => {
    const urls = [...selected];
    if (!urls.length) return;
    setScanning(true);
    await runScanUrls(urls);
    setScanning(false);
  };

  const parsedManualUrls = manualInput
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && /^https?:\/\//.test(l));

  let clientHostname = '';
  try { clientHostname = new URL(client.website_url).hostname; } catch { /* ok */ }
  const offDomain = parsedManualUrls.filter(u => { try { return new URL(u).hostname !== clientHostname; } catch { return true; } });

  const handleScanManual = async () => {
    if (!parsedManualUrls.length || parsedManualUrls.length > 20) return;
    setScanningManual(true);
    await runScanUrls(parsedManualUrls);
    setScanningManual(false);
  };

  const handleCreateProject = async (pageUrl: string) => {
    if (creatingProject) return;
    setCreatingProject(pageUrl);
    const { data } = await supabase
      .from('schema_projects')
      .insert({ client_id: clientId, page_url: pageUrl, schema_types: [], status: 'draft' as const })
      .select()
      .maybeSingle();
    setCreatingProject(null);
    if (data) {
      await onProjectCreated();
      navigate(`/client/${clientId}/project/${data.id}`);
    }
  };

  const resultEntries = Object.values(results);
  const conflictResults = resultEntries.filter(r => r.status === 'conflict');
  const matchResults = resultEntries.filter(r => r.status === 'match');
  const noOverlapResults = resultEntries.filter(r => r.status === 'no_overlap' && !r.error);
  const errorResults = resultEntries.filter(r => r.error);

  const sourceLabel: Record<string, string> = {
    firecrawl_map: 'Firecrawl Map',
    sitemap: 'sitemap.xml',
    sitemap_index: 'Sitemap Index',
  };

  const isScanning = scanning || scanningManual || Object.values(scanStatus).some(s => s === 'scanning');
  const totalSelected = selected.size;

  return (
    <div className="proof-card">
      <div className="px-5 py-3 border-b border-rule flex items-center justify-between gap-3">
        <div>
          <h2 className="section-title">Descubrimiento de sitio completo</h2>
          <p className="text-[10px] font-mono text-ink-muted mt-0.5">
            Encuentra schema en páginas no rastreadas que podría colisionar con proyectos existentes.
          </p>
        </div>
        <button
          onClick={() => setExpanded(v => !v)}
          className="btn-ghost flex items-center gap-1.5 shrink-0"
        >
          <Globe size={13} />
          {expanded ? 'Colapsar' : 'Iniciar descubrimiento'}
          {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
        </button>
      </div>

      {expanded && (
        <div className="p-5 space-y-6">

          {/* ── Path A: Full-site discovery ──────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={handleDiscoverSite}
                disabled={discovering}
                className="btn-primary flex items-center gap-2 shrink-0"
              >
                <RefreshCw size={13} className={discovering ? 'animate-spin' : ''} />
                {discovering ? 'Descubriendo...' : 'Escanear sitio completo'}
              </button>
              {discoveryMeta && (
                <span className="text-[10px] font-mono text-ink-muted">
                  {discoveryMeta.total} páginas encontradas
                  {' · '}fuente: <span className="text-ink">{sourceLabel[discoveryMeta.source] ?? discoveryMeta.source}</span>
                  {discoveryMeta.truncated && <span className="text-amber-600"> · truncado a 200</span>}
                </span>
              )}
            </div>

            {discoveryError && (
              <p className="text-xs font-mono text-red flex items-center gap-1.5">
                <AlertCircle size={12} /> {discoveryError}
              </p>
            )}

            {discoveredPages !== null && discoveredPages.length > 0 && (
              <div className="border border-rule rounded overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-proof border-b border-rule">
                  <span className="text-[10px] font-mono text-ink-muted">
                    {totalSelected} de {discoveredPages.filter(p => !p.hasProject).length} páginas nuevas seleccionadas
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setSelected(new Set(discoveredPages.filter(p => !p.hasProject).map(p => p.url)))}
                      className="text-[10px] font-mono text-blue hover:underline"
                    >
                      Seleccionar todas
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelected(new Set())}
                      className="text-[10px] font-mono text-ink-muted hover:text-ink hover:underline"
                    >
                      Deseleccionar
                    </button>
                  </div>
                </div>
                <div className="max-h-52 overflow-y-auto divide-y divide-rule">
                  {discoveredPages.map(p => (
                    <label
                      key={p.url}
                      className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-proof/60 transition-colors ${p.hasProject ? 'opacity-50 cursor-default' : ''}`}
                    >
                      <input
                        type="checkbox"
                        disabled={p.hasProject}
                        checked={selected.has(p.url)}
                        onChange={e => {
                          setSelected(prev => {
                            const next = new Set(prev);
                            e.target.checked ? next.add(p.url) : next.delete(p.url);
                            return next;
                          });
                        }}
                        className="shrink-0"
                      />
                      <span className="text-xs font-mono text-ink truncate">{urlPath(p.url)}</span>
                      {p.hasProject && (
                        <span className="text-[10px] font-mono text-ink-muted italic shrink-0">ya tiene proyecto</span>
                      )}
                    </label>
                  ))}
                </div>
                <div className="px-3 py-2.5 border-t border-rule flex items-center gap-3 bg-proof/40">
                  <button
                    onClick={handleScanSelected}
                    disabled={scanning || totalSelected === 0}
                    className="btn-primary flex items-center gap-2 text-xs disabled:opacity-50"
                  >
                    <Search size={13} className={scanning ? 'animate-pulse' : ''} />
                    {scanning ? 'Escaneando...' : `Escanear páginas seleccionadas (${totalSelected})`}
                  </button>
                  {totalSelected > 10 && (
                    <span className="text-[10px] font-mono text-ink-muted">
                      {totalSelected} páginas — puede tardar unos minutos
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── Divider ──────────────────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <div className="flex-1 border-t border-rule" />
            <span className="text-[10px] font-mono text-ink-muted px-1">o ingresa URLs manualmente</span>
            <div className="flex-1 border-t border-rule" />
          </div>

          {/* ── Path B: Manual URL entry ──────────────────────────────────────── */}
          <div className="space-y-2">
            <label className="field-label">URLs específicas a revisar (una por línea)</label>
            <textarea
              value={manualInput}
              onChange={e => setManualInput(e.target.value)}
              rows={4}
              placeholder={"https://ejemplo.com/page-1\nhttps://ejemplo.com/page-2"}
              className="input-field w-full font-mono text-xs resize-y"
            />
            {parsedManualUrls.length > 20 && (
              <p className="text-xs font-mono text-red flex items-center gap-1.5">
                <AlertCircle size={12} />
                Máximo 20 URLs por lote — usa el escaneo de sitio completo para más.
              </p>
            )}
            {offDomain.length > 0 && parsedManualUrls.length <= 20 && (
              <p className="text-xs font-mono text-amber-700 flex items-center gap-1.5">
                <AlertTriangle size={12} />
                {offDomain.length} URL{offDomain.length !== 1 ? 's' : ''} fuera del dominio del cliente.
              </p>
            )}
            <button
              onClick={handleScanManual}
              disabled={scanningManual || parsedManualUrls.length === 0 || parsedManualUrls.length > 20}
              className="btn-ghost flex items-center gap-2 disabled:opacity-50"
            >
              <Search size={13} className={scanningManual ? 'animate-pulse' : ''} />
              {scanningManual
                ? 'Verificando...'
                : `Verificar estas URLs (${parsedManualUrls.length})`}
            </button>
          </div>

          {/* ── Results ──────────────────────────────────────────────────────── */}
          {Object.keys(scanStatus).length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono font-semibold text-ink-muted uppercase tracking-wider">
                  Resultados ({Object.keys(scanStatus).length} páginas)
                </p>
                {conflictResults.length > 0 && (
                  <span className="chip chip-red text-[10px]">
                    {conflictResults.length} conflicto{conflictResults.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              <div className="space-y-2">
                {/* Show in order: scanning first, then conflicts, matches, no_overlap, errors */}
                {Object.entries(scanStatus)
                  .sort(([, a], [, b]) => {
                    const order = { scanning: 0, error: 1, done: 2 };
                    return order[a] - order[b];
                  })
                  .map(([url, status]) => {
                    const result = results[url];

                    if (status === 'scanning') {
                      return (
                        <div key={url} className="flex items-center gap-2 px-3 py-2 border border-rule rounded text-xs font-mono text-ink-muted">
                          <RefreshCw size={12} className="animate-spin shrink-0" />
                          <span className="truncate">{urlPath(url)}</span>
                        </div>
                      );
                    }

                    if (!result) return null;

                    if (result.error) {
                      return (
                        <div key={url} className="flex items-center gap-2 px-3 py-2 border border-rule rounded text-xs font-mono text-orange">
                          <AlertCircle size={12} className="shrink-0" />
                          <span className="truncate flex-1">{urlPath(url)}</span>
                          <span className="text-[10px] text-ink-muted truncate max-w-xs">{result.error}</span>
                        </div>
                      );
                    }

                    if (result.status === 'no_overlap') {
                      return (
                        <div key={url} className="flex items-center gap-2 px-3 py-2 border border-rule rounded text-xs font-mono text-ink-muted">
                          <CheckCircle size={12} className="text-ink-muted shrink-0" />
                          <span className="truncate flex-1">{urlPath(url)}</span>
                          <span className="text-[10px] italic">sin coincidencias con proyectos existentes</span>
                        </div>
                      );
                    }

                    if (result.status === 'match') {
                      return (
                        <div key={url} className="flex items-center gap-2 px-3 py-2 border border-rule rounded text-xs font-mono text-green">
                          <CheckCircle size={12} className="shrink-0" />
                          <span className="truncate flex-1">{urlPath(url)}</span>
                          <span className="text-[10px]">Coincide — schema consistente</span>
                        </div>
                      );
                    }

                    // conflict
                    return (
                      <div key={url} className="border border-red/30 rounded overflow-hidden">
                        <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-red/5">
                          <div className="flex items-center gap-2 min-w-0">
                            <AlertCircle size={13} className="text-red shrink-0" />
                            <span className="text-xs font-mono font-semibold text-red uppercase tracking-wider shrink-0">CONFLICTO</span>
                            <span className="text-xs font-mono text-ink truncate">{urlPath(url)}</span>
                          </div>
                          {!allProjects.find(p => p.page_url === url) && (
                            <button
                              onClick={() => handleCreateProject(url)}
                              disabled={!!creatingProject}
                              className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-blue/40 text-blue bg-blue/8 hover:bg-blue/15 transition-colors shrink-0 disabled:opacity-50"
                            >
                              <Plus size={10} />
                              {creatingProject === url ? 'Creando...' : 'Crear proyecto'}
                            </button>
                          )}
                        </div>
                        <div className="divide-y divide-red/10">
                          {result.conflicts.map((c, ci) => (
                            <div key={ci} className="px-3 py-2.5">
                              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                <span className="text-[10px] font-mono text-ink-muted">@id:</span>
                                <span className="text-[10px] font-mono text-ink break-all">{c.id}</span>
                                <span className="text-[10px] font-mono text-ink-muted">·</span>
                                <span className="text-[10px] font-mono text-ink-muted">
                                  colisiona con{' '}
                                  <Link
                                    to={`/client/${clientId}/project/${c.knownProjectId}`}
                                    className="text-blue hover:underline"
                                  >
                                    {urlPath(c.knownPageUrl)}
                                  </Link>
                                </span>
                              </div>
                              <DiffTable diffs={c.diffs} />
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
              </div>

              {/* Summary counts */}
              {!isScanning && resultEntries.length > 0 && (
                <div className="flex items-center gap-4 pt-1 text-[10px] font-mono text-ink-muted">
                  {conflictResults.length > 0 && <span className="text-red">{conflictResults.length} conflicto{conflictResults.length !== 1 ? 's' : ''}</span>}
                  {matchResults.length > 0 && <span className="text-green">{matchResults.length} coincidencia{matchResults.length !== 1 ? 's' : ''}</span>}
                  {noOverlapResults.length > 0 && <span>{noOverlapResults.length} sin coincidencias</span>}
                  {errorResults.length > 0 && <span className="text-orange">{errorResults.length} error{errorResults.length !== 1 ? 'es' : ''}</span>}
                  <button
                    type="button"
                    onClick={() => { setResults({}); setScanStatus({}); }}
                    className="ml-auto hover:text-ink underline"
                  >
                    Limpiar resultados
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function ClientGraphPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [projects, setProjects] = useState<SchemaProject[]>([]);  // validated/delivered with jsonld
  const [allProjects, setAllProjects] = useState<SchemaProject[]>([]); // all statuses
  const [loading, setLoading] = useState(true);

  const [allFlatNodes, setAllFlatNodes] = useState<FlatNode[]>([]);
  const [collisions, setCollisions] = useState<IdCollision[]>([]);
  const [duplicates, setDuplicates] = useState<PossibleDuplicate[]>([]);
  const [orphanedRefs, setOrphanedRefs] = useState<BareRef[]>([]);

  const [liveResults, setLiveResults] = useState<Record<string, LivePageResult>>({});
  const [liveLoading, setLiveLoading] = useState<Record<string, boolean>>({});
  const [liveTimestamp, setLiveTimestamp] = useState<Date | null>(null);
  const [liveRunning, setLiveRunning] = useState(false);
  const [collisionExpanded, setCollisionExpanded] = useState<Record<string, boolean>>({});
  const [liveExpanded, setLiveExpanded] = useState<Record<string, boolean>>({});

  // Adopt actions
  const [adoptModifiedModal, setAdoptModifiedModal] = useState<AdoptModifiedTarget | null>(null);
  const [adoptUnknownModal, setAdoptUnknownModal] = useState<AdoptUnknownTarget | null>(null);
  const [adoptTargetProjectId, setAdoptTargetProjectId] = useState<string>('');
  const [adopting, setAdopting] = useState(false);

  useEffect(() => { loadData(); }, [clientId]);

  const loadData = async () => {
    if (!clientId) return;
    setLoading(true);
    const [{ data: c }, { data: p }] = await Promise.all([
      supabase.from('clients').select('*').eq('id', clientId).maybeSingle(),
      supabase.from('schema_projects').select('*').eq('client_id', clientId).order('created_at', { ascending: true }),
    ]);
    if (c) setClient(c);
    const all = p ?? [];
    setAllProjects(all);
    const validated = all.filter(
      proj => (proj.status === 'validated' || proj.status === 'delivered') && proj.generated_jsonld,
    );
    setProjects(validated);

    const flat: FlatNode[] = [];
    for (const proj of validated) {
      flat.push(...collectTypedNodes(proj.generated_jsonld, proj.page_url, proj.id));
    }
    setAllFlatNodes(flat);
    computeChecks(flat, validated);
    setLoading(false);
  };

  const computeChecks = (flat: FlatNode[], projs: SchemaProject[]) => {
    // @id collisions
    const byId = new Map<string, FlatNode[]>();
    flat.forEach(fn => {
      const id = fn.node['@id'];
      if (typeof id !== 'string') return;
      const arr = byId.get(id) ?? [];
      arr.push(fn);
      byId.set(id, arr);
    });
    const foundCollisions: IdCollision[] = [];
    byId.forEach((entries, id) => {
      if (entries.length < 2) return;
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i], b = entries[j];
          if (a.sourceProjectId === b.sourceProjectId) continue;
          if (!deepEqual(a.node, b.node)) {
            foundCollisions.push({
              id,
              pageA: a.sourcePageUrl, projectIdA: a.sourceProjectId, nodeA: a.node,
              pageB: b.sourcePageUrl, projectIdB: b.sourceProjectId, nodeB: b.node,
              diffs: diffNodes(a.node, b.node),
            });
          }
        }
      }
    });
    setCollisions(foundCollisions);

    // Possible duplicates
    const byType = new Map<string, FlatNode[]>();
    flat.forEach(fn => {
      getNodeTypes(fn.node).forEach(t => {
        const arr = byType.get(t) ?? [];
        arr.push(fn);
        byType.set(t, arr);
      });
    });
    const foundDups: PossibleDuplicate[] = [];
    const seenPairs = new Set<string>();
    byType.forEach((entries, type) => {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i], b = entries[j];
          if (a.sourceProjectId === b.sourceProjectId) continue;
          const aId = a.node['@id'], bId = b.node['@id'];
          if (aId && aId === bId) continue;
          const pairKey = [a.sourceProjectId, b.sourceProjectId].sort().join('|') + '|' + type;
          if (seenPairs.has(pairKey)) continue;
          const aTxt = getSimilarityText(a.node);
          const bTxt = getSimilarityText(b.node);
          if (!aTxt || !bTxt) continue;
          const sim = diceSimilarity(aTxt, bTxt);
          if (sim >= 0.8) {
            seenPairs.add(pairKey);
            foundDups.push({
              type,
              nodeA: a.node, pageA: a.sourcePageUrl, projectIdA: a.sourceProjectId,
              nodeB: b.node, pageB: b.sourcePageUrl, projectIdB: b.sourceProjectId,
              similarity: sim,
            });
          }
        }
      }
    });
    setDuplicates(foundDups);

    // Orphaned references
    const definingIds = new Set<string>(
      flat.map(fn => fn.node['@id']).filter((id): id is string => typeof id === 'string'),
    );
    const allRefs: BareRef[] = [];
    const seenOrphans = new Set<string>();
    projs.forEach(proj => {
      if (proj.generated_jsonld) {
        collectBareRefs(proj.generated_jsonld, proj.page_url, proj.id).forEach(ref => {
          if (!definingIds.has(ref.id)) {
            const k = ref.id + '|' + ref.sourceProjectId;
            if (!seenOrphans.has(k)) { seenOrphans.add(k); allRefs.push(ref); }
          }
        });
      }
    });
    setOrphanedRefs(allRefs);
  };

  const handleLiveCheck = async () => {
    if (!clientId) return;
    setLiveRunning(true);
    setLiveResults({});

    // Build complete set of all @ids known in DB across ALL client projects (any status)
    const allKnownIds = new Set<string>();
    allProjects.forEach(p => {
      if (!p.generated_jsonld) return;
      collectTypedNodes(p.generated_jsonld, '', '').forEach(fn => {
        const id = fn.node['@id'];
        if (typeof id === 'string') allKnownIds.add(id);
      });
    });

    const validProjs = allProjects.filter(
      p => p.page_url && p.generated_jsonld && (p.status === 'validated' || p.status === 'delivered'),
    );
    const initLoading: Record<string, boolean> = {};
    validProjs.forEach(p => { initLoading[p.id] = true; });
    setLiveLoading(initLoading);

    const tasks = validProjs.map(proj => async () => {
      try {
        const { data, error } = await supabase.functions.invoke('scrape-site', { body: { url: proj.page_url } });
        if (error) throw error;
        const liveJsonld = data?.scraped?.existing_jsonld;
        const liveNodes = collectTypedNodes(liveJsonld ?? [], proj.page_url, proj.id);

        // Build liveById for comparison against DB nodes
        const liveById = new Map<string, Record<string, unknown>>();
        liveNodes.forEach(fn => {
          const id = fn.node['@id'];
          if (typeof id === 'string') liveById.set(id, fn.node);
        });

        // Compare DB nodes against live
        const genNodes = collectTypedNodes(proj.generated_jsonld, proj.page_url, proj.id);
        const nodeResults: LiveNodeResult[] = [];
        for (const fn of genNodes) {
          const id = fn.node['@id'];
          if (typeof id !== 'string') continue;
          const live = liveById.get(id);
          if (!live) {
            nodeResults.push({ id, status: 'missing' });
          } else if (deepEqual(fn.node, live)) {
            nodeResults.push({ id, status: 'match' });
          } else {
            nodeResults.push({ id, status: 'modified', diffs: diffNodes(fn.node, live), liveNode: live });
          }
        }

        // Detect untracked live nodes (not known to DB at all)
        const untrackedNodes: UntrackedNode[] = [];
        liveNodes.forEach(fn => {
          const id = fn.node['@id'];
          if (typeof id === 'string') {
            if (!allKnownIds.has(id)) untrackedNodes.push({ node: fn.node, id });
          } else {
            // No @id — anonymous node, always surfaced for visibility
            untrackedNodes.push({ node: fn.node, id: undefined });
          }
        });

        const overallStatus: LiveStatus =
          nodeResults.some(r => r.status === 'missing') ? 'missing'
          : nodeResults.some(r => r.status === 'modified') ? 'modified'
          : 'match';

        setLiveResults(prev => ({
          ...prev,
          [proj.id]: { projectId: proj.id, pageUrl: proj.page_url, overallStatus, nodeResults, untrackedNodes },
        }));
      } catch (e) {
        setLiveResults(prev => ({
          ...prev,
          [proj.id]: { projectId: proj.id, pageUrl: proj.page_url, overallStatus: 'missing', nodeResults: [], untrackedNodes: [], error: String(e) },
        }));
      }
      setLiveLoading(prev => ({ ...prev, [proj.id]: false }));
    });

    await runWithConcurrency(tasks, 3);
    setLiveTimestamp(new Date());
    setLiveRunning(false);
  };

  const openAdoptUnknown = (node: Record<string, unknown>, sourcePageUrl: string) => {
    const defaultProj = allProjects.find(p => p.page_url === sourcePageUrl) ?? allProjects[0];
    setAdoptTargetProjectId(defaultProj?.id ?? '');
    setAdoptUnknownModal({ sourcePageUrl, node });
  };

  const handleAdoptModified = async () => {
    if (!adoptModifiedModal || adopting) return;
    setAdopting(true);
    const { project, nodeId, liveNode } = adoptModifiedModal;

    const newJsonld = replaceNodeById(project.generated_jsonld, nodeId, liveNode);
    const note = adoptionNote(
      'Adoptado desde el sitio en vivo',
      getNodeTypes(liveNode),
      nodeId,
    );
    const newRawData = appendOperatorNote(project.raw_scraped_data, note);

    await supabase.from('schema_projects').update({
      generated_jsonld: newJsonld as Json,
      raw_scraped_data: newRawData as Json,
      status: 'draft',
    }).eq('id', project.id);

    setAdoptModifiedModal(null);
    setAdopting(false);
    await loadData();
    setLiveResults({});
    setLiveTimestamp(null);
  };

  const handleAdoptUnknown = async () => {
    if (!adoptUnknownModal || !adoptTargetProjectId || adopting) return;
    setAdopting(true);
    const { node } = adoptUnknownModal;

    const targetProject = allProjects.find(p => p.id === adoptTargetProjectId);
    if (!targetProject) { setAdopting(false); return; }

    const newJsonld = appendNodeToJsonld(targetProject.generated_jsonld, node);
    const id = typeof node['@id'] === 'string' ? node['@id'] : '(sin @id)';
    const note = adoptionNote('Adoptado desde el sitio en vivo', getNodeTypes(node), id);
    const newRawData = appendOperatorNote(targetProject.raw_scraped_data, note);

    await supabase.from('schema_projects').update({
      generated_jsonld: newJsonld as Json,
      raw_scraped_data: newRawData as Json,
      status: 'draft',
    }).eq('id', targetProject.id);

    setAdoptUnknownModal(null);
    setAdoptTargetProjectId('');
    setAdopting(false);
    await loadData();
    setLiveResults({});
    setLiveTimestamp(null);
  };

  // ── Derived ───────────────────────────────────────────────────────────────────

  const nodesByPage = new Map<string, { project: SchemaProject; nodes: FlatNode[] }>();
  projects.forEach(proj => {
    const nodes = allFlatNodes.filter(fn => fn.sourceProjectId === proj.id);
    nodesByPage.set(proj.id, { project: proj, nodes });
  });

  const totalIssues = collisions.length + duplicates.length + orphanedRefs.length;
  const liveCheckCompleted = liveTimestamp !== null;
  const liveProjectCount = Object.keys(liveResults).length;
  const allMatch = liveCheckCompleted && liveProjectCount > 0 &&
    Object.values(liveResults).every(r => r.overallStatus === 'match' && r.untrackedNodes.length === 0);
  const draftCount = allProjects.filter(p => p.status === 'draft').length;

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto">
        <div className="py-16 text-center text-xs font-mono text-ink-muted">Cargando datos del cliente...</div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs font-mono text-ink-muted">
        <button onClick={() => navigate('/')} className="hover:text-ink flex items-center gap-1">
          <ArrowLeft size={12} /> Clientes
        </button>
        <span>/</span>
        <button onClick={() => navigate(`/client/${clientId}`)} className="hover:text-ink">
          {client?.name ?? '...'}
        </button>
        <span>/</span>
        <span className="text-ink">Vista consolidada</span>
      </div>

      {/* Header */}
      <div className="proof-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-ink mb-0.5">Vista consolidada del cliente</h1>
            <p className="text-xs font-mono text-ink-muted">
              Incluye proyectos validados y entregados.
              {draftCount > 0 && ` ${draftCount} proyecto${draftCount !== 1 ? 's' : ''} en borrador excluido${draftCount !== 1 ? 's' : ''}.`}
              {' · '}
              {projects.length} página{projects.length !== 1 ? 's' : ''}
              {' · '}
              {allFlatNodes.length} nodo{allFlatNodes.length !== 1 ? 's' : ''} schema
            </p>
          </div>
          <button
            onClick={() => navigate(`/client/${clientId}`)}
            className="btn-ghost flex items-center gap-1.5 shrink-0"
          >
            <ArrowLeft size={13} /> Volver
          </button>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="proof-card p-10 text-center">
          <p className="text-xs font-mono text-ink-muted">
            No hay proyectos validados o entregados para este cliente.
          </p>
          <Link to={`/client/${clientId}`} className="btn-primary inline-flex mt-4 text-xs">
            Ir a proyectos
          </Link>
        </div>
      ) : (
        <>
          {/* ── Section 1: Site map ──────────────────────────────────────────── */}
          <div className="proof-card">
            <div className="px-5 py-3 border-b border-rule">
              <h2 className="section-title">Mapa del sitio</h2>
            </div>
            <div className="divide-y divide-rule">
              {Array.from(nodesByPage.values()).map(({ project: proj, nodes }) => {
                const types = Array.from(new Set(nodes.flatMap(fn => getNodeTypes(fn.node))));
                const isRefOnly = nodes.length === 0;
                return (
                  <div key={proj.id} className="px-5 py-3.5 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <span className="font-mono text-sm text-ink font-medium">{urlPath(proj.page_url)}</span>
                        <span className={`chip ${proj.status === 'delivered' ? 'chip-green' : 'chip-blue'} text-[10px]`}>
                          {proj.status === 'delivered' ? 'Entregado' : 'Validado'}
                        </span>
                      </div>
                      <p className="text-[10px] font-mono text-ink-muted truncate">{proj.page_url}</p>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {isRefOnly ? (
                          <span className="chip chip-ink text-[10px]">Solo referencias</span>
                        ) : (
                          types.map(t => (
                            <span key={t} className="chip chip-ink text-[10px]">{t}</span>
                          ))
                        )}
                      </div>
                    </div>
                    <Link
                      to={`/client/${clientId}/project/${proj.id}`}
                      className="shrink-0 text-xs font-mono text-blue hover:underline flex items-center gap-1"
                    >
                      Editar <ExternalLink size={10} />
                    </Link>
                  </div>
                );
              })}
            </div>
          </div>

          {/* ── Section 2: Cross-page consistency ───────────────────────────── */}
          <div className="proof-card">
            <div className="px-5 py-3 border-b border-rule flex items-center justify-between">
              <h2 className="section-title">Consistencia entre páginas</h2>
              {totalIssues > 0 && (
                <span className="chip chip-red text-[10px]">
                  {totalIssues} problema{totalIssues !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {totalIssues === 0 ? (
              <div className="flex items-center gap-2.5 px-5 py-5">
                <CheckCircle size={15} className="text-green shrink-0" />
                <span className="text-sm font-mono text-green">Sin conflictos ni duplicados entre páginas</span>
              </div>
            ) : (
              <div className="divide-y divide-rule">
                {collisions.map((col, idx) => {
                  const key = `col-${idx}`;
                  const expanded = !!collisionExpanded[key];
                  return (
                    <div key={key} className="p-5">
                      <div className="flex items-start gap-3">
                        <AlertCircle size={14} className="text-red shrink-0 mt-0.5" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold text-red uppercase tracking-wider">CONFLICTO @id</span>
                          </div>
                          <p className="text-xs font-mono text-ink mb-1 break-all">
                            <span className="text-ink-muted">@id: </span>{col.id}
                          </p>
                          <div className="text-xs font-mono text-ink-muted space-y-0.5 mb-2">
                            <p>
                              Página A:{' '}
                              <Link to={`/client/${clientId}/project/${col.projectIdA}`} className="text-blue hover:underline">
                                {urlPath(col.pageA)}
                              </Link>
                            </p>
                            <p>
                              Página B:{' '}
                              <Link to={`/client/${clientId}/project/${col.projectIdB}`} className="text-blue hover:underline">
                                {urlPath(col.pageB)}
                              </Link>
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => setCollisionExpanded(prev => ({ ...prev, [key]: !expanded }))}
                            className="flex items-center gap-1.5 text-xs font-mono text-ink-muted hover:text-ink"
                          >
                            {expanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                            {col.diffs.length} campo{col.diffs.length !== 1 ? 's' : ''} difieren
                          </button>
                          {expanded && <IdDiffTable diffs={col.diffs} />}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {duplicates.map((dup, idx) => (
                  <div key={`dup-${idx}`} className="p-5">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-amber-700 uppercase tracking-wider">POSIBLE DUPLICADO</span>
                          <span className="chip text-[10px] bg-amber-50 text-amber-700 border border-amber-200">{dup.type}</span>
                          <span className="text-[10px] font-mono text-ink-muted">
                            similitud {(dup.similarity * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="text-xs font-mono space-y-1 text-ink-muted">
                          <p>
                            <span className="text-ink">A</span> {formatVal(dup.nodeA['name'] ?? dup.nodeA['@id'])}{' '}
                            <span className="text-[10px]">·</span>{' '}
                            <Link to={`/client/${clientId}/project/${dup.projectIdA}`} className="text-blue hover:underline">
                              {urlPath(dup.pageA)}
                            </Link>
                          </p>
                          <p>
                            <span className="text-ink">B</span> {formatVal(dup.nodeB['name'] ?? dup.nodeB['@id'])}{' '}
                            <span className="text-[10px]">·</span>{' '}
                            <Link to={`/client/${clientId}/project/${dup.projectIdB}`} className="text-blue hover:underline">
                              {urlPath(dup.pageB)}
                            </Link>
                          </p>
                        </div>
                        <p className="text-[10px] font-mono text-ink-muted mt-1.5">
                          Considera consolidar en un nodo canónico y referenciar con @id.
                        </p>
                      </div>
                    </div>
                  </div>
                ))}

                {orphanedRefs.map((ref, idx) => (
                  <div key={`orphan-${idx}`} className="p-5">
                    <div className="flex items-start gap-3">
                      <AlertCircle size={14} className="text-red shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-red uppercase tracking-wider">REFERENCIA ROTA</span>
                        </div>
                        <p className="text-xs font-mono text-ink-muted mb-0.5">
                          <span className="text-ink">Página:</span>{' '}
                          <Link to={`/client/${clientId}/project/${ref.sourceProjectId}`} className="text-blue hover:underline">
                            {urlPath(ref.sourcePageUrl)}
                          </Link>
                          {ref.inField !== 'root' && (
                            <span> · campo <span className="text-ink">{ref.inField}</span></span>
                          )}
                        </p>
                        <p className="text-xs font-mono text-ink-muted break-all">
                          <span className="text-ink">@id sin definición: </span>{ref.id}
                        </p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Section 3: Live drift ────────────────────────────────────────── */}
          <div className="proof-card">
            <div className="px-5 py-3 border-b border-rule flex items-center justify-between gap-3">
              <div>
                <h2 className="section-title">Verificación en vivo</h2>
                {liveTimestamp && (
                  <p className="text-[10px] font-mono text-ink-muted mt-0.5">
                    Última verificación: {liveTimestamp.toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}
                  </p>
                )}
              </div>
              <button
                onClick={handleLiveCheck}
                disabled={liveRunning}
                className="btn-primary flex items-center gap-2 shrink-0"
              >
                <RefreshCw size={13} className={liveRunning ? 'animate-spin' : ''} />
                {liveRunning ? 'Verificando...' : 'Verificar en vivo'}
              </button>
            </div>

            {!liveCheckCompleted && !liveRunning && (
              <div className="px-5 py-6 text-center text-xs font-mono text-ink-muted">
                Haz clic en "Verificar en vivo" para comparar el schema guardado con el que está publicado en cada página.
              </div>
            )}

            {(liveRunning || liveCheckCompleted) && (
              <div className="divide-y divide-rule">
                {allMatch && !liveRunning && (
                  <div className="flex items-center gap-2.5 px-5 py-5">
                    <CheckCircle size={15} className="text-green shrink-0" />
                    <span className="text-sm font-mono text-green">Todo el schema en vivo coincide con lo generado. Sin nodos desconocidos.</span>
                  </div>
                )}

                {allProjects
                  .filter(p => p.page_url && p.generated_jsonld && (p.status === 'validated' || p.status === 'delivered'))
                  .map(proj => {
                    const result = liveResults[proj.id];
                    const isLoading = !!liveLoading[proj.id];
                    const isExpanded = !!liveExpanded[proj.id];

                    if (!isLoading && !result) return null;

                    const statusConfig: Record<LiveStatus, { label: string; cls: string; icon: React.ReactNode }> = {
                      match: {
                        label: '✓ Coincide',
                        cls: 'text-green',
                        icon: <CheckCircle size={14} className="text-green shrink-0" />,
                      },
                      modified: {
                        label: '⚠ Modificado en vivo',
                        cls: 'text-amber-700',
                        icon: <AlertTriangle size={14} className="text-amber-600 shrink-0" />,
                      },
                      missing: {
                        label: '✗ No encontrado',
                        cls: 'text-red',
                        icon: <AlertCircle size={14} className="text-red shrink-0" />,
                      },
                    };

                    const hasUntracked = result && result.untrackedNodes.length > 0;
                    const nonMatchNodes = result?.nodeResults.filter(r => r.status !== 'match') ?? [];

                    return (
                      <div key={proj.id} className="p-5">
                        <div className="flex items-start gap-3">
                          {isLoading ? (
                            <RefreshCw size={14} className="text-ink-muted shrink-0 mt-0.5 animate-spin" />
                          ) : result ? (
                            hasUntracked && result.overallStatus === 'match'
                              ? <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                              : statusConfig[result.overallStatus].icon
                          ) : null}

                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-0.5">
                              <span className="text-xs font-mono font-medium text-ink">{urlPath(proj.page_url)}</span>
                              {!isLoading && result && (
                                <span className={`text-xs font-mono font-semibold ${statusConfig[result.overallStatus].cls}`}>
                                  {statusConfig[result.overallStatus].label}
                                </span>
                              )}
                              {isLoading && (
                                <span className="text-xs font-mono text-ink-muted">Escaneando...</span>
                              )}
                            </div>
                            <p className="text-[10px] font-mono text-ink-muted">{proj.page_url}</p>

                            {!isLoading && result?.error && (
                              <p className="text-xs font-mono text-red mt-1">{result.error}</p>
                            )}

                            {/* Known-node diffs (modified / missing) */}
                            {!isLoading && result && !result.error && nonMatchNodes.length > 0 && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setLiveExpanded(prev => ({ ...prev, [proj.id]: !isExpanded }))}
                                  className="flex items-center gap-1.5 text-xs font-mono text-ink-muted hover:text-ink mt-1.5"
                                >
                                  {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                  {nonMatchNodes.length} nodo{nonMatchNodes.length !== 1 ? 's' : ''} con diferencias
                                </button>
                                {isExpanded && (
                                  <div className="mt-2 space-y-4">
                                    {nonMatchNodes.map(nr => (
                                      <div key={nr.id} className="border border-rule rounded p-3">
                                        <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                                          <div className="flex items-center gap-2">
                                            <span className={`text-[10px] font-mono font-semibold uppercase tracking-wider ${nr.status === 'missing' ? 'text-red' : 'text-amber-700'}`}>
                                              {nr.status === 'missing' ? 'No encontrado' : 'Modificado'}
                                            </span>
                                            <span className="text-[10px] font-mono text-ink-muted break-all">{nr.id}</span>
                                          </div>
                                          {nr.status === 'modified' && nr.liveNode && (
                                            <button
                                              type="button"
                                              onClick={() => setAdoptModifiedModal({
                                                projectId: proj.id,
                                                project: allProjects.find(p => p.id === proj.id)!,
                                                nodeId: nr.id,
                                                liveNode: nr.liveNode!,
                                                diffs: nr.diffs ?? [],
                                              })}
                                              className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-blue/40 text-blue bg-blue/8 hover:bg-blue/15 transition-colors shrink-0"
                                            >
                                              <Download size={10} />
                                              Adoptar versión en vivo
                                            </button>
                                          )}
                                        </div>
                                        {nr.diffs && nr.diffs.length > 0 && <DiffTable diffs={nr.diffs} />}
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </>
                            )}

                            {/* Untracked live nodes */}
                            {!isLoading && hasUntracked && (
                              <div className="mt-3 border border-amber-200 rounded overflow-hidden">
                                <div className="bg-amber-50 px-3 py-2 border-b border-amber-200">
                                  <p className="text-[10px] font-mono font-semibold text-amber-700 uppercase tracking-wider">
                                    Nodos no rastreados en vivo ({result!.untrackedNodes.length})
                                  </p>
                                  <p className="text-[10px] font-mono text-amber-600 mt-0.5">
                                    Estos nodos existen en el sitio pero no fueron generados por SchemaForge — pueden venir de un plugin, edición manual, u otro origen.
                                  </p>
                                </div>
                                <div className="divide-y divide-amber-100 bg-white">
                                  {result!.untrackedNodes.map((un, uidx) => {
                                    const types = getNodeTypes(un.node);
                                    const summary = nodeSummary(un.node);
                                    return (
                                      <div key={uidx} className="px-3 py-2.5 flex items-center justify-between gap-3">
                                        <div className="min-w-0 flex-1">
                                          <div className="flex items-center gap-1.5 flex-wrap">
                                            <span className="text-[10px] font-mono font-semibold text-amber-700 uppercase tracking-wider">
                                              {types.length > 0 ? types.join(' / ') : '(sin @type)'}
                                            </span>
                                            {un.id
                                              ? <span className="text-[10px] font-mono text-ink-muted truncate">{un.id}</span>
                                              : <span className="text-[10px] font-mono text-ink-muted italic">sin @id</span>
                                            }
                                          </div>
                                          {summary && (
                                            <p className="text-[10px] font-mono text-ink-muted mt-0.5 truncate">{summary}</p>
                                          )}
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => openAdoptUnknown(un.node, proj.page_url)}
                                          className="flex items-center gap-1 text-[10px] font-mono px-2 py-1 rounded border border-amber-300 text-amber-700 bg-amber-50 hover:bg-amber-100 transition-colors shrink-0"
                                        >
                                          <Download size={10} />
                                          Adoptar versión en vivo
                                        </button>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>

                          <Link
                            to={`/client/${clientId}/project/${proj.id}`}
                            className="shrink-0 text-xs font-mono text-blue hover:underline flex items-center gap-1"
                          >
                            Editar <ExternalLink size={10} />
                          </Link>
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* ── Section 4: Site discovery ────────────────────────────────────── */}
          {client && (
            <SiteDiscoverySection
              clientId={clientId!}
              client={client}
              allProjects={allProjects}
              onProjectCreated={loadData}
            />
          )}
        </>
      )}

      {/* ── Adopt-modified modal ─────────────────────────────────────────────── */}
      {adoptModifiedModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-rule rounded w-full max-w-xl max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rule shrink-0">
              <h2 className="font-semibold text-ink text-sm">Adoptar versión en vivo</h2>
              <button onClick={() => setAdoptModifiedModal(null)} className="text-ink-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              <div className="bg-proof rounded px-3 py-2">
                <p className="text-[10px] font-mono text-ink-muted mb-0.5">Nodo</p>
                <p className="text-xs font-mono text-ink break-all">{adoptModifiedModal.nodeId}</p>
              </div>

              <div>
                <p className="text-[10px] font-mono font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Diferencias detectadas</p>
                <DiffTable diffs={adoptModifiedModal.diffs} />
              </div>

              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-3">
                <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs font-mono text-amber-700">
                  Esto reemplazará el contenido guardado con lo que existe actualmente en el sitio.
                  El proyecto se marcará como borrador para revalidar.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-rule shrink-0">
              <button onClick={() => setAdoptModifiedModal(null)} className="btn-ghost">Cancelar</button>
              <button
                onClick={handleAdoptModified}
                disabled={adopting}
                className="btn-primary flex items-center gap-1.5"
              >
                <Download size={13} />
                {adopting ? 'Adoptando...' : 'Adoptar versión en vivo'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Adopt-unknown modal ──────────────────────────────────────────────── */}
      {adoptUnknownModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-rule rounded w-full max-w-lg max-h-[85vh] flex flex-col">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rule shrink-0">
              <h2 className="font-semibold text-ink text-sm">Adoptar nodo desconocido</h2>
              <button onClick={() => setAdoptUnknownModal(null)} className="text-ink-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4 overflow-y-auto flex-1">
              {/* Node preview */}
              <div>
                <p className="text-[10px] font-mono font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Nodo detectado</p>
                <div className="bg-proof rounded px-3 py-2 space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-ink-muted">@type:</span>
                    <span className="text-xs font-mono text-ink">
                      {getNodeTypes(adoptUnknownModal.node).join(' / ') || '—'}
                    </span>
                  </div>
                  {typeof adoptUnknownModal.node['@id'] === 'string' && (
                    <div className="flex items-start gap-2">
                      <span className="text-[10px] font-mono text-ink-muted shrink-0">@id:</span>
                      <span className="text-xs font-mono text-ink break-all">{adoptUnknownModal.node['@id'] as string}</span>
                    </div>
                  )}
                  {nodeSummary(adoptUnknownModal.node) && (
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-mono text-ink-muted">nombre:</span>
                      <span className="text-xs font-mono text-ink truncate">{nodeSummary(adoptUnknownModal.node)}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Project selector */}
              <div>
                <label className="field-label">Agregar a proyecto</label>
                <select
                  value={adoptTargetProjectId}
                  onChange={e => setAdoptTargetProjectId(e.target.value)}
                  className="input-field w-full font-mono text-sm"
                >
                  {allProjects.length === 0 && (
                    <option value="">Sin proyectos disponibles</option>
                  )}
                  {allProjects.map(p => (
                    <option key={p.id} value={p.id}>
                      {urlPath(p.page_url)} — {p.status === 'draft' ? 'Borrador' : p.status === 'validated' ? 'Validado' : 'Entregado'}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] font-mono text-ink-muted mt-1">
                  El nodo se añadirá al JSON-LD del proyecto seleccionado y se marcará como borrador.
                </p>
              </div>

              <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-3">
                <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                <p className="text-xs font-mono text-amber-700">
                  Este nodo no fue generado por SchemaForge. Verifica su contenido antes de validarlo.
                </p>
              </div>
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-rule shrink-0">
              <button onClick={() => setAdoptUnknownModal(null)} className="btn-ghost">Cancelar</button>
              <button
                onClick={handleAdoptUnknown}
                disabled={adopting || !adoptTargetProjectId}
                className="btn-primary flex items-center gap-1.5 disabled:opacity-50"
              >
                <Download size={13} />
                {adopting ? 'Adoptando...' : 'Adoptar nodo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
