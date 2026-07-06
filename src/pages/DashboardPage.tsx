import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, SchemaProject, GeoAudit } from '../lib/database.types';
import { Plus, Search, Globe, ChevronRight, X, Trash2, Pencil, AlertTriangle } from 'lucide-react';

const VERTICALS = [
  { value: 'medical', label: 'Clínica / Consultorio Médico' },
  { value: 'legal', label: 'Despacho Legal / Abogados' },
  { value: 'restaurant', label: 'Restaurante / Café' },
  { value: 'realestate', label: 'Inmobiliaria' },
  { value: 'local', label: 'Negocio Local / Retail' },
  { value: 'ecommerce', label: 'Tienda en Línea' },
  { value: 'services', label: 'Servicios Profesionales' },
];

const VERTICAL_COLORS: Record<string, string> = {
  medical: 'chip-blue',
  legal: 'chip-ink',
  restaurant: 'chip-orange',
  realestate: 'chip-blue',
  local: 'chip-ink',
  ecommerce: 'chip-orange',
  services: 'chip-blue',
};

interface ClientWithStats extends Client {
  projectCount: number;
  auditCount: number;
  lastAuditVerdict: string | null;
}

function normalizeUrl(raw: string): { url: string; error: string | null } {
  const trimmed = raw.trim();
  if (!trimmed) return { url: '', error: 'La URL es requerida' };
  if (/\s/.test(trimmed)) return { url: trimmed, error: 'La URL no debe contener espacios' };
  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    new URL(withProtocol);
    return { url: withProtocol, error: null };
  } catch {
    return { url: withProtocol, error: 'URL inválida — debe ser una dirección web válida (ej. https://ejemplo.com)' };
  }
}

export default function DashboardPage() {
  const [clients, setClients] = useState<ClientWithStats[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  // Create modal
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', website_url: '', vertical: 'medical' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // Delete modal
  const [deleteModal, setDeleteModal] = useState<ClientWithStats | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Edit modal
  const [editModal, setEditModal] = useState<ClientWithStats | null>(null);
  const [editForm, setEditForm] = useState({ name: '', website_url: '', vertical: 'medical' });
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');

  const loadClients = async () => {
    setLoading(true);
    const { data: clientRows } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
    if (!clientRows) { setLoading(false); return; }

    const { data: projects } = await supabase.from('schema_projects').select('id, client_id, status');
    const { data: audits } = await supabase.from('geo_audits').select('client_id, blocked_ai_crawlers, created_at').order('created_at', { ascending: false });

    const projectsByClient = (projects || []).reduce<Record<string, SchemaProject[]>>((acc, p) => {
      const key = p.client_id;
      if (!acc[key]) acc[key] = [];
      acc[key].push(p as SchemaProject);
      return acc;
    }, {});

    const auditCountByClient = (audits || []).reduce<Record<string, number>>((acc, a) => {
      acc[a.client_id] = (acc[a.client_id] ?? 0) + 1;
      return acc;
    }, {});

    const latestAuditByClient = (audits || []).reduce<Record<string, GeoAudit>>((acc, a) => {
      if (!acc[a.client_id]) acc[a.client_id] = a as GeoAudit;
      return acc;
    }, {});

    const enriched: ClientWithStats[] = clientRows.map(c => {
      const projs = projectsByClient[c.id] || [];
      const audit = latestAuditByClient[c.id];
      let verdict: string | null = null;
      if (audit) {
        const blocked = (audit.blocked_ai_crawlers || []).length;
        verdict = blocked > 0 ? `${blocked} bot${blocked > 1 ? 's' : ''} bloqueado${blocked > 1 ? 's' : ''}` : 'Sin bloqueos detectados';
      }
      return {
        ...c,
        projectCount: projs.length,
        auditCount: auditCountByClient[c.id] ?? 0,
        lastAuditVerdict: verdict,
      };
    });

    setClients(enriched);
    setLoading(false);
  };

  useEffect(() => { loadClients(); }, []);

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.website_url.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async () => {
    setFormError('');
    if (!form.name.trim()) { setFormError('El nombre es requerido'); return; }
    const { url: normalizedUrl, error: urlError } = normalizeUrl(form.website_url);
    if (urlError) { setFormError(urlError); return; }
    setSaving(true);
    const { error } = await supabase.from('clients').insert({
      name: form.name.trim(),
      website_url: normalizedUrl,
      vertical: form.vertical,
    });
    setSaving(false);
    if (error) { setFormError(error.message); return; }
    setShowModal(false);
    setForm({ name: '', website_url: '', vertical: 'medical' });
    loadClients();
  };

  const handleDeleteClient = async () => {
    if (!deleteModal) return;
    setDeleting(true);
    await supabase.from('clients').delete().eq('id', deleteModal.id);
    setDeleteModal(null);
    setDeleting(false);
    loadClients();
  };

  const openEditModal = (client: ClientWithStats) => {
    setEditModal(client);
    setEditForm({ name: client.name, website_url: client.website_url, vertical: client.vertical });
    setEditError('');
  };

  const handleEditSave = async () => {
    if (!editModal) return;
    setEditError('');
    if (!editForm.name.trim()) { setEditError('El nombre es requerido'); return; }
    const { url: normalizedUrl, error: urlError } = normalizeUrl(editForm.website_url);
    if (urlError) { setEditError(urlError); return; }
    setEditSaving(true);
    const { error } = await supabase.from('clients').update({
      name: editForm.name.trim(),
      website_url: normalizedUrl,
      vertical: editForm.vertical,
    }).eq('id', editModal.id);
    setEditSaving(false);
    if (error) { setEditError(error.message); return; }
    setEditModal(null);
    loadClients();
  };

  const verticalLabel = (v: string) => VERTICALS.find(x => x.value === v)?.label ?? v;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Clientes</h1>
          <p className="text-xs font-mono text-ink-muted mt-0.5">{clients.length} cliente{clients.length !== 1 ? 's' : ''} en total</p>
        </div>
        <button onClick={() => setShowModal(true)} className="btn-primary flex items-center gap-1.5">
          <Plus size={14} />
          Nuevo cliente
        </button>
      </div>

      <div className="relative mb-4">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nombre o URL..."
          className="input-field pl-9 w-full max-w-sm"
        />
      </div>

      {loading ? (
        <div className="text-xs font-mono text-ink-muted py-12 text-center">Cargando clientes...</div>
      ) : filtered.length === 0 ? (
        <div className="proof-card p-12 text-center">
          <Globe size={32} className="text-rule mx-auto mb-3" />
          <p className="text-sm text-ink-muted font-mono">
            {search ? 'Sin resultados para esa búsqueda' : 'Aún no hay clientes. Crea el primero.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3">
          {filtered.map(client => (
            <div key={client.id} className="proof-card p-4 hover:border-blue transition-colors group">
              <div className="flex items-start gap-3">
                <Link to={`/client/${client.id}`} className="flex-1 min-w-0 block">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-semibold text-ink text-sm group-hover:text-blue transition-colors">{client.name}</span>
                    <span className={`chip ${VERTICAL_COLORS[client.vertical] ?? 'chip-ink'}`}>
                      {verticalLabel(client.vertical)}
                    </span>
                  </div>
                  <span className="text-xs font-mono text-blue block truncate">
                    {client.website_url}
                  </span>
                  <div className="flex items-center gap-4 mt-2 text-xs font-mono text-ink-muted">
                    <span>{client.projectCount} proyecto{client.projectCount !== 1 ? 's' : ''}</span>
                    {client.lastAuditVerdict && (
                      <span className={client.lastAuditVerdict.includes('bloqueado') ? 'text-orange' : 'text-green'}>
                        GEO: {client.lastAuditVerdict}
                      </span>
                    )}
                  </div>
                </Link>

                <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
                  <button
                    onClick={e => { e.preventDefault(); openEditModal(client); }}
                    className="p-1.5 rounded text-ink-muted hover:text-ink hover:bg-proof transition-colors"
                    title="Editar cliente"
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    onClick={e => { e.preventDefault(); setDeleteModal(client); }}
                    className="p-1.5 rounded text-ink-muted hover:text-red hover:bg-red/8 transition-colors"
                    title="Eliminar cliente"
                  >
                    <Trash2 size={13} />
                  </button>
                  <ChevronRight size={14} className="text-rule group-hover:text-blue transition-colors ml-1" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create client modal */}
      {showModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-rule rounded w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rule">
              <h2 className="font-semibold text-ink text-sm">Nuevo cliente</h2>
              <button onClick={() => setShowModal(false)} className="text-ink-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="field-label">Nombre</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  className="input-field w-full"
                  placeholder="Clínica Retina Center"
                  autoFocus
                />
              </div>
              <div>
                <label className="field-label">Sitio web</label>
                <input
                  type="text"
                  value={form.website_url}
                  onChange={e => setForm(f => ({ ...f, website_url: e.target.value }))}
                  className="input-field w-full font-mono"
                  placeholder="https://ejemplo.com"
                />
                <p className="text-[10px] font-mono text-ink-muted mt-1">
                  Si no incluyes https://, se añadirá automáticamente.
                </p>
              </div>
              <div>
                <label className="field-label">Vertical</label>
                <select
                  value={form.vertical}
                  onChange={e => setForm(f => ({ ...f, vertical: e.target.value }))}
                  className="input-field w-full"
                >
                  {VERTICALS.map(v => (
                    <option key={v.value} value={v.value}>{v.label}</option>
                  ))}
                </select>
              </div>
              {formError && (
                <p className="text-xs font-mono text-orange">{formError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-rule">
              <button onClick={() => setShowModal(false)} className="btn-ghost">Cancelar</button>
              <button onClick={handleCreate} disabled={saving} className="btn-primary">
                {saving ? 'Guardando...' : 'Crear cliente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete client modal */}
      {deleteModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-rule rounded w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rule">
              <h2 className="font-semibold text-ink text-sm">Eliminar cliente</h2>
              <button onClick={() => setDeleteModal(null)} className="text-ink-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <p className="text-sm text-ink font-semibold">¿Eliminar este cliente?</p>
              <div className="bg-proof rounded px-3 py-2">
                <p className="text-sm font-semibold text-ink">{deleteModal.name}</p>
                <p className="text-xs font-mono text-ink-muted mt-0.5">{deleteModal.website_url}</p>
              </div>
              {(deleteModal.projectCount > 0 || deleteModal.auditCount > 0) && (
                <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-3">
                  <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-xs font-mono text-amber-700">
                    Se eliminarán también{' '}
                    {deleteModal.projectCount > 0 && (
                      <span className="font-semibold">{deleteModal.projectCount} proyecto{deleteModal.projectCount !== 1 ? 's' : ''} de schema</span>
                    )}
                    {deleteModal.projectCount > 0 && deleteModal.auditCount > 0 && ' y '}
                    {deleteModal.auditCount > 0 && (
                      <span className="font-semibold">{deleteModal.auditCount} auditoría{deleteModal.auditCount !== 1 ? 's' : ''} GEO</span>
                    )}
                    {' '}asociados. Esta acción no se puede deshacer.
                  </p>
                </div>
              )}
              {deleteModal.projectCount === 0 && deleteModal.auditCount === 0 && (
                <p className="text-xs font-mono text-ink-muted">Esta acción no se puede deshacer.</p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-rule">
              <button onClick={() => setDeleteModal(null)} className="btn-ghost">Cancelar</button>
              <button
                onClick={handleDeleteClient}
                disabled={deleting}
                className="flex items-center gap-1.5 text-xs font-mono px-3 py-1.5 rounded border border-red text-white bg-red hover:opacity-85 disabled:opacity-50 transition-opacity"
              >
                <Trash2 size={12} />
                {deleting ? 'Eliminando...' : 'Eliminar cliente'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit client modal */}
      {editModal && (
        <div className="fixed inset-0 bg-ink/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white border border-rule rounded w-full max-w-md">
            <div className="flex items-center justify-between px-5 py-4 border-b border-rule">
              <h2 className="font-semibold text-ink text-sm">Editar cliente</h2>
              <button onClick={() => setEditModal(null)} className="text-ink-muted hover:text-ink">
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="field-label">Nombre</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                  className="input-field w-full"
                  autoFocus
                />
              </div>
              <div>
                <label className="field-label">Sitio web</label>
                <input
                  type="text"
                  value={editForm.website_url}
                  onChange={e => setEditForm(f => ({ ...f, website_url: e.target.value }))}
                  className="input-field w-full font-mono"
                  placeholder="https://ejemplo.com"
                />
                <p className="text-[10px] font-mono text-ink-muted mt-1">
                  Si no incluyes https://, se añadirá automáticamente.
                </p>
              </div>
              <div>
                <label className="field-label">Vertical</label>
                <select
                  value={editForm.vertical}
                  onChange={e => setEditForm(f => ({ ...f, vertical: e.target.value }))}
                  className="input-field w-full"
                >
                  {VERTICALS.map(v => (
                    <option key={v.value} value={v.value}>{v.label}</option>
                  ))}
                </select>
              </div>
              {editError && (
                <p className="text-xs font-mono text-orange">{editError}</p>
              )}
            </div>
            <div className="flex justify-end gap-2 px-5 py-4 border-t border-rule">
              <button onClick={() => setEditModal(null)} className="btn-ghost">Cancelar</button>
              <button onClick={handleEditSave} disabled={editSaving} className="btn-primary">
                {editSaving ? 'Guardando...' : 'Guardar cambios'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
