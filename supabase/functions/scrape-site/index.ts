// supabase/functions/scrape-site/index.ts
// Fetches a page via Firecrawl (JS-rendered) and extracts business data + schema opportunities.

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OpportunityResult {
  detector_id: string;
  label_es: string;
  status: "detected" | "not_detected";
  actionable: boolean;
  extracted_data: unknown | null;
  suggestion_es: string;
}

// deno-lint-ignore no-explicit-any
type Doc = any;

// ── Detectors ─────────────────────────────────────────────────────────────────

function detectBreadcrumb(html: string, doc: Doc): OpportunityResult {
  const BASE = { detector_id: "breadcrumb", label_es: "Breadcrumb" };

  const hasBreadcrumbEl = html.includes("breadcrumb") ||
    html.includes("BreadcrumbList") ||
    html.includes('aria-label="breadcrumb') ||
    html.includes("aria-label='breadcrumb");

  if (hasBreadcrumbEl) {
    const trail: string[] = [];

    // microdata: itemprop="name" inside a BreadcrumbList context
    const microItems = doc.querySelectorAll('[itemprop="name"]');
    if (microItems.length > 0 && microItems.length < 15) {
      microItems.forEach((el: Doc) => {
        const t = el.textContent?.trim();
        if (t && t.length < 100) trail.push(t);
      });
    }

    // nav/class-based breadcrumb containers
    if (trail.length < 2) {
      const candidates = [
        doc.querySelector('nav[aria-label="breadcrumb"]'),
        doc.querySelector('nav[aria-label="Breadcrumb"]'),
        doc.querySelector('.breadcrumb'),
        doc.querySelector('.breadcrumbs'),
        doc.querySelector('[class*="breadcrumb"]'),
      ].filter(Boolean);

      const nav = candidates[0];
      if (nav) {
        const items: string[] = [];
        nav.querySelectorAll('a, li').forEach((el: Doc) => {
          const t = el.textContent?.trim();
          if (t && t.length < 100 && !['>', '›', '»', '/', '|', '\\'].includes(t)) {
            items.push(t);
          }
        });
        items.forEach(t => { if (!trail.includes(t)) trail.push(t); });
      }
    }

    const unique = [...new Set(trail)].slice(0, 10);
    return {
      ...BASE,
      status: "detected",
      actionable: unique.length >= 2,
      extracted_data: unique.length >= 2 ? unique : null,
      suggestion_es: unique.length >= 2
        ? `Ruta detectada: ${unique.join(" › ")}`
        : "Breadcrumb detectado pero no se pudo extraer la ruta completa.",
    };
  }

  return {
    ...BASE,
    status: "not_detected",
    actionable: false,
    extracted_data: null,
    suggestion_es: "No se encontró navegación breadcrumb. Añadir BreadcrumbList ayuda a los motores de búsqueda y modelos de IA a entender la jerarquía del sitio, mejorando la visibilidad en búsquedas estructuradas.",
  };
}

interface QAPair { question: string; answer: string; }

// Returns true only if the text looks like a genuine question:
// ends with "?" OR starts with a recognized interrogative word.
function looksLikeQuestion(text: string): boolean {
  if (text.trim().endsWith("?")) return true;
  return /^(qué|que|cómo|como|cuándo|cuando|dónde|donde|por\s+qué|por\s+que|cuál|cual|quién|quien|what|how|when|where|why|which|who|is|are|does|can)\b/i.test(text.trim());
}

function detectFaq(html: string, doc: Doc): OpportunityResult {
  const BASE = { detector_id: "faq", label_es: "Preguntas frecuentes" };
  const pairs: QAPair[] = [];

  // Details/summary — most reliable structural signal
  const details = doc.querySelectorAll("details");
  if (details.length > 0) {
    details.forEach((d: Doc, i: number) => {
      if (i >= 15) return;
      const summary = d.querySelector("summary");
      const question = summary?.textContent?.trim() ?? "";
      const allText = d.textContent?.trim() ?? "";
      const answer = allText.replace(question, "").trim().slice(0, 400);
      if (question && answer.length > 10 && looksLikeQuestion(question)) {
        pairs.push({ question, answer });
      }
    });
  }

  // FAQ class containers — only when there's an explicit FAQ-named section
  if (pairs.length === 0) {
    const containers = [
      doc.querySelector(".faq"),
      doc.querySelector("#faq"),
      doc.querySelector(".faqs"),
      doc.querySelector("[class*='faq']"),
      doc.querySelector(".preguntas"),
      doc.querySelector("#preguntas"),
      // accordion only accepted when there is also a FAQ heading signal in the page
    ].filter(Boolean);

    const hasFaqHeading = /preguntas\s+frecuentes|preguntas\s+y\s+respuestas|frequently\s+asked|\bfaq\b/i.test(html);

    // Accept accordion containers only if the page has a real FAQ heading
    if (hasFaqHeading && containers.length === 0) {
      const acc = doc.querySelector("[class*='accordion']");
      if (acc) containers.push(acc);
    }

    const container = containers[0];
    if (container) {
      const qEls = container.querySelectorAll("h3, h4, dt, strong");
      qEls.forEach((el: Doc, i: number) => {
        if (i >= 15) return;
        const q = el.textContent?.trim() ?? "";
        if (!q || q.length < 10) return;
        if (!looksLikeQuestion(q)) return; // discard non-question text (e.g. "Ver testimonio")
        const parentText = el.parentElement?.textContent?.trim() ?? container.textContent?.trim() ?? "";
        const answer = parentText.replace(q, "").trim().slice(0, 400);
        if (answer.length > 20) pairs.push({ question: q, answer });
      });
    }
  }

  // Require at least 2 valid Q&A pairs before claiming detected+actionable
  const validPairs = pairs.filter(p => looksLikeQuestion(p.question));

  const hasFaqSignal = /preguntas\s+frecuentes|preguntas\s+y\s+respuestas|frequently\s+asked|\bfaq\b/i.test(html);

  if (validPairs.length >= 2) {
    return {
      ...BASE,
      status: "detected",
      actionable: true,
      extracted_data: validPairs.slice(0, 15),
      suggestion_es: `${validPairs.length} par${validPairs.length !== 1 ? "es" : ""} de pregunta/respuesta detectado${validPairs.length !== 1 ? "s" : ""}.`,
    };
  }

  if (hasFaqSignal) {
    return {
      ...BASE,
      status: "detected",
      actionable: false,
      extracted_data: null,
      suggestion_es: "Se detectó una sección FAQ pero no se pudo extraer las preguntas estructuradas.",
    };
  }

  return {
    ...BASE,
    status: "not_detected",
    actionable: false,
    extracted_data: null,
    suggestion_es: "No hay sección de preguntas frecuentes. Una FAQPage bien estructurada mejora la visibilidad en búsquedas conversacionales y aumenta la probabilidad de ser citado por modelos de IA.",
  };
}

interface VideoData { url: string; title?: string; }

function detectVideo(_html: string, doc: Doc): OpportunityResult {
  const BASE = { detector_id: "video", label_es: "Video" };
  let videoData: VideoData | null = null;

  doc.querySelectorAll("iframe").forEach((iframe: Doc) => {
    if (videoData) return;
    const src = iframe.getAttribute("src") ?? "";
    if (/youtube\.com\/embed|youtu\.be|vimeo\.com\/video|wistia\.net|loom\.com/.test(src)) {
      // Nearby heading/caption
      const titleCandidates = [
        doc.querySelector("figcaption"),
        doc.querySelector("h2"),
        doc.querySelector("h3"),
      ].filter(Boolean);
      const title = titleCandidates[0]?.textContent?.trim() || undefined;
      videoData = { url: src, title };
    }
  });

  if (!videoData) {
    const video = doc.querySelector("video");
    if (video) {
      const src = video.getAttribute("src") ?? video.querySelector("source")?.getAttribute("src") ?? "";
      if (src) videoData = { url: src };
    }
  }

  if (videoData) {
    return {
      ...BASE,
      status: "detected",
      actionable: true,
      extracted_data: videoData,
      suggestion_es: videoData.title
        ? `Video detectado: "${videoData.title}"`
        : `Video detectado: ${videoData.url.slice(0, 70)}`,
    };
  }

  return { ...BASE, status: "not_detected", actionable: false, extracted_data: null, suggestion_es: "" };
}

interface ReviewSnippet { text: string; author?: string; rating?: number; }

function detectReviewsUnmarked(html: string, doc: Doc, existingTypes: string[]): OpportunityResult {
  const BASE = { detector_id: "reviews_unmarked", label_es: "Reseñas / Testimonios" };

  if (existingTypes.some(t => ["Review", "AggregateRating"].includes(t))) {
    return { ...BASE, status: "not_detected", actionable: false, extracted_data: null, suggestion_es: "" };
  }

  // HTML string signal: testimonial/review class names
  const hasSocialProof = /class=["'][^"']*testimoni|class=["'][^"']*review|class=["'][^"']*opinion|class=["'][^"']*reseña/i.test(html);

  if (hasSocialProof) {
    const snippets: ReviewSnippet[] = [];
    for (const sel of ["[class*='testimonial']", "[class*='review']", "[class*='opinion']", "[class*='reseña']"]) {
      try {
        doc.querySelectorAll(sel).forEach((el: Doc, i: number) => {
          if (i >= 5 || snippets.length >= 5) return;
          const text = el.textContent?.trim() ?? "";
          if (text.length < 30) return;

          // Cross-contamination guard: skip elements that look like FAQ items
          // (their primary text content is a question, not a social proof statement)
          const headingEl = el.querySelector("h3, h4, dt, strong, summary");
          const headingText = headingEl?.textContent?.trim() ?? "";
          if (looksLikeQuestion(headingText)) return;

          const authorEl = el.querySelector("cite") ?? el.querySelector("[class*='author']") ?? el.querySelector("[class*='name']");
          const author = authorEl?.textContent?.trim() || undefined;
          const starMatch = text.match(/★{1,5}|⭐{1,5}/);
          const rating = starMatch ? (starMatch[0].match(/[★⭐]/g)?.length ?? undefined) : undefined;
          snippets.push({ text: text.slice(0, 300), author, rating });
        });
        if (snippets.length > 0) break;
      } catch { /* skip unsupported selector */ }
    }

    if (snippets.length > 0) {
      return {
        ...BASE,
        status: "detected",
        actionable: true,
        extracted_data: snippets,
        suggestion_es: `${snippets.length} testimonio${snippets.length !== 1 ? "s" : ""} sin markup de schema detectado${snippets.length !== 1 ? "s" : ""}.`,
      };
    }
    return {
      ...BASE,
      status: "detected",
      actionable: false,
      extracted_data: null,
      suggestion_es: "Se detectaron secciones de testimonios/reseñas pero no se pudo extraer el contenido estructurado.",
    };
  }

  if (/★{4,5}|⭐{4,5}/.test(html)) {
    return {
      ...BASE,
      status: "detected",
      actionable: false,
      extracted_data: null,
      suggestion_es: "Se detectaron calificaciones con estrellas en la página.",
    };
  }

  return { ...BASE, status: "not_detected", actionable: false, extracted_data: null, suggestion_es: "" };
}

interface HowToStepData { name: string; text?: string; }

function detectHowTo(html: string, doc: Doc): OpportunityResult {
  const BASE = { detector_id: "howto", label_es: "Guía paso a paso" };

  if (!/\bpaso\s+\d|\bstep\s+\d|\bcómo\s+(?:hacer|instalar|usar|crear|configurar)|how\s+to\s+\w/i.test(html)) {
    return { ...BASE, status: "not_detected", actionable: false, extracted_data: null, suggestion_es: "" };
  }

  const steps: HowToStepData[] = [];

  // Strategy 1: explicit "Paso N / Step N" headings
  doc.querySelectorAll("h2, h3, h4").forEach((h: Doc) => {
    const text = h.textContent?.trim() ?? "";
    if (/\bpaso\s+\d|\bstep\s+\d/i.test(text)) steps.push({ name: text });
  });

  // Strategy 2: ordered list under a "cómo / how-to" heading
  if (steps.length < 3) {
    let found = false;
    doc.querySelectorAll("h1, h2, h3").forEach((h: Doc) => {
      if (found) return;
      if (/cómo|how\s+to|proceso|pasos\s+para|instrucciones|tutorial/i.test(h.textContent ?? "")) {
        doc.querySelectorAll("ol").forEach((ol: Doc) => {
          if (found) return;
          const lis: HowToStepData[] = [];
          ol.querySelectorAll("li").forEach((li: Doc, i: number) => {
            if (i >= 15) return;
            const name = li.textContent?.trim()?.slice(0, 200) ?? "";
            if (name) lis.push({ name });
          });
          if (lis.length >= 3) { found = true; lis.forEach(s => steps.push(s)); }
        });
      }
    });
  }

  if (steps.length >= 3) {
    return {
      ...BASE,
      status: "detected",
      actionable: true,
      extracted_data: steps.slice(0, 15),
      suggestion_es: `${steps.length} pasos de proceso detectados.`,
    };
  }

  return { ...BASE, status: "not_detected", actionable: false, extracted_data: null, suggestion_es: "" };
}

interface JobData { title: string; description?: string; }

function detectTldr(_html: string, doc: Doc): OpportunityResult {
  const BASE = { detector_id: "tldr", label_es: "Resumen / TL;DR" };

  // Explicit summary/tldr/resumen containers
  const candidates = [
    doc.querySelector('[class*="summary"]'),
    doc.querySelector('[id*="summary"]'),
    doc.querySelector('[class*="tldr"]'),
    doc.querySelector('[id*="tldr"]'),
    doc.querySelector('[class*="resumen"]'),
    doc.querySelector('[id*="resumen"]'),
  ].filter(Boolean);

  for (const el of candidates) {
    const text = el.textContent?.trim() ?? "";
    if (text.length > 20 && text.length < 400) {
      return {
        ...BASE,
        status: "detected",
        actionable: false,
        extracted_data: { text: text.slice(0, 300) },
        suggestion_es: "Se detectó un bloque de resumen/TL;DR al inicio del contenido.",
      };
    }
  }

  // Heuristic: first paragraph is short + precedes longer paragraphs
  const paras: string[] = [];
  doc.querySelectorAll("p").forEach((p: Doc) => {
    const t = p.textContent?.trim() ?? "";
    if (t.length > 20) paras.push(t);
  });

  if (paras.length >= 2 && paras[0].length < 300 && paras[1].length >= 300) {
    return {
      ...BASE,
      status: "detected",
      actionable: false,
      extracted_data: { text: paras[0] },
      suggestion_es: "Se detectó un párrafo introductorio breve que funciona como resumen.",
    };
  }

  return {
    ...BASE,
    status: "not_detected",
    actionable: false,
    extracted_data: null,
    suggestion_es: "No se detectó un resumen breve (TL;DR) al inicio del contenido. Un resumen corto y directo ayuda a que las herramientas de IA extraigan y citen la información clave más fácilmente.",
  };
}

function detectJobPosting(html: string, doc: Doc): OpportunityResult {
  const BASE = { detector_id: "jobposting", label_es: "Vacantes" };

  if (!/vacante|empleo[s]?\s|carrera[s]?\s|career[s]?\s|job\s+opening|we.re\s+hiring|join\s+our\s+team/i.test(html)) {
    return { ...BASE, status: "not_detected", actionable: false, extracted_data: null, suggestion_es: "" };
  }

  const jobs: JobData[] = [];

  try {
    doc.querySelectorAll("[class*='job'], [class*='career'], [class*='vacancy'], [class*='vacante']").forEach((el: Doc, i: number) => {
      if (i >= 10) return;
      const heading = el.querySelector("h2, h3, h4, strong");
      const title = heading?.textContent?.trim() ?? el.textContent?.trim()?.slice(0, 100) ?? "";
      if (title) jobs.push({ title, description: el.textContent?.trim()?.slice(0, 300) });
    });
  } catch { /* ok */ }

  if (jobs.length === 0) {
    doc.querySelectorAll("h2, h3").forEach((h: Doc) => {
      if (/vacante|empleo|career|job/i.test(h.textContent ?? "")) {
        jobs.push({ title: h.textContent?.trim() ?? "" });
      }
    });
  }

  if (jobs.length > 0) {
    return {
      ...BASE,
      status: "detected",
      actionable: true,
      extracted_data: jobs.slice(0, 10),
      suggestion_es: `${jobs.length} vacante${jobs.length !== 1 ? "s" : ""} detectada${jobs.length !== 1 ? "s" : ""}.`,
    };
  }

  return { ...BASE, status: "not_detected", actionable: false, extracted_data: null, suggestion_es: "" };
}

// ── Detector registry ─────────────────────────────────────────────────────────

// "always_advise" detectors emit advisory cards even when not_detected.
// All others are silent when not_detected.
const ALWAYS_ADVISE = new Set(["breadcrumb", "faq", "tldr"]);

interface DetectorEntry {
  run: (html: string, doc: Doc, meta: { existingTypes: string[] }) => OpportunityResult;
}

const DETECTORS: DetectorEntry[] = [
  { run: (html, doc) => detectBreadcrumb(html, doc) },
  { run: (html, doc) => detectFaq(html, doc) },
  { run: (html, doc) => detectTldr(html, doc) },
  { run: (html, doc) => detectVideo(html, doc) },
  { run: (html, doc, { existingTypes }) => detectReviewsUnmarked(html, doc, existingTypes) },
  { run: (html, doc) => detectHowTo(html, doc) },
  { run: (html, doc) => detectJobPosting(html, doc) },
];

function runDetectors(html: string, doc: Doc, existingTypes: string[]): OpportunityResult[] {
  const results: OpportunityResult[] = [];
  for (const d of DETECTORS) {
    try {
      const result = d.run(html, doc, { existingTypes });
      if (result.status === "detected" || ALWAYS_ADVISE.has(result.detector_id)) {
        results.push(result);
      }
    } catch { /* never let a failing detector break the scrape */ }
  }
  return results;
}

// ── Main handler ──────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { url } = await req.json();
    if (!url || !/^https?:\/\//.test(url)) {
      return json({ error: "Valid URL required" }, 400);
    }
    if (!FIRECRAWL_API_KEY) {
      return json({ error: "FIRECRAWL_API_KEY not configured" }, 500);
    }

    // 30-second timeout — headless rendering is slower than a plain fetch
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);

    let html: string;
    let markdown: string;

    try {
      const fcRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, formats: ["rawHtml", "markdown"] }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!fcRes.ok) {
        const body = await fcRes.text();
        return json({ error: `Firecrawl error: ${fcRes.status} — ${body.slice(0, 200)}` }, 502);
      }

      const fcData = await fcRes.json();
      if (!fcData.success) {
        return json({ error: `Firecrawl failed: ${fcData.error ?? "unknown error"}` }, 502);
      }

      html = fcData.data?.rawHtml ?? "";
      markdown = fcData.data?.markdown ?? "";
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === "AbortError") {
        return json({ error: "Scrape timed out after 30s" }, 504);
      }
      throw e;
    }

    if (!html) return json({ error: "Firecrawl returned no HTML" }, 502);

    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) return json({ error: "Could not parse HTML" }, 500);

    const text = (sel: string) => doc.querySelector(sel)?.textContent?.trim() ?? null;
    const attr = (sel: string, a: string) => doc.querySelector(sel)?.getAttribute(a) ?? null;

    // Existing JSON-LD — preserve class and id for plugin fingerprinting
    const existingJsonLd: unknown[] = [];
    const jsonLdSignals: string[] = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s: Doc) => {
      const cls = s.getAttribute("class") ?? "";
      const id = s.getAttribute("id") ?? "";
      jsonLdSignals.push(`${cls} ${id}`);
      try { existingJsonLd.push(JSON.parse(s.textContent ?? "")); } catch { /* skip malformed */ }
    });

    // SEO plugin detection
    const generatorMeta = attr('meta[name="generator"]', "content") ?? "";
    const signalText = jsonLdSignals.join(" ");
    const hasYoastClass = /yoast-schema-graph/i.test(signalText);
    const hasRankMathClass = /rank-math-schema/i.test(signalText);
    const hasYoastPath = html.includes("/plugins/wordpress-seo/");
    const hasRankMathPath = html.includes("/plugins/seo-by-rank-math/");
    const hasYoastGenerator = /yoast/i.test(generatorMeta);
    const hasRankMathGenerator = /rank math/i.test(generatorMeta);

    type SchemaSource = "yoast" | "rankmath" | "other" | "none";
    let schema_source: SchemaSource = "none";
    if (hasYoastClass || hasYoastPath || hasYoastGenerator) schema_source = "yoast";
    else if (hasRankMathClass || hasRankMathPath || hasRankMathGenerator) schema_source = "rankmath";
    else if (existingJsonLd.length > 0) schema_source = "other";

    // Phone + email
    const bodyText = doc.body?.textContent ?? "";
    const telLink = attr('a[href^="tel:"]', "href")?.replace("tel:", "") ?? null;
    const mailLink = attr('a[href^="mailto:"]', "href")?.replace("mailto:", "").split("?")[0] ?? null;
    const phoneMatch = telLink ?? bodyText.match(/(\+?\d{1,3}[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/)?.[0] ?? null;

    // Social profiles
    const sameAs = new Set<string>();
    doc.querySelectorAll("a[href]").forEach((a: Doc) => {
      const href = a.getAttribute("href") ?? "";
      if (/facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|maps\.google|goo\.gl\/maps/.test(href)) {
        sameAs.add(href);
      }
    });

    // Collect existing schema types for detector context
    const existingTypes: string[] = [];
    existingJsonLd.forEach(item => {
      const walk = (v: unknown) => {
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v && typeof v === "object") {
          const t = (v as Record<string, unknown>)["@type"];
          if (typeof t === "string") existingTypes.push(t);
          else if (Array.isArray(t)) t.forEach(s => existingTypes.push(String(s)));
          Object.values(v as object).forEach(walk);
        }
      };
      walk(item);
    });

    // Run opportunity detectors
    const opportunities = runDetectors(html, doc, existingTypes);

    const scraped = {
      page_url: url,
      title: text("title"),
      meta_description: attr('meta[name="description"]', "content"),
      og_site_name: attr('meta[property="og:site_name"]', "content"),
      og_image: attr('meta[property="og:image"]', "content"),
      h1: text("h1"),
      phone: phoneMatch,
      email: mailLink,
      address_hint: text("address") ?? text('[class*="address" i]') ?? text('[itemprop="address"]'),
      hours_hint: text('[class*="hours" i], [class*="horario" i]'),
      same_as: [...sameAs].slice(0, 10),
      existing_jsonld: existingJsonLd,
      schema_source,
      visible_text_sample: markdown.slice(0, 6000),
      opportunities,
    };

    return json({ scraped });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
