import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, SchemaProject } from '../lib/database.types';
import {
  ArrowLeft, CheckCircle, AlertTriangle, AlertCircle,
  RefreshCw, ExternalLink, ChevronDown, ChevronUp,
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
}

interface LivePageResult {
  projectId: string;
  pageUrl: string;
  overallStatus: LiveStatus;
  nodeResults: LiveNodeResult[];
  error?: string;
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

// ── Main component ────────────────────────────────────────────────────────────

export default function ClientGraphPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [projects, setProjects] = useState<SchemaProject[]>([]);  // validated/delivered with jsonld
  const [allProjects, setAllProjects] = useState<SchemaProject[]>([]); // all projects for live check
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

    const validProjs = allProjects.filter(p => p.page_url && p.generated_jsonld);
    const initLoading: Record<string, boolean> = {};
    validProjs.forEach(p => { initLoading[p.id] = true; });
    setLiveLoading(initLoading);

    const tasks = validProjs.map(proj => async () => {
      try {
        const { data, error } = await supabase.functions.invoke('scrape-site', { body: { url: proj.page_url } });
        if (error) throw error;
        const liveJsonld = data?.scraped?.existing_jsonld;
        const liveNodes = collectTypedNodes(liveJsonld ?? [], proj.page_url, proj.id);
        const liveById = new Map<string, Record<string, unknown>>();
        liveNodes.forEach(fn => {
          const id = fn.node['@id'];
          if (typeof id === 'string') liveById.set(id, fn.node);
        });

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
            nodeResults.push({ id, status: 'modified', diffs: diffNodes(fn.node, live) });
          }
        }

        const overallStatus: LiveStatus =
          nodeResults.some(r => r.status === 'missing') ? 'missing'
          : nodeResults.some(r => r.status === 'modified') ? 'modified'
          : 'match';

        setLiveResults(prev => ({
          ...prev,
          [proj.id]: { projectId: proj.id, pageUrl: proj.page_url, overallStatus, nodeResults },
        }));
      } catch (e) {
        setLiveResults(prev => ({
          ...prev,
          [proj.id]: { projectId: proj.id, pageUrl: proj.page_url, overallStatus: 'missing', nodeResults: [], error: String(e) },
        }));
      }
      setLiveLoading(prev => ({ ...prev, [proj.id]: false }));
    });

    await runWithConcurrency(tasks, 3);
    setLiveTimestamp(new Date());
    setLiveRunning(false);
  };

  // Group flat nodes by page
  const nodesByPage = new Map<string, { project: SchemaProject; nodes: FlatNode[] }>();
  projects.forEach(proj => {
    const nodes = allFlatNodes.filter(fn => fn.sourceProjectId === proj.id);
    nodesByPage.set(proj.id, { project: proj, nodes });
  });

  const totalIssues = collisions.length + duplicates.length + orphanedRefs.length;
  const liveCheckCompleted = liveTimestamp !== null;
  const liveProjectCount = Object.keys(liveResults).length;
  const allMatch = liveCheckCompleted && liveProjectCount > 0 && Object.values(liveResults).every(r => r.overallStatus === 'match');

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
              {projects.length} página{projects.length !== 1 ? 's' : ''} validada{projects.length !== 1 ? 's' : ''}
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

                {/* @id collisions */}
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

                {/* Possible duplicates */}
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

                {/* Orphaned references */}
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
                    <span className="text-sm font-mono text-green">Todo el schema en vivo coincide con lo generado.</span>
                  </div>
                )}

                {allProjects
                  .filter(p => p.page_url && p.generated_jsonld)
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

                    return (
                      <div key={proj.id} className="p-5">
                        <div className="flex items-start gap-3">
                          {isLoading ? (
                            <RefreshCw size={14} className="text-ink-muted shrink-0 mt-0.5 animate-spin" />
                          ) : result ? (
                            statusConfig[result.overallStatus].icon
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

                            {!isLoading && result && !result.error && result.nodeResults.length > 0 && result.overallStatus !== 'match' && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setLiveExpanded(prev => ({ ...prev, [proj.id]: !isExpanded }))}
                                  className="flex items-center gap-1.5 text-xs font-mono text-ink-muted hover:text-ink mt-1.5"
                                >
                                  {isExpanded ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                                  {result.nodeResults.filter(r => r.status !== 'match').length} nodo{result.nodeResults.filter(r => r.status !== 'match').length !== 1 ? 's' : ''} con diferencias
                                </button>
                                {isExpanded && (
                                  <div className="mt-2 space-y-3">
                                    {result.nodeResults
                                      .filter(r => r.status !== 'match')
                                      .map(nr => (
                                        <div key={nr.id}>
                                          <div className="flex items-center gap-2 mb-1">
                                            <span className={`text-[10px] font-mono font-semibold uppercase tracking-wider ${nr.status === 'missing' ? 'text-red' : 'text-amber-700'}`}>
                                              {nr.status === 'missing' ? 'No encontrado' : 'Modificado'}
                                            </span>
                                            <span className="text-[10px] font-mono text-ink-muted break-all">{nr.id}</span>
                                          </div>
                                          {nr.diffs && nr.diffs.length > 0 && <DiffTable diffs={nr.diffs} />}
                                        </div>
                                      ))}
                                  </div>
                                )}
                              </>
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
        </>
      )}
    </div>
  );
}
