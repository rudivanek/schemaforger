// supabase/functions/scrape-site/index.ts
// Fetches a page and extracts business data for schema generation.
// Deploy: supabase functions deploy scrape-site

import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { url } = await req.json();
    if (!url || !/^https?:\/\//.test(url)) {
      return json({ error: "Valid URL required" }, 400);
    }

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
      },
      redirect: "follow",
    });
    if (!res.ok) return json({ error: `Fetch failed: ${res.status}` }, 502);

    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) return json({ error: "Could not parse HTML" }, 500);

    const text = (sel: string) => doc.querySelector(sel)?.textContent?.trim() ?? null;
    const attr = (sel: string, a: string) => doc.querySelector(sel)?.getAttribute(a) ?? null;

    // Existing JSON-LD on the page (important: don't duplicate what's there)
    // We also read class attributes on each script tag for plugin detection.
    const existingJsonLd: unknown[] = [];
    const jsonLdClasses: string[] = [];
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      jsonLdClasses.push(s.getAttribute("class") ?? "");
      try { existingJsonLd.push(JSON.parse(s.textContent ?? "")); } catch { /* skip malformed */ }
    });

    // --- SEO plugin detection ---
    const generatorMeta = attr('meta[name="generator"]', "content") ?? "";
    const classSignal = jsonLdClasses.join(" ");
    const hasYoastClass = /yoast-schema-graph/i.test(classSignal);
    const hasRankMathClass = /rank-math-schema/i.test(classSignal);
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
      // Trimmed visible text so Claude can extract services/ratings with judgment,
      // and so the mismatch check compares against what's actually on the page
      visible_text_sample: bodyText.replace(/\s+/g, " ").slice(0, 6000),
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
