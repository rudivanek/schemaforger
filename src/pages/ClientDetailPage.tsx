import { useEffect, useState, useRef } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, SchemaProject } from '../lib/database.types';
import { ArrowLeft, Plus, X, AlertTriangle, AlertCircle, ExternalLink } from 'lucide-react';

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

export default function ClientDetailPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [projects, setProjects] = useState<SchemaProject[]>([]);
  const [loading, setLoading] = useState(true);

  const [showModal, setShowModal] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [domainWarning, setDomainWarning] = useState(false);
  const [duplicate, setDuplicate] = useState<SchemaProject | null>(null);
  const [checkingDup, setCheckingDup] = useState(false);
  const dupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    // Debounced duplicate check
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
              <Link
                to={`/client/${client.id}/geo`}
                className="btn-ghost text-xs py-1 px-2"
              >
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
        <div className="flex items-center justify-between px-5 py-3 border-b border-rule">
          <h2 className="section-title">Proyectos de schema</h2>
          <span className="text-xs font-mono text-ink-muted">
            {projects.length} proyecto{projects.length !== 1 ? 's' : ''}
          </span>
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
              <Link
                key={proj.id}
                to={`/client/${clientId}/project/${proj.id}`}
                className="flex items-center gap-3 px-5 py-3.5 hover:bg-proof transition-colors group"
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
                  Puedes editar la URL base para apuntar a una página específica, p. ej. <span className="text-ink">/contacto</span>
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
    </div>
  );
}
