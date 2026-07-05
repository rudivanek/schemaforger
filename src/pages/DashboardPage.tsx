import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, SchemaProject, GeoAudit } from '../lib/database.types';
import { Plus, Search, Globe, ChevronRight, X } from 'lucide-react';

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
  lastAuditVerdict: string | null;
}

export default function DashboardPage() {
  const [clients, setClients] = useState<ClientWithStats[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState({ name: '', website_url: '', vertical: 'medical' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

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
      return { ...c, projectCount: projs.length, lastAuditVerdict: verdict };
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
    if (!form.website_url.trim()) { setFormError('La URL es requerida'); return; }
    setSaving(true);
    const { error } = await supabase.from('clients').insert({
      name: form.name.trim(),
      website_url: form.website_url.trim(),
      vertical: form.vertical,
    });
    setSaving(false);
    if (error) { setFormError(error.message); return; }
    setShowModal(false);
    setForm({ name: '', website_url: '', vertical: 'medical' });
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
            <Link key={client.id} to={`/client/${client.id}`} className="proof-card p-4 hover:border-blue transition-colors group block">
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="font-semibold text-ink text-sm">{client.name}</span>
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
                </div>
                <ChevronRight size={14} className="text-rule group-hover:text-blue transition-colors shrink-0 mt-1" />
              </div>
            </Link>
          ))}
        </div>
      )}

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
                  type="url"
                  value={form.website_url}
                  onChange={e => setForm(f => ({ ...f, website_url: e.target.value }))}
                  className="input-field w-full font-mono"
                  placeholder="https://ejemplo.com"
                />
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
    </div>
  );
}
