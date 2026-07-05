import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { Client, SchemaProject, SchemaTemplate } from '../lib/database.types';
import { validateJsonLd, toScriptTag, richResultsTestUrl, isPlaceholder } from '../lib/validation';
import type { ValidationIssue } from '../lib/validation';
import {
  ArrowLeft, ArrowRight, Scan, Sparkles, CheckCircle,
  Copy, Check, AlertTriangle, ExternalLink, ChevronDown, ChevronUp,
  AlertCircle, Info
} from 'lucide-react';

type Step = 1 | 2 | 3;

function stripJsonPlaceholders(obj: unknown): unknown {
  const removed: string[] = [];

  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    if (v && typeof v === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k.startsWith('_')) { result[k] = val; continue; }
        if (typeof val === 'string' && isPlaceholder(val)) {
          removed.push(path ? `${path}.${k}` : k);
          continue;
        }
        result[k] = walk(val, path ? `${path}.${k}` : k);
      }
      return result;
    }
    return v;
  };

  const result = walk(obj, '') as Record<string, unknown>;

  if (removed.length > 0) {
    const note = removed.map(p => `Se removió un marcador del campo "${p}"`).join('\n');
    const existing = typeof result._operator_notes === 'string' ? result._operator_notes : '';
    result._operator_notes = existing ? `${existing}\n${note}` : note;
  }

  return result;
}

type SchemaSource = 'yoast' | 'rankmath' | 'other' | 'none';

interface ScrapedData {
  page_url?: string;
  title?: string;
  meta_description?: string;
  og_site_name?: string;
  og_image?: string;
  h1?: string;
  phone?: string;
  email?: string;
  address_hint?: string;
  hours_hint?: string;
  same_as?: string[];
  existing_jsonld?: unknown;
  visible_text_sample?: string;
  detected_schema_types?: string[];
  schema_source?: SchemaSource;
  conflict_types?: string[];
}

// Schema.org types that describe a business/organization entity.
// Any of these detected on a page conflict with what we will generate.
const BUSINESS_ENTITY_TYPES = new Set([
  'Organization','LocalBusiness','Restaurant','FoodEstablishment','Bakery','BarOrPub',
  'Brewery','CafeOrCoffeeShop','FastFoodRestaurant','IceCreamShop','Winery',
  'Hotel','LodgingBusiness','Motel','BedAndBreakfast','Hostel','Resort',
  'MedicalBusiness','Dentist','Physician','MedicalClinic','Pharmacy','Optician',
  'LegalService','Attorney','Notary',
  'AccountingService','FinancialService','InsuranceAgency','BankOrCreditUnion',
  'AutoRepair','AutomotiveBusiness','CarDealer','GasStation','MotorcycleDealer',
  'BeautySalon','DaySpa','HairSalon','NailSalon',
  'HomeAndConstructionBusiness','Electrician','GeneralContractor','HVACBusiness',
  'Locksmith','MovingCompany','Painter','Plumber','RoofingContractor',
  'PetStore','VeterinaryCare','AnimalShelter',
  'RealEstateAgent','Store','ClothingStore','ComputerStore','ElectronicsStore',
  'FlowerShop','FurnitureStore','GardenStore','GroceryStore','HardwareStore',
  'JewelryStore','LiquorStore','ShoeStore','SportingGoodsStore',
  'SportsActivityLocation','FitnessCenter','GolfCourse','HealthClub','SportsClub',
  'TennisCourt','BowlingAlley','Campground','SkiResort',
  'EntertainmentBusiness','AmusementPark','ArtGallery','Casino','ComedyClub',
  'MovieTheater','NightClub','ChildCare','Museum','PlaceOfWorship',
  'School','CollegeOrUniversity','TouristAttraction','TravelAgency',
]);

function isBusinessEntity(type: string): boolean {
  return BUSINESS_ENTITY_TYPES.has(type);
}

function collectTypesFromJsonLd(root: unknown): string[] {
  const types = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (obj['@type']) {
        ([] as string[]).concat(obj['@type'] as string | string[]).forEach(t => { if (t) types.add(t); });
      }
      Object.values(obj).forEach(walk);
    }
  };
  walk(root);
  return Array.from(types);
}

function normalizeForHomepageCompare(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '');
  } catch { return url.toLowerCase().trim(); }
}

function extractMainEntityFromJsonLd(
  jsonld: unknown,
  primaryType: string,
): { id: string; type: string; name: string } | null {
  const nodes: Record<string, unknown>[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (obj['@type']) nodes.push(obj);
      Object.values(obj).forEach(walk);
    }
  };
  walk(jsonld);
  const node = nodes.find(n => {
    const types = ([] as string[]).concat(n['@type'] as string | string[]);
    return types.includes(primaryType);
  });
  if (!node) return null;
  const id = typeof node['@id'] === 'string' ? node['@id'] : null;
  const name = typeof node['name'] === 'string' ? node['name'] : null;
  if (!id || !name) return null;
  return { id, type: primaryType, name };
}

export default function ProjectWorkspace() {
  const { id: clientId, projectId } = useParams<{ id: string; projectId: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [client, setClient] = useState<Client | null>(null);
  const [project, setProject] = useState<SchemaProject | null>(null);
  const [template, setTemplate] = useState<SchemaTemplate | null>(null);
  const [step, setStep] = useState<Step>(1);

  // Step 1
  const [pageUrl, setPageUrl] = useState('');
  const [scraping, setScraping] = useState(false);
  const [scraped, setScraped] = useState<ScrapedData | null>(null);
  const [scrapeError, setScrapeError] = useState('');
  const [operatorNotes, setOperatorNotes] = useState('');
  const [duplicateProject, setDuplicateProject] = useState<SchemaProject | null>(null);
  const dupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Secondary-page entity reference
  const [mainEntity, setMainEntity] = useState<{ id: string; type: string; name: string } | null>(null);
  const [homepageProjectMissing, setHomepageProjectMissing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [jsonld, setJsonld] = useState<Record<string, unknown> | null>(null);
  const [generateError, setGenerateError] = useState('');
  const [operatorWarning, setOperatorWarning] = useState('');
  const [editedFields, setEditedFields] = useState<Record<string, Record<string, string>>>({});
  const [missingRequiredByType, setMissingRequiredByType] = useState<Record<string, string[]>>({});
  const [missingRecommendedByType, setMissingRecommendedByType] = useState<Record<string, string[]>>({});
  const [recommendedExpanded, setRecommendedExpanded] = useState<Record<string, boolean>>({});
  const [jsonPreviewExpanded, setJsonPreviewExpanded] = useState(true);

  // Step 3
  const [validationResult, setValidationResult] = useState<ValidationIssue[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyBlockedFields, setCopyBlockedFields] = useState<string[]>([]);
  const [wpExpanded, setWpExpanded] = useState(false);
  const [delivering, setDelivering] = useState(false);

  const isNew = projectId === 'new';

  useEffect(() => {
    loadData();
  }, [clientId, projectId]);

  const loadData = async () => {
    if (!clientId) return;

    const { data: clientData } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (clientData) setClient(clientData);

    if (!isNew && projectId) {
      const { data: proj } = await supabase.from('schema_projects').select('*').eq('id', projectId).maybeSingle();
      if (proj) {
        setProject(proj);
        setPageUrl(proj.page_url);
        if (proj.raw_scraped_data) setScraped(proj.raw_scraped_data as ScrapedData);

        // Load template before initialising edited fields so missing-field detection works
        let tmpl: SchemaTemplate | null = null;
        if (clientData?.vertical) {
          const { data: t } = await supabase.from('schema_templates').select('*').eq('vertical', clientData.vertical).maybeSingle();
          if (t) { tmpl = t; setTemplate(t); }
        }

        if (proj.generated_jsonld) {
          const jld = stripJsonPlaceholders(proj.generated_jsonld) as Record<string, unknown>;
          setJsonld(jld);
          if (jld._operator_notes) setOperatorWarning(String(jld._operator_notes));
          if (proj.status === 'draft') setStep(2);
          if (proj.status === 'validated' || proj.status === 'delivered') setStep(3);
          if (tmpl) initEditedFields(jld, tmpl);
        }
      }
    } else if (clientData) {
      // Prefer ?url param over client's root URL for new projects
      const paramUrl = searchParams.get('url');
      setPageUrl(paramUrl ?? clientData.website_url);
      const { data: tmpl } = await supabase.from('schema_templates').select('*').eq('vertical', clientData.vertical).maybeSingle();
      if (tmpl) setTemplate(tmpl);
    }
  };

  const checkDuplicate = (url: string) => {
    if (dupTimerRef.current) clearTimeout(dupTimerRef.current);
    setDuplicateProject(null);
    if (!url || !clientId) return;
    dupTimerRef.current = setTimeout(async () => {
      const { data } = await supabase
        .from('schema_projects')
        .select('*')
        .eq('client_id', clientId)
        .eq('page_url', url)
        .neq('id', project?.id ?? '')
        .limit(1)
        .maybeSingle();
      setDuplicateProject(data ?? null);
    }, 600);
  };

  // Check duplicates when pageUrl changes (new projects only)
  useEffect(() => {
    if (isNew) checkDuplicate(pageUrl);
    return () => { if (dupTimerRef.current) clearTimeout(dupTimerRef.current); };
  }, [pageUrl, isNew]);

  // Determine if this is a secondary page (not the client's homepage)
  const isSecondaryPage = (() => {
    if (!client || !pageUrl) return false;
    try {
      return normalizeForHomepageCompare(pageUrl) !== normalizeForHomepageCompare(client.website_url);
    } catch { return false; }
  })();

  // When on a secondary page, look up the homepage project to extract the main entity reference
  useEffect(() => {
    if (!isSecondaryPage || !clientId || !client || !template) {
      setMainEntity(null);
      setHomepageProjectMissing(false);
      return;
    }
    const normalizedHome = normalizeForHomepageCompare(client.website_url);
    (async () => {
      const { data: homepageProjects } = await supabase
        .from('schema_projects')
        .select('id, page_url, status, generated_jsonld')
        .eq('client_id', clientId)
        .in('status', ['validated', 'delivered']);

      const homeProj = (homepageProjects ?? []).find(p =>
        normalizeForHomepageCompare(p.page_url) === normalizedHome &&
        p.id !== (project?.id ?? '')
      );

      if (!homeProj?.generated_jsonld) {
        setMainEntity(null);
        setHomepageProjectMissing(true);
        return;
      }

      const primaryType = template.schema_type_combo[0];
      const entity = extractMainEntityFromJsonLd(homeProj.generated_jsonld, primaryType);
      if (entity) {
        setMainEntity(entity);
        setHomepageProjectMissing(false);
      } else {
        setMainEntity(null);
        setHomepageProjectMissing(true);
      }
    })();
  }, [isSecondaryPage, clientId, client?.website_url, template?.id, project?.id]);

  const persistProject = async (updates: Partial<SchemaProject>) => {
    if (isNew && !project) {
      const { data, error } = await supabase.from('schema_projects').insert({
        client_id: clientId!,
        page_url: pageUrl,
        schema_types: template?.schema_type_combo ?? [],
        ...updates,
      }).select().maybeSingle();
      if (!error && data) {
        setProject(data);
        navigate(`/client/${clientId}/project/${data.id}`, { replace: true });
        return data;
      }
    } else if (project) {
      const { data } = await supabase.from('schema_projects').update(updates).eq('id', project.id).select().maybeSingle();
      if (data) setProject(data);
      return data;
    }
    return null;
  };

  const handleScrape = async () => {
    setScrapeError('');
    setScraping(true);
    try {
      const { data, error } = await supabase.functions.invoke('scrape-site', { body: { url: pageUrl } });
      if (error) throw error;
      if (!data?.scraped) throw new Error('Respuesta inesperada del servidor');
      const s = data.scraped as ScrapedData;
      s.detected_schema_types = collectTypesFromJsonLd(s.existing_jsonld);
      // Compute conflict list: entity types that clash with what we'll generate
      const willGenerateEntity = (template?.schema_type_combo ?? []).some(isBusinessEntity);
      s.conflict_types = willGenerateEntity
        ? s.detected_schema_types.filter(isBusinessEntity)
        : [];
      setScraped(s);
      await persistProject({ page_url: pageUrl, raw_scraped_data: s as unknown as import('../lib/database.types').Json });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al escanear';
      setScrapeError(msg);
      setScraped(null);
    }
    setScraping(false);
  };

  const handleGenerate = async () => {
    if (!scraped || !template) return;
    setGenerateError('');
    setGenerating(true);
    try {
      const { data, error } = await supabase.functions.invoke('generate-schema', {
        body: {
          scraped,
          template,
          extra_info: operatorNotes,
          ...(mainEntity ? { main_entity: mainEntity } : {}),
        },
      });
      if (error) throw error;
      if (!data?.jsonld) throw new Error('No se recibió JSON-LD del servidor');
      const jld = stripJsonPlaceholders(data.jsonld) as Record<string, unknown>;
      if (jld._operator_notes) {
        setOperatorWarning(String(jld._operator_notes));
      }
      setJsonld(jld);
      initEditedFields(jld, template ?? undefined);
      await persistProject({ generated_jsonld: jld as unknown as import('../lib/database.types').Json, status: 'draft' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error al generar';
      setGenerateError(msg);
    }
    setGenerating(false);
  };

  const initEditedFields = (jld: Record<string, unknown>, tmplOverride?: SchemaTemplate) => {
    const effectiveTemplate = tmplOverride ?? template;
    const ns = extractNodes(jld);
    const fields: Record<string, Record<string, string>> = {};
    ns.forEach(node => {
      const type = getNodeType(node);
      if (!type) return;
      fields[type] = fields[type] || {};
      Object.entries(node).forEach(([k, v]) => {
        if (k.startsWith('@') || k === '_operator_notes') return;
        const strVal = typeof v === 'string' ? v : JSON.stringify(v);
        if (isPlaceholder(strVal)) return; // treat placeholder strings as missing
        fields[type][k] = strVal;
      });
    });
    setEditedFields(fields);

    if (effectiveTemplate) {
      const missingReq: Record<string, string[]> = {};
      const missingRec: Record<string, string[]> = {};
      const req = effectiveTemplate.required_fields as Record<string, string[]>;
      const rec = effectiveTemplate.recommended_fields as Record<string, string[]>;
      ns.forEach(node => {
        const type = getNodeType(node);
        if (!type) return;
        const existing = Object.keys(fields[type] || {});
        const reqFields = req[type] ?? [];
        const recFields = rec[type] ?? [];
        missingReq[type] = reqFields.filter(f => !existing.includes(f));
        missingRec[type] = recFields.filter(f => !existing.includes(f) && !reqFields.includes(f));
      });
      setMissingRequiredByType(missingReq);
      setMissingRecommendedByType(missingRec);
    }
  };

  const extractNodes = (jld: Record<string, unknown>): Record<string, unknown>[] => {
    if (jld['@graph'] && Array.isArray(jld['@graph'])) {
      return jld['@graph'] as Record<string, unknown>[];
    }
    return [jld];
  };

  const getNodeType = (node: Record<string, unknown>): string | null => {
    const t = node['@type'];
    if (typeof t === 'string') return t;
    if (Array.isArray(t) && t.length > 0) return t[0] as string;
    return null;
  };

  const handleFieldEdit = (schemaType: string, field: string, value: string) => {
    setEditedFields(prev => ({
      ...prev,
      [schemaType]: { ...(prev[schemaType] || {}), [field]: value },
    }));
    // Rebuild jsonld from edited fields
    if (jsonld) {
      const rebuilt = rebuildJsonld(jsonld, schemaType, field, value);
      setJsonld(rebuilt);
    }
  };

  const rebuildJsonld = (
    jld: Record<string, unknown>,
    targetType: string,
    field: string,
    value: string
  ): Record<string, unknown> => {
    const updateNode = (node: Record<string, unknown>): Record<string, unknown> => {
      const type = getNodeType(node);
      if (type === targetType) {
        return { ...node, [field]: value };
      }
      return node;
    };
    if (jld['@graph'] && Array.isArray(jld['@graph'])) {
      return { ...jld, '@graph': (jld['@graph'] as Record<string, unknown>[]).map(updateNode) };
    }
    return updateNode(jld);
  };

  const handleValidate = async () => {
    if (!jsonld) return;
    const issues = validateJsonLd(jsonld);
    setValidationResult(issues);
    const hasErrors = issues.some(i => i.severity === 'error');
    await persistProject({ status: hasErrors ? 'draft' : 'validated' });
    await supabase.from('validation_log').insert({
      schema_project_id: project!.id,
      is_valid: !hasErrors,
      errors: issues as unknown as import('../lib/database.types').Json,
    });
  };

  const handleCopy = async () => {
    if (!jsonld) return;
    setCopyBlockedFields([]);
    try {
      const tag = toScriptTag(jsonld);
      await navigator.clipboard.writeText(tag);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e: unknown) {
      if (e instanceof Error && 'fields' in e) {
        setCopyBlockedFields((e as Error & { fields: string[] }).fields);
      }
    }
  };

  const handleDeliver = async () => {
    setDelivering(true);
    await persistProject({ status: 'delivered' });
    setDelivering(false);
  };

  const getRequiredFields = (schemaType: string): string[] => {
    if (!template) return [];
    const req = template.required_fields as Record<string, string[]>;
    return req[schemaType] || [];
  };

  const getRecommendedFields = (schemaType: string): string[] => {
    if (!template) return [];
    const rec = template.recommended_fields as Record<string, string[]>;
    return rec[schemaType] || [];
  };

  const nodes = jsonld ? extractNodes(jsonld) : [];

  return (
    <div className="max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 mb-5 text-xs font-mono text-ink-muted">
        <button onClick={() => navigate('/')} className="hover:text-ink flex items-center gap-1">
          <ArrowLeft size={12} />
          Clientes
        </button>
        <span>/</span>
        <span className="text-ink">{client?.name ?? '...'}</span>
        <span>/</span>
        <span>Proyecto {isNew ? 'nuevo' : `#${project?.id.slice(0, 8)}`}</span>
      </div>

      {/* Step tabs */}
      <div className="flex items-center gap-0 mb-6 border border-rule rounded overflow-hidden bg-white w-fit">
        {[
          { n: 1 as Step, label: 'Escanear', icon: <Scan size={13} /> },
          { n: 2 as Step, label: 'Generar', icon: <Sparkles size={13} /> },
          { n: 3 as Step, label: 'Validar y exportar', icon: <CheckCircle size={13} /> },
        ].map(({ n, label, icon }) => (
          <button
            key={n}
            onClick={() => { if (n < step || (n === 2 && scraped) || (n === 3 && jsonld)) setStep(n); }}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-mono border-r border-rule last:border-r-0 transition-colors ${
              step === n ? 'bg-ink text-white' : 'text-ink-muted hover:text-ink hover:bg-proof'
            }`}
          >
            {icon}
            <span className="hidden sm:inline">{label}</span>
            <span className="sm:hidden">{n}</span>
          </button>
        ))}
      </div>

      {/* Step 1: Escanear */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="proof-card p-5">
            <h2 className="section-title mb-3">URL a escanear</h2>
            <div className="flex gap-2">
              <input
                type="url"
                value={pageUrl}
                onChange={e => setPageUrl(e.target.value)}
                className="input-field flex-1 font-mono text-sm"
                placeholder="https://ejemplo.com"
              />
              <button
                onClick={handleScrape}
                disabled={scraping || !pageUrl}
                className="btn-primary flex items-center gap-2 shrink-0"
              >
                <Scan size={14} />
                {scraping ? 'Escaneando...' : 'Escanear'}
              </button>
            </div>
            {scrapeError && (
              <p className="text-xs font-mono text-orange mt-2 flex items-center gap-1">
                <AlertCircle size={12} /> {scrapeError}
              </p>
            )}
            {duplicateProject && (
              <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded p-2.5 mt-2">
                <Info size={13} className="text-blue-600 shrink-0 mt-0.5" />
                <p className="text-xs font-mono text-blue-700">
                  Ya existe un proyecto para esta página.{' '}
                  <Link
                    to={`/client/${clientId}/project/${duplicateProject.id}`}
                    className="font-semibold underline hover:no-underline"
                  >
                    Ver proyecto existente
                  </Link>
                  {' '}— puedes continuar aquí si quieres re-auditar.
                </p>
              </div>
            )}
          </div>

          {scraped && (
            <div className="proof-card p-5">
              <h2 className="section-title mb-3">Datos extraídos</h2>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs font-mono">
                {[
                  ['Título', scraped.title],
                  ['H1', scraped.h1],
                  ['Descripción', scraped.meta_description],
                  ['Teléfono', scraped.phone],
                  ['Email', scraped.email],
                  ['Dirección (pista)', scraped.address_hint],
                  ['Horarios (pista)', scraped.hours_hint],
                ].filter(([, v]) => v).map(([label, value]) => (
                  <div key={label as string} className="proof-field">
                    <span className="text-ink-muted">{label as string}</span>
                    <span className="text-ink font-medium">{value as string}</span>
                  </div>
                ))}
                {scraped.same_as && scraped.same_as.length > 0 && (
                  <div className="proof-field col-span-full">
                    <span className="text-ink-muted">Redes / sameAs</span>
                    <span className="text-blue">{scraped.same_as.join(', ')}</span>
                  </div>
                )}
              </div>

              {/* Schema detectado */}
              {(() => {
                const detectedTypes = scraped.detected_schema_types ?? [];
                const requiredTypes = template?.schema_type_combo ?? [];
                const hasCode = Array.isArray(scraped.existing_jsonld) && scraped.existing_jsonld.length > 0;
                const conflictTypes = scraped.conflict_types ?? [];
                const source = (scraped.schema_source ?? 'none') as SchemaSource;
                const hasConflicts = conflictTypes.length > 0;

                const sourceLabel: Record<Exclude<SchemaSource, 'none' | 'other'>, string> = {
                  yoast: 'Generado por Yoast',
                  rankmath: 'Generado por Rank Math',
                };

                return (
                  <div className="mt-4 border-t border-rule pt-4">
                    <div className="flex items-center gap-2 flex-wrap mb-2">
                      <p className="section-title">Schema detectado en la página</p>
                      {(source === 'yoast' || source === 'rankmath') && (
                        <span className={`chip text-[10px] font-semibold uppercase tracking-wider ${
                          source === 'yoast' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-blue-50 text-blue-700 border border-blue-200'
                        }`}>
                          {sourceLabel[source]}
                        </span>
                      )}
                    </div>

                    {detectedTypes.length === 0 ? (
                      <p className="text-xs font-mono text-ink-muted">
                        Sin schema detectado — se generará desde cero.
                      </p>
                    ) : (
                      <>
                        {/* Per-type conflict/compatible badges */}
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {detectedTypes.map(type => {
                            const isConflict = conflictTypes.includes(type);
                            return (
                              <div key={type} className="flex items-center gap-1">
                                <span className="chip chip-ink">{type}</span>
                                {isConflict ? (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider bg-red-50 text-red-700 border border-red-200">
                                    CONFLICTO — consolidar antes de publicar
                                  </span>
                                ) : (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-medium uppercase tracking-wider bg-gray-50 text-gray-500 border border-gray-200">
                                    compatible
                                  </span>
                                )}
                              </div>
                            );
                          })}
                        </div>

                        {/* Plugin conflict instructions */}
                        {hasConflicts && (source === 'yoast' || source === 'rankmath') && (
                          <div className="mb-3 rounded border border-red-200 bg-red-50 p-3 space-y-2">
                            <p className="text-xs font-semibold text-red-700 flex items-center gap-1.5">
                              <AlertTriangle size={12} className="shrink-0" />
                              Pasos para resolver el conflicto en tu plugin
                            </p>
                            {source === 'yoast' && (
                              <p className="text-xs font-mono text-red-600">
                                <span className="font-semibold">Yoast:</span> Yoast SEO › Apariencia de búsqueda › pestaña "Organización" — cambia el tipo de organización a "Ninguno" o desactiva el output de schema del tipo en conflicto, luego guarda.
                              </p>
                            )}
                            {source === 'rankmath' && (
                              <p className="text-xs font-mono text-red-600">
                                <span className="font-semibold">Rank Math:</span> Rank Math › Ajustes generales › Conocimiento del sitio — establece el tipo de entidad en "Ninguno" para evitar que el plugin emita su propio schema de negocio duplicado, luego guarda.
                              </p>
                            )}
                          </div>
                        )}

                        {/* Conflicto sin plugin identificado */}
                        {hasConflicts && source !== 'yoast' && source !== 'rankmath' && (
                          <div className="mb-3 rounded border border-red-200 bg-red-50 p-3">
                            <p className="text-xs font-semibold text-red-700 flex items-center gap-1.5">
                              <AlertTriangle size={12} className="shrink-0" />
                              Schema de entidad existente detectado — consolidar o eliminar antes de publicar el nuevo schema para evitar duplicados.
                            </p>
                          </div>
                        )}

                        {requiredTypes.length > 0 && !isSecondaryPage && (
                          <div className="flex items-start gap-2 flex-wrap mb-1">
                            <span className="text-xs font-mono text-ink-muted shrink-0 pt-0.5">
                              Requerido para este vertical:
                            </span>
                            <div className="flex flex-wrap gap-1.5">
                              {requiredTypes.map(type => {
                                const present = detectedTypes.includes(type);
                                return (
                                  <span key={type} className={`chip ${present ? 'chip-green' : 'chip-red'}`}>
                                    {present ? '✓' : '✗'} {type}{!present && ' — falta'}
                                  </span>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        {hasCode && (
                          <details className="mt-3">
                            <summary className="text-xs font-mono text-ink-muted cursor-pointer hover:text-ink">
                              Ver código
                            </summary>
                            <pre className="proof-code mt-2 text-xs overflow-auto max-h-48">
                              {JSON.stringify(scraped.existing_jsonld, null, 2)}
                            </pre>
                          </details>
                        )}
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          {scraped && (
            <div className="proof-card p-5">
              <label className="field-label">Notas del operador</label>
              <textarea
                value={operatorNotes}
                onChange={e => setOperatorNotes(e.target.value)}
                rows={3}
                className="input-field w-full font-mono text-sm resize-none"
                placeholder="Correcciones, datos adicionales, instrucciones especiales para la generación..."
              />
            </div>
          )}

          {scraped && (
            <div className="flex justify-end">
              <button
                onClick={() => setStep(2)}
                className="btn-primary flex items-center gap-2"
              >
                Siguiente: Generar
                <ArrowRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step 2: Generar */}
      {step === 2 && (
        <div className="space-y-4">
          {template && (
            <div className="proof-card p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-ink-muted">Tipo de schema: </span>
                  <span className="text-xs font-mono text-ink font-semibold">
                    {template.schema_type_combo.join(' + ')}
                  </span>
                  <span className="ml-2 chip chip-blue">{template.label_es}</span>
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="btn-orange flex items-center gap-2"
                >
                  <Sparkles size={14} />
                  {generating ? 'Generando...' : 'Generar con IA'}
                </button>
              </div>

              {isSecondaryPage && mainEntity && (
                <div className="mt-3 flex items-start gap-2 bg-blue-50 border border-blue-200 rounded p-2.5">
                  <Info size={13} className="text-blue-600 shrink-0 mt-0.5" />
                  <p className="text-xs font-mono text-blue-700">
                    Página secundaria — se referenciará la entidad principal de la página de inicio.{' '}
                    <span className="text-blue-500 bg-blue-100 px-1 rounded">{mainEntity.id}</span>
                    {' '}({mainEntity.type}: {mainEntity.name})
                  </p>
                </div>
              )}

              {isSecondaryPage && homepageProjectMissing && (
                <div className="mt-3 flex items-start gap-2 bg-amber-50 border border-amber-200 rounded p-2.5">
                  <AlertTriangle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                  <p className="text-xs font-mono text-amber-700">
                    Genera primero el proyecto de la página de inicio (estado: validado o entregado) para referenciar la entidad principal. Puedes generar igualmente sin ella.
                  </p>
                </div>
              )}
            </div>
          )}

          {generateError && (
            <div className="flex items-start gap-2 bg-orange/8 border border-orange/30 rounded p-3">
              <AlertCircle size={14} className="text-orange shrink-0 mt-0.5" />
              <p className="text-xs font-mono text-orange">{generateError}</p>
            </div>
          )}

          {operatorWarning && (
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-300 rounded p-3">
              <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
              <p className="text-xs font-mono text-amber-700">{operatorWarning}</p>
            </div>
          )}

          {jsonld && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Editable form view */}
              <div className="proof-card p-5">
                <h2 className="section-title mb-4">Vista editable</h2>
                <div className="space-y-5">
                  {nodes.map((node, ni) => {
                    const type = getNodeType(node);
                    if (!type) return null;
                    const required = getRequiredFields(type);
                    const fields = editedFields[type] || {};
                    const missingReq = missingRequiredByType[type] ?? [];
                    const missingRec = missingRecommendedByType[type] ?? [];
                    // Generated fields excluding those tracked as missing (avoid duplicates)
                    const generatedEntries = Object.entries(fields).filter(([k]) => !missingReq.includes(k) && !missingRec.includes(k));

                    return (
                      <div key={`${type}-${ni}`}>
                        <div className="flex items-center gap-2 mb-2">
                          <span className="chip chip-ink">{type}</span>
                          {missingReq.filter(f => !fields[f]).length > 0 && (
                            <span className="chip chip-red">
                              {missingReq.filter(f => !fields[f]).length} faltante{missingReq.filter(f => !fields[f]).length !== 1 ? 's' : ''}
                            </span>
                          )}
                        </div>

                        {/* Missing required fields */}
                        {missingReq.length > 0 && (
                          <div className="space-y-2 mb-3 pb-3 border-b border-rule">
                            {missingReq.map(field => {
                              const value = fields[field] ?? '';
                              const isEmpty = !value;
                              return (
                                <div key={`mr-${field}`}>
                                  <label className="flex items-center gap-1.5 field-label">
                                    {field}
                                    {isEmpty && (
                                      <span className="text-red text-[10px] font-semibold uppercase tracking-wider">requerido</span>
                                    )}
                                  </label>
                                  <input
                                    type="text"
                                    value={value}
                                    onChange={e => handleFieldEdit(type, field, e.target.value)}
                                    placeholder="Dato faltante..."
                                    className={`input-field w-full text-xs font-mono ${isEmpty ? 'border-red' : ''}`}
                                  />
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Generated fields */}
                        <div className="space-y-2">
                          {generatedEntries.map(([field, value]) => {
                            const isRequired = required.includes(field);
                            const isEmpty = !value || value === '' || value === '""';
                            return (
                              <div key={field}>
                                <label className="flex items-center gap-1.5 field-label">
                                  {field}
                                  {isRequired && isEmpty && (
                                    <span className="text-orange text-xs">requerido</span>
                                  )}
                                </label>
                                <input
                                  type="text"
                                  value={value}
                                  onChange={e => handleFieldEdit(type, field, e.target.value)}
                                  className={`input-field w-full text-xs font-mono ${
                                    isRequired && isEmpty ? 'border-orange' : ''
                                  }`}
                                />
                              </div>
                            );
                          })}
                        </div>

                        {/* Missing recommended fields — collapsible */}
                        {missingRec.length > 0 && (
                          <div className="mt-3">
                            <button
                              type="button"
                              onClick={() => setRecommendedExpanded(prev => ({ ...prev, [type]: !prev[type] }))}
                              className="flex items-center gap-1.5 text-xs font-mono text-amber-600 hover:text-amber-700"
                            >
                              {recommendedExpanded[type] ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
                              Campos recomendados sin datos ({missingRec.length})
                            </button>
                            {recommendedExpanded[type] && (
                              <div className="space-y-2 mt-2">
                                {missingRec.map(field => {
                                  const value = fields[field] ?? '';
                                  const isEmpty = !value;
                                  return (
                                    <div key={`mr2-${field}`}>
                                      <label className="field-label" style={{ color: isEmpty ? '#92400e' : undefined }}>
                                        {field}
                                      </label>
                                      <input
                                        type="text"
                                        value={value}
                                        onChange={e => handleFieldEdit(type, field, e.target.value)}
                                        placeholder="Recomendado..."
                                        className={`input-field w-full text-xs font-mono ${isEmpty ? 'border-amber-400' : ''}`}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* JSON preview */}
              <div className="proof-card p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="section-title">Vista JSON</h2>
                  <button
                    onClick={() => setJsonPreviewExpanded(v => !v)}
                    className="text-ink-muted hover:text-ink"
                  >
                    {jsonPreviewExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                </div>
                {jsonPreviewExpanded && (
                  <pre className="proof-code text-xs overflow-auto max-h-[500px]">
                    {JSON.stringify(
                      // Strip _operator_notes from preview
                      (() => {
                        const strip = (o: unknown): unknown => {
                          if (Array.isArray(o)) return o.map(strip);
                          if (o && typeof o === 'object') {
                            const r: Record<string, unknown> = {};
                            for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
                              if (k !== '_operator_notes') r[k] = strip(v);
                            }
                            return r;
                          }
                          return o;
                        };
                        return strip(jsonld);
                      })(),
                      null, 2
                    )}
                  </pre>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-between">
            <button onClick={() => setStep(1)} className="btn-ghost flex items-center gap-1.5">
              <ArrowLeft size={14} /> Volver
            </button>
            {jsonld && (
              <button onClick={() => { handleValidate(); setStep(3); }} className="btn-primary flex items-center gap-2">
                Siguiente: Validar
                <ArrowRight size={14} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Step 3: Validar y exportar */}
      {step === 3 && (
        <div className="space-y-4">
          {!validationResult && jsonld && (
            <div className="proof-card p-5 flex items-center justify-between">
              <p className="text-sm text-ink-muted">Ejecuta la validación local antes de exportar.</p>
              <button onClick={handleValidate} className="btn-primary flex items-center gap-2">
                <CheckCircle size={14} />
                Validar schema
              </button>
            </div>
          )}

          {validationResult && (
            <div className="proof-card p-5">
              <div className="flex items-center gap-2 mb-4">
                {validationResult.filter(i => i.severity === 'error').length === 0 ? (
                  <>
                    <CheckCircle size={16} className="text-green" />
                    <span className="text-sm font-semibold text-green">Schema válido</span>
                  </>
                ) : (
                  <>
                    <AlertCircle size={16} className="text-orange" />
                    <span className="text-sm font-semibold text-orange">
                      {validationResult.filter(i => i.severity === 'error').length} error{validationResult.filter(i => i.severity === 'error').length !== 1 ? 'es' : ''}
                    </span>
                  </>
                )}
                {validationResult.filter(i => i.severity === 'warning').length > 0 && (
                  <span className="text-xs font-mono text-amber-600 ml-2">
                    {validationResult.filter(i => i.severity === 'warning').length} advertencia{validationResult.filter(i => i.severity === 'warning').length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {validationResult.filter(i => i.severity === 'error').length > 0 && (
                <div className="space-y-1 mb-3">
                  {validationResult.filter(i => i.severity === 'error').map((e, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs font-mono">
                      <span className="text-orange shrink-0">ERR</span>
                      <span className="text-ink">[{e.node}] {e.message}</span>
                    </div>
                  ))}
                </div>
              )}

              {validationResult.filter(i => i.severity === 'warning').length > 0 && (
                <div className="space-y-1 mb-3">
                  {validationResult.filter(i => i.severity === 'warning').map((w, idx) => (
                    <div key={idx} className="flex items-start gap-2 text-xs font-mono">
                      <span className="text-amber-600 shrink-0">WARN</span>
                      <span className="text-ink-muted">[{w.node}] {w.message}</span>
                    </div>
                  ))}
                </div>
              )}

              <a
                href={richResultsTestUrl(scraped?.page_url ?? pageUrl)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs font-mono text-blue hover:underline"
              >
                <ExternalLink size={12} />
                Verificar en Google Rich Results Test
              </a>
            </div>
          )}

          {jsonld && (
            <div className="proof-card p-5">
              <h2 className="section-title mb-3">Exportar</h2>
              <div className="proof-code text-xs overflow-auto max-h-64 mb-3">
                <pre>{toScriptTag(jsonld)}</pre>
              </div>
              <button
                onClick={handleCopy}
                disabled={copied}
                className="btn-primary flex items-center gap-2"
              >
                {copied ? <Check size={14} /> : <Copy size={14} />}
                {copied ? 'Copiado' : 'Copiar bloque <script>'}
              </button>

              {copyBlockedFields.length > 0 && (
                <div className="flex items-start gap-2 bg-orange/8 border border-orange/30 rounded p-3 mt-3">
                  <AlertCircle size={14} className="text-orange shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-orange mb-1">Exportación bloqueada — valores de marcador detectados</p>
                    <ul className="space-y-0.5 mb-1">
                      {copyBlockedFields.map(f => (
                        <li key={f} className="text-xs font-mono text-orange">{f}</li>
                      ))}
                    </ul>
                    <p className="text-xs font-mono text-ink-muted">Rellena estos campos en el Paso 2 antes de exportar.</p>
                  </div>
                </div>
              )}

              <div className="mt-4 border-t border-rule pt-4">
                <button
                  onClick={() => setWpExpanded(v => !v)}
                  className="flex items-center gap-2 text-xs font-mono text-ink-muted hover:text-ink"
                >
                  {wpExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  Instrucciones WordPress
                </button>
                {wpExpanded && (
                  <div className="mt-3 text-xs font-mono space-y-3 text-ink-muted">
                    <p className="text-ink">Opciones para insertar el bloque en WordPress:</p>
                    <ol className="list-decimal list-inside space-y-2">
                      <li>
                        <span className="text-ink font-medium">WPCode / Insert Headers and Footers:</span>{' '}
                        Instala el plugin, ve a Code Snippets &rsaquo; Header, pega el bloque copiado, guarda.
                      </li>
                      <li>
                        <span className="text-ink font-medium">functions.php / theme:</span>{' '}
                        En Apariencia &rsaquo; Editor de temas, abre{' '}
                        <code className="bg-proof px-1">header.php</code> y pega antes de{' '}
                        <code className="bg-proof px-1">&lt;/head&gt;</code>.
                      </li>
                    </ol>
                    <p className="text-orange">Recuerda: el bloque va en la página exacta que escaneaste, no en todas las páginas.</p>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex justify-between items-center">
            <button onClick={() => setStep(2)} className="btn-ghost flex items-center gap-1.5">
              <ArrowLeft size={14} /> Volver
            </button>
            <button
              onClick={handleDeliver}
              disabled={delivering || project?.status === 'delivered'}
              className={`flex items-center gap-2 text-sm px-4 py-2 rounded border font-mono transition-colors ${
                project?.status === 'delivered'
                  ? 'border-green text-green bg-green/5 cursor-default'
                  : 'btn-primary'
              }`}
            >
              {project?.status === 'delivered' ? (
                <>
                  <Check size={14} /> Entregado
                </>
              ) : (
                <>
                  <CheckCircle size={14} />
                  {delivering ? 'Guardando...' : 'Marcar como entregado'}
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
