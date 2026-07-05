import { useEffect, useState, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, SchemaProject } from '../lib/database.types';
import { ArrowLeft, Plus, X, AlertTriangle, AlertCircle, ExternalLink, Trash2 } from 'lucide-react';

const STATUS_CHIP: Record<string, string> = {
  draft: 'chip-orange',
  validated: 'chip-blue',
  delivered: 'chip-green',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Borrador',
  validated: 'Validado',
  delivered: 'Entregado',
};

function urlPath(url: string): string {
  try {
    const { pathname, search } = new URL(url);
    return (pathname || '/') + search;
  } catch {
    return url;
  }
}

function sameDomain(a: string, b: string): boolean {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return false;
  }
}

// ── Orphan-reference helpers ──────────────────────────────────────────────────

function collectDefinedIds(jsonld: unknown): string[] {
  const ids: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const obj = v as Record<string, unknown>;
    if (obj['@type'] && typeof obj['@id'] === 'string') ids.push(obj['@id']);
    for (const [k, val] of Object.entries(obj)) {
      if (!k.startsWith('_')) walk(val);
    }
  };
  walk(jsonld);
  return ids;
}

function collectBareRefIds(jsonld: unknown): string[] {
  const ids: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const obj = v as Record<string, unknown>;
    if (typeof obj['@id'] === 'string' && !obj['@type']) ids.push(obj['@id']);
    for (const [k, val] of Object.entries(obj)) {
      if (!k.startsWith('_')) walk(val);
    }
  };
  walk(jsonld);
  return ids;
}

interface OrphanBlock {
  projectId: string;
  pageUrl: string;
  referencingPages: string[];
}

function checkOrphanImpact(
  toDelete: SchemaProject[],
  allClientProjects: SchemaProject[],
): { blocked: OrphanBlock[]; safe: SchemaProject[] } {
  const toDeleteIds = new Set(toDelete.map(p => p.id));
  const blocked: OrphanBlock[] = [];
  const safe: SchemaProject[] = [];

  for (const proj of toDelete) {
    if (!proj.generated_jsonld) { safe.push(proj); continue; }
    const definedIds = new Set(collectDefinedIds(proj.generated_jsonld));
    if (definedIds.size === 0) { safe.push(proj); continue; }

    const referencingPages: string[] = [];
    for (const other of allClientProjects) {
      if (toDeleteIds.has(other.id)) continue; // also being deleted — skip
      if (!other.generated_jsonld) continue;
      const bareRefs = collectBareRefIds(other.generated_jsonld);
      if (bareRefs.some(id => definedIds.has(id))) {
        referencingPages.push(other.page_url);
      }
    }

    if (referencingPages.length > 0) {
      blocked.push({ projectId: proj.id, pageUrl: proj.page_url, referencingPages });
    } else {
      safe.push(proj);
    }
  }

  return { blocked, safe };
}

// ── Component ─────────────────────────────────────────────────────────────────

interface DeleteModal {
  mode: 'single' | 'bulk';
  candidates: SchemaProject[];
  blocked: OrphanBlock[];
  safe: SchemaProject[];
}

export default function ClientDetailPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [projects, setProjects] = useState<SchemaProject[]>([]);
  const [loading, setLoading] = useState(true);

  // New project modal
  const [showModal, setShowModal] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [domainWarning, setDomainWarning] = useState(false);
  const [duplicate, setDuplicate] = useState<SchemaProject | null>(null);
  const [checkingDup, setCheckingDup] = useState(false);
  const dupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Selection + delete
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleteModal, setDeleteModal] = useState<DeleteModal | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadData = async () => {
    if (!clientId) return;
    setLoading(true);
    const { data: c } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (c) setClient(c);

    const { data: p } = await supabase
      .from('schema_projects')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false });
    setProjects(p ?? []);
    setLoading(false);
  };

  useEffect(() => { loadData(); }, [clientId]);

  const openModal = () => {
    setNewUrl(client?.website_url ?? '');
    setDomainWarning(false);
    setDuplicate(null);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
  };

  const handleUrlChange = (val: string) => {
    setNewUrl(val);
    if (client) {
      setDomainWarning(val.length > 8 && !sameDomain(client.website_url, val));
    }
    if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
    setDuplicate(null);
    if (!val || !clientId) return;
    dupTimerRef.current = setTimeout(async () => {
      setCheckingDup(true);
      const { data } = await supabase
        .from('schema_projects')
        .select('*')
        .eq('client_id', clientId)
        .eq('page_url', val)
        .limit(1)
        .maybeSingle();
      setDuplicate(data ?? null);
      setCheckingDup(false);
    }, 500);
  };

  const handleConfirm = () => {
    if (!newUrl.trim() || !clientId) return;
    closeModal();
    navigate(`/client/${clientId}/project/new?url=${encodeURIComponent(newUrl.trim())}`);
  };

  // ── Selection ───────────────────────────────────────────────────────────────

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const allSelected = projects.length > 0 && selectedIds.size === projects.length;
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(projects.map(p => p.id)));
    }
  };

  // ── Delete ──────────────────────────────────────────────────────────────────

  const initiateDelete = (candidates: SchemaProject[]) => {
    const { blocked, safe } = checkOrphanImpact(candidates, projects);
    setDeleteModal({ mode: candidates.length === 1 ? 'single' : 'bulk', candidates, blocked, safe });
  };

  const executeDelete = async () => {
    if (!deleteModal || deleteModal.safe.length === 0) return;
    setDeleting(true);
    const ids = deleteModal.safe.map(p => p.id);
    await supabase.from('schema_projects').delete().in('id', ids);
    setDeleteModal(null);
    setSelectedIds(new Set());
    await loadData();
    setDeleting(false);
  };

  const selectedProjects = projects.filter(p => selectedIds.has(p.id));

  return (
    <div className="max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-5 text-xs font-mono text-ink-muted">
        <button onClick={() => navigate('/')} className="hover:text-ink flex items-center gap-1">
          <ArrowLeft size={12} />
          Clientes
        </button>
        <span>/</span>
        <span className="text-ink">{client?.name ?? '...'}</span>
      </div>

      {/* Client header */}
      {client && (
        <div className="proof-card p-5 mb-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-ink mb-0.5">{client.name}</h1>
              <a
                href={client.website_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono text-blue hover:underline flex items-center gap-1"
              >
                {client.website_url}
                <ExternalLink size={10} />
              </a>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Link to={`/client/${client.id}/graph`} className="btn-ghost text-xs py-1 px-2">
                Consolidado
              </Link>
              <Link to={`/client/${client.id}/geo`} className="btn-ghost text-xs py-1 px-2">
                GEO
              </Link>
              <button onClick={openModal} className="btn-primary flex items-center gap-1.5 text-xs py-1.5 px-3">
                <Plus size={13} />
                Nuevo proyecto
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Projects list */}
      <div className="proof-card">
        {/* List header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-rule">
          <div className="flex items-center gap-3">
            {projects.length > 0 && (
              <input
                type="checkbox"
                checked={allSelected}
                ref={el => { if (el) el.indeterminate = someSelected; }}
                onChange={toggleSelectAll}
                className="w-3.5 h-3.5 rounded border-rule accent-ink cursor-pointer"
                title="Seleccionar todos"
              />
            )}
            <h2 className="section-title">Proyectos de schema</h2>
          </div>
          <div className="flex items-center gap-3">
            {selectedIds.size > 0 && (
              <button
                onClick={() => initiateDelete(selectedProjects)}
                className="flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded border border-red-300 text-red-700 bg-red-50 hover:bg-red-100 transition-colors"
              >
                <Trash2 size={12} />
                Eliminar seleccionados ({selectedIds.size})
              </button>
            )}
            <span className="text-xs font-mono text-ink-muted">
              {projects.length} proyecto{projects.length !== 1 ? 's' : ''}
            </span>
          </div>
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs font-mono text-ink-muted">Cargando...</div>
        ) : projects.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-xs font-mono text-ink-muted mb-3">Sin proyectos aún.</p>
            <button onClick={openModal} className="btn-primary flex items-center gap-1.5 mx-auto text-xs">
              <Plus size={13} />
              Crear primer proyecto
            </button>
          </div>
        ) : (
          <div className="divide-y divide-rule">
            {projects.map(proj => (
              <div
                key={proj.id}
                className={`flex items-center hover:bg-proof transition-colors ${selectedIds.has(proj.id) ? 'bg-blue-50 hover:bg-blue-50' : ''}`}
              >
                {/* Checkbox */}
                <label
                  className="flex items-center pl-5 pr-2 py-3.5 cursor-pointer shrink-0"
                  onClick={e => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(proj.id)}
                    onChange={() => toggleSelect(proj.id)}
                    className="w-3.5 h-3.5 rounded border-rule accent-ink cursor-pointer"
                  />
                </label>

                {/* Main link */}
                <Link
                  to={`/client/${clientId}/project/${proj.id}`}
                  className="flex-1 flex items-center gap-3 pr-3 py-3.5 min-w-0 group"
                >
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-sm text-ink font-medium group-hover:text-blue transition-colors truncate block">
                      {urlPath(proj.page_url)}
                    </span>
                    <span className="text-[10px] font-mono text-ink-muted truncate block">
                      {proj.page_url}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {proj.schema_types.length > 0 && (
                      <span className="text-xs font-mono text-ink-muted hidden sm:block">
                        {proj.schema_types.join(' + ')}
                      </span>
                    )}
                    <span className={`chip ${STATUS_CHIP[proj.status] ?? 'chip-ink'}`}>
                      {STATUS_LABEL[proj.status] ?? proj.status}
                    </span>
                    <span className="text-xs font-mono text-ink-muted">
                      {new Date(proj.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: '2-digit' })}
                    </span>
                  </div>
                </Link>

                {/* Delete button */}
                <button
                  onClick={e => { e.preventDefault(); e.stopPropagation(); initiateDelete([proj]); }}
                  className="px-4 py-3.5 text-ink-muted hover:text-red-600 transition-colors shrink-0"
                  title="Eliminar proyecto"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* New project modal */}
      {showModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-rule rounded w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rule">
              <h2 className="font-semibold text-ink text-sm">Nuevo proyecto</h2>
              <button onClick={closeModal} className="text-ink-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div>
                <label className="field-label">URL de la página a auditar</label>
                <input
                  type="url"
                  value={newUrl}
                  onChange={e => handleUrlChange(e.target.value)}
                  className="input-field w-full font-mono text-sm"
                  placeholder="https://ejemplo.com/contacto"
                  autoFocus
                />
                <p className="text-[10px] font-mono text-ink-muted mt-1">
                  Puedes editar la URL base para apuntar a una página específica, p. ej.{' '}
                  <span className="text-ink">/contacto</span>
                </p>
              </div>

              {domainWarning && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-2.5">
                  <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-xs font-mono text-amber-700">
                    La URL es de un dominio diferente al del cliente. Puedes continuar si es intencional.
                  </p>
                </div>
              )}

              {checkingDup && (
                <p className="text-xs font-mono text-ink-muted">Verificando duplicados...</p>
              )}

              {duplicate && !checkingDup && (
                <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded p-2.5">
                  <AlertCircle size={13} className="text-blue-600 shrink-0 mt-0.5" />
                  <p className="text-xs font-mono text-blue-700">
                    Ya existe un proyecto para esta página.{' '}
                    <Link
                      to={`/client/${clientId}/project/${duplicate.id}`}
                      onClick={closeModal}
                      className="font-semibold underline hover:no-underline"
                    >
                      Ver proyecto existente
                    </Link>
                    {' '}— puedes crear uno nuevo si quieres re-auditar la página.
                  </p>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-rule">
              <button onClick={closeModal} className="btn-ghost">Cancelar</button>
              <button
                onClick={handleConfirm}
                disabled={!newUrl.trim()}
                className="btn-primary"
              >
                Crear proyecto
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirm modal */}
      {deleteModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-rule rounded w-full max-w-lg">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rule">
              <h2 className="font-semibold text-ink text-sm">
                {deleteModal.mode === 'single' ? 'Eliminar proyecto' : `Eliminar proyectos (${deleteModal.candidates.length})`}
              </h2>
              <button onClick={() => setDeleteModal(null)} className="text-ink-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>

            <div className="p-5 space-y-4 max-h-[60vh] overflow-y-auto">
              {/* Safe to delete */}
              {deleteModal.safe.length > 0 && (
                <div>
                  {deleteModal.mode === 'bulk' && deleteModal.blocked.length > 0 && (
                    <p className="text-xs font-mono font-semibold text-ink mb-2">
                      Se eliminarán {deleteModal.safe.length} proyecto{deleteModal.safe.length !== 1 ? 's' : ''}:
                    </p>
                  )}
                  {deleteModal.mode === 'single' && (
                    <p className="text-xs font-mono text-ink-muted mb-3">
                      Esta acción no se puede deshacer.
                    </p>
                  )}
                  <div className="space-y-2">
                    {deleteModal.safe.map(proj => (
                      <div key={proj.id} className="flex items-center gap-2 bg-proof rounded px-3 py-2">
                        <span className="font-mono text-xs text-ink flex-1 truncate">{urlPath(proj.page_url)}</span>
                        <span className={`chip ${STATUS_CHIP[proj.status] ?? 'chip-ink'} text-[10px]`}>
                          {STATUS_LABEL[proj.status] ?? proj.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Blocked */}
              {deleteModal.blocked.length > 0 && (
                <div>
                  <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-3 mb-2">
                    <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                    <p className="text-xs font-mono text-amber-700">
                      {deleteModal.mode === 'single'
                        ? 'No se puede eliminar este proyecto.'
                        : `${deleteModal.blocked.length} proyecto${deleteModal.blocked.length !== 1 ? 's' : ''} no se pueden eliminar:`}
                    </p>
                  </div>
                  <div className="space-y-3">
                    {deleteModal.blocked.map(b => (
                      <div key={b.projectId} className="rounded border border-amber-200 bg-amber-50 px-3 py-2.5">
                        <p className="font-mono text-xs text-ink font-medium mb-1">{urlPath(b.pageUrl)}</p>
                        <p className="text-[10px] font-mono text-amber-700">
                          Otras {b.referencingPages.length} página{b.referencingPages.length !== 1 ? 's' : ''} referencian la entidad de esta página —
                          elimina o actualiza esas referencias primero.
                        </p>
                        <ul className="mt-1.5 space-y-0.5">
                          {b.referencingPages.map(pg => (
                            <li key={pg} className="text-[10px] font-mono text-amber-600">{urlPath(pg)}</li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* All blocked single */}
              {deleteModal.safe.length === 0 && deleteModal.mode === 'single' && (
                <p className="text-xs font-mono text-ink-muted">
                  Actualiza las referencias en las páginas listadas antes de intentar eliminar este proyecto.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 py-4 border-t border-rule">
              <button onClick={() => setDeleteModal(null)} className="btn-ghost">
                Cancelar
              </button>
              {deleteModal.safe.length > 0 && (
                <button
                  onClick={executeDelete}
                  disabled={deleting}
                  className="flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded border border-red-400 text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <Trash2 size={12} />
                  {deleting
                    ? 'Eliminando...'
                    : deleteModal.mode === 'single'
                    ? 'Eliminar'
                    : `Eliminar ${deleteModal.safe.length} proyecto${deleteModal.safe.length !== 1 ? 's' : ''}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
