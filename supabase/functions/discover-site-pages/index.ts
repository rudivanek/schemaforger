// supabase/functions/discover-site-pages/index.ts
// Discovers pages on a domain via Firecrawl map endpoint, falling back to sitemap.xml

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY") ?? "";
const PAGE_CAP = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const { site_url } = await req.json();
    if (!site_url || !/^https?:\/\//.test(site_url)) {
      return json({ error: "Valid site_url required" }, 400);
    }

    let origin: string;
    try {
      origin = new URL(site_url).origin;
    } catch {
      return json({ error: "Could not parse site_url" }, 400);
    }

    // ── Path 1: Firecrawl map ─────────────────────────────────────────────────
    if (FIRECRAWL_API_KEY) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        const res = await fetch("https://api.firecrawl.dev/v1/map", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${FIRECRAWL_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ url: origin }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (res.ok) {
          const data = await res.json();
          if (data.success && Array.isArray(data.links) && data.links.length > 0) {
            const total = data.links.length;
            const pages = (data.links as string[]).slice(0, PAGE_CAP);
            return json({ pages, source: "firecrawl_map", total_found: total, truncated: total > PAGE_CAP });
          }
        }
      } catch {
        // fall through to sitemap
      }
    }

    // ── Path 2: sitemap.xml fallback ──────────────────────────────────────────
    try {
      const sitemapRes = await fetch(`${origin}/sitemap.xml`, {
        headers: { Accept: "text/xml,application/xml,*/*" },
      });
      if (sitemapRes.ok) {
        const xml = await sitemapRes.text();
        const locs = [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gs)].map(m => m[1].trim());
        if (locs.length > 0) {
          const total = locs.length;
          const pages = locs.slice(0, PAGE_CAP);
          return json({ pages, source: "sitemap", total_found: total, truncated: total > PAGE_CAP });
        }
      }
    } catch {
      // fall through
    }

    return json({ error: "No se pudieron descubrir páginas — Firecrawl map no devolvió resultados y sitemap.xml no está disponible." }, 404);
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
