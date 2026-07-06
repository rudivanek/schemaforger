// supabase/functions/scrape-site/index.ts
// Fetches a page via Firecrawl (handles JS-rendered pages) and extracts business data for schema generation.

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";

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

    // 30s timeout — headless rendering is slower than a plain fetch
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    let html: string;
    let markdown: string;

    try {
      const fcRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url, formats: ["html", "markdown"] }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!fcRes.ok) {
        const body = await fcRes.text();
        return json({ error: `Firecrawl error: ${fcRes.status} — ${body.slice(0, 200)}` }, 502);
      }

      const fcData = await fcRes.json();
      if (!fcData.success) {
        return json({ error: `Firecrawl failed: ${fcData.error ?? "unknown error"}` }, 502);
      }

      html = fcData.data?.html ?? "";
      markdown = fcData.data?.markdown ?? "";
    } catch (e) {
      clearTimeout(timeout);
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

    // Existing JSON-LD — preserve class and id on each script tag for plugin fingerprinting
    // (yoast-schema-graph, rank-math-schema class names; Firecrawl HTML includes JS-injected scripts)
    const existingJsonLd: unknown[] = [];
    const jsonLdSignals: string[] = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
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
    if (hasYoastClass || hasYoastPath || hasYoastGenerator) {
      schema_source = "yoast";
    } else if (hasRankMathClass || hasRankMathPath || hasRankMathGenerator) {
      schema_source = "rankmath";
    } else if (existingJsonLd.length > 0) {
      schema_source = "other";
    }

    // Phone + email from tel:/mailto: links, fallback to regex on body text
    const bodyText = doc.body?.textContent ?? "";
    const telLink = attr('a[href^="tel:"]', "href")?.replace("tel:", "") ?? null;
    const mailLink = attr('a[href^="mailto:"]', "href")?.replace("mailto:", "").split("?")[0] ?? null;
    const phoneMatch = telLink ?? bodyText.match(/(\+?\d{1,3}[\s.-]?)?\(?\d{2,3}\)?[\s.-]?\d{3,4}[\s.-]?\d{4}/)?.[0] ?? null;

    // Social profiles for sameAs
    const sameAs = new Set<string>();
    doc.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href") ?? "";
      if (/facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|maps\.google|goo\.gl\/maps/.test(href)) {
        sameAs.add(href);
      }
    });

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
      // Firecrawl's markdown is cleaner than raw body text — use it as the visible sample
      visible_text_sample: markdown.slice(0, 6000),
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
