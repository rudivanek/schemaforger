import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, GeoAudit } from '../lib/database.types';
import {
  ArrowLeft, Bot, FileText, Shield, ShieldOff, Copy, Check,
  AlertTriangle, CheckCircle, RefreshCw, Save
} from 'lucide-react';

const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Googlebot-Extended', 'CCBot', 'anthropic-ai', 'cohere-ai', 'FacebookBot'];

interface AuditResult {
  robots_txt_found: boolean;
  robots_txt_raw: string;
  blocked_ai_crawlers: string[];
  llms_txt_found: boolean;
  llms_txt_raw: string;
  generated_llms_txt: string;
  verdict: string;
}

export default function GeoAuditPage() {
  const { id: clientId } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [client, setClient] = useState<Client | null>(null);
  const [lastAudit, setLastAudit] = useState<GeoAudit | null>(null);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [robotsExpanded, setRobotsExpanded] = useState(false);
  const [llmsText, setLlmsText] = useState('');
  const [llmsCopied, setLlmsCopied] = useState(false);

  useEffect(() => {
    loadData();
  }, [clientId]);

  const loadData = async () => {
    if (!clientId) return;
    const { data: c } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (c) setClient(c);

    const { data: audit } = await supabase
      .from('geo_audits')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (audit) {
      setLastAudit(audit);
      if (audit.generated_llms_txt) setLlmsText(audit.generated_llms_txt);
    }
  };

  const handleAudit = async () => {
    if (!client) return;
    setAuditError('');
    setAuditing(true);
    try {
      // Get latest schema project for business_data
      const { data: proj } = await supabase
        .from('schema_projects')
        .select('generated_jsonld')
        .eq('client_id', clientId!)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data, error } = await supabase.functions.invoke('geo-audit', {
        body: {
          site_url: client.website_url,
          business_data: proj?.generated_jsonld ?? undefined,
        },
      });
      if (error) throw error;
      if (!data) throw new Error('Sin respuesta del servidor');
      setResult(data as AuditResult);
      if (data.generated_llms_txt) setLlmsText(data.generated_llms_txt);
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

  const display = result ?? (lastAudit ? {
    robots_txt_found: lastAudit.robots_txt_found ?? false,
    robots_txt_raw: '',
    blocked_ai_crawlers: lastAudit.blocked_ai_crawlers ?? [],
    llms_txt_found: lastAudit.llms_txt_found ?? false,
    llms_txt_raw: '',
    generated_llms_txt: lastAudit.generated_llms_txt ?? '',
    verdict: lastAudit.notes ?? '',
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
        <span className="text-ink">{client?.name ?? '...'}</span>
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
          </div>

          {/* llms.txt */}
          <div className="proof-card p-5">
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
          </div>

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
      )}
    </div>
  );
}
