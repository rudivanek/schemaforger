import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { SchemaTemplate } from '../lib/database.types';
import { AlertTriangle, Save, Check } from 'lucide-react';

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<SchemaTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [editNotes, setEditNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    setLoading(true);
    const { data } = await supabase.from('schema_templates').select('*').order('vertical');
    if (data) setTemplates(data);
    setLoading(false);
  };

  const startEdit = (t: SchemaTemplate) => {
    setEditing(t.id);
    setEditNotes(t.prompt_notes ?? '');
  };

  const handleSave = async (id: string) => {
    setSaving(true);
    await supabase.from('schema_templates').update({ prompt_notes: editNotes }).eq('id', id);
    setSaving(false);
    setSavedId(id);
    setTimeout(() => setSavedId(null), 2000);
    setEditing(null);
    loadTemplates();
  };

  const req = (t: SchemaTemplate): string => {
    const r = t.required_fields as Record<string, string[]>;
    return Object.entries(r).map(([type, fields]) => `${type}: ${fields.join(', ')}`).join(' | ');
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold text-ink">Plantillas de schema</h1>
          <p className="text-xs font-mono text-ink-muted mt-0.5">
            Combinaciones de tipos por vertical — modificar afecta la generación de schema
          </p>
        </div>
      </div>

      <div className="mb-4 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-3">
        <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
        <p className="text-xs font-mono text-amber-700">
          Editar <strong>prompt_notes</strong> cambia el comportamiento del generador de IA para ese vertical.
          Solo modifica si tienes validación de campo de las combinaciones.
        </p>
      </div>

      {loading ? (
        <p className="text-xs font-mono text-ink-muted py-8 text-center">Cargando plantillas...</p>
      ) : (
        <div className="space-y-3">
          {templates.map(t => (
            <div key={t.id} className="proof-card p-5">
              <div className="flex items-start justify-between gap-3 mb-3">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-semibold text-ink text-sm">{t.label_es}</span>
                    <span className="chip chip-ink">{t.vertical}</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {t.schema_type_combo.map(type => (
                      <span key={type} className="chip chip-blue">{type}</span>
                    ))}
                  </div>
                </div>
                {editing === t.id ? (
                  <div className="flex gap-2 shrink-0">
                    <button
                      onClick={() => setEditing(null)}
                      className="btn-ghost text-xs py-1 px-2"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => handleSave(t.id)}
                      disabled={saving}
                      className="btn-primary text-xs py-1 px-2 flex items-center gap-1"
                    >
                      {savedId === t.id ? <Check size={12} /> : <Save size={12} />}
                      {saving ? '...' : 'Guardar'}
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => startEdit(t)}
                    className="btn-ghost text-xs py-1 px-2 shrink-0"
                  >
                    Editar notas
                  </button>
                )}
              </div>

              <div className="text-xs font-mono text-ink-muted mb-2">
                <span className="text-ink-muted">Campos requeridos: </span>
                <span className="text-ink">{req(t)}</span>
              </div>

              <div>
                <p className="field-label">Instrucciones para el modelo (prompt_notes)</p>
                {editing === t.id ? (
                  <textarea
                    value={editNotes}
                    onChange={e => setEditNotes(e.target.value)}
                    rows={4}
                    className="input-field w-full font-mono text-xs resize-none"
                    autoFocus
                  />
                ) : (
                  <p className="text-xs font-mono text-ink bg-proof px-3 py-2 rounded border border-rule">
                    {t.prompt_notes ?? <span className="text-ink-muted italic">Sin notas</span>}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
