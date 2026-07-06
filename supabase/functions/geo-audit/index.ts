// supabase/functions/geo-audit/index.ts
// Checks whether AI crawlers can read the site (robots.txt) and whether llms.txt exists.
// Optionally drafts an llms.txt from provided business data, and generates an improved
// version of an existing llms.txt when checklist gaps are found.
// Deploy: supabase functions deploy geo-audit

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "PerplexityBot",
  "Google-Extended",
  "Bingbot",
  "Applebot-Extended",
  "cohere-ai",
];

// Paths safe to disallow — admin/system, never real content
const NON_CONTENT_PATH = /^\/(wp-admin|wp-includes|wp-login|wp-json|cgi-bin|feed|feeds|trackback|admin|login|xmlrpc)(\/|$)|\.php(\/|\?|$)/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { site_url, business_data, page_urls } = await req.json();
    if (!site_url) return json({ error: "site_url required" }, 400);
    const rawUrl = String(site_url).trim();
    const normalizedUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let origin: string;
    try {
      origin = new URL(normalizedUrl).origin;
    } catch {
      return json({ error: "site_url debe ser una URL completa válida, p. ej. https://ejemplo.com" }, 400);
    }

    // ---- robots.txt check ----
    let robotsFound = false;
    let blockedCrawlers: string[] = [];
    let robotsRaw = "";
    try {
      const r = await fetch(`${origin}/robots.txt`, { redirect: "follow" });
      if (r.ok) {
        robotsFound = true;
        robotsRaw = await r.text();
        blockedCrawlers = findBlockedAiCrawlers(robotsRaw);
      }
    } catch { /* network failure */ }

    // ---- llms.txt check ----
    let llmsFound = false;
    let llmsRaw: string | null = null;
    try {
      const l = await fetch(`${origin}/llms.txt`, { redirect: "follow" });
      if (l.ok) {
        const body = await l.text();
        const looksLikeHtml = /<html|<!doctype/i.test(body.slice(0, 200));
        if (!looksLikeHtml) { llmsFound = true; llmsRaw = body; }
      }
    } catch { /* leave false */ }

    // ---- extract real business data from JSON-LD ----
    const business = business_data ? extractFromJsonLd(business_data) : { services: [] } as BusinessData;
    const pageUrlsList: string[] = Array.isArray(page_urls) ? page_urls : [];

    // ---- draft llms.txt if missing ----
    const generatedLlmsTxt =
      !llmsFound ? draftLlmsTxt(origin, business, pageUrlsList) : null;

    // ---- qualitative analysis ----
    const robots_checklist = robotsFound ? analyzeRobotsTxt(robotsRaw) : null;
    const llmsContent = llmsRaw ?? generatedLlmsTxt ?? null;
    const llms_checklist = llmsContent ? analyzeLlmsTxt(llmsContent) : null;

    // ---- sitemap probe → robots snippet (additive suggestion only) ----
    let suggested_robots_snippet: string | null = null;
    if (robotsFound && robots_checklist && !robots_checklist.has_sitemap) {
      const sitemapUrl = await probeForSitemap(origin);
      if (sitemapUrl) {
        suggested_robots_snippet = `Sitemap: ${sitemapUrl}`;
      }
    }

    // ---- improved llms.txt (existing file with gaps) ----
    let improved_llms_txt: string | null = null;
    if (llmsFound && llmsRaw && llms_checklist) {
      const hasGaps = !llms_checklist.has_business_info
        || llms_checklist.priority_page_count < 3
        || !llms_checklist.has_contact
        || !llms_checklist.has_services;
      if (hasGaps) {
        improved_llms_txt = buildImprovedLlmsTxt(llmsRaw, llms_checklist, business, pageUrlsList);
      }
    }

    return json({
      robots_txt_found: robotsFound,
      robots_txt_raw: robotsRaw || null,
      blocked_ai_crawlers: blockedCrawlers,
      llms_txt_found: llmsFound,
      llms_txt_raw: llmsRaw,
      generated_llms_txt: generatedLlmsTxt,
      verdict: buildVerdict(robotsFound, blockedCrawlers, llmsFound),
      robots_checklist,
      llms_checklist,
      suggested_robots_snippet,
      improved_llms_txt,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ── Business data extraction ──────────────────────────────────────────────────

interface BusinessData {
  name?: string;
  description?: string;
  telephone?: string;
  email?: string;
  address?: string;
  services: string[];
}

function extractFromJsonLd(jsonld: unknown): BusinessData {
  const result: BusinessData = { services: [] };
  if (!jsonld || typeof jsonld !== "object") return result;

  const jld = jsonld as Record<string, unknown>;
  const nodes: unknown[] = Array.isArray(jld["@graph"])
    ? (jld["@graph"] as unknown[])
    : [jsonld];

  for (const raw of nodes) {
    if (!raw || typeof raw !== "object") continue;
    const node = raw as Record<string, unknown>;
    const types = ([] as string[]).concat((node["@type"] as string | string[]) || []);

    if (!result.name && typeof node.name === "string") result.name = node.name;
    if (!result.description && typeof node.description === "string") result.description = node.description;
    if (!result.telephone && typeof node.telephone === "string") result.telephone = node.telephone;
    if (!result.email && typeof node.email === "string") result.email = node.email;
    if (!result.address) {
      if (typeof node.address === "string") {
        result.address = node.address;
      } else if (node.address && typeof node.address === "object") {
        const addr = node.address as Record<string, unknown>;
        if (typeof addr.streetAddress === "string") result.address = addr.streetAddress;
      }
    }
    if (types.includes("Service") && typeof node.name === "string") {
      const entry = typeof node.description === "string"
        ? `${node.name} — ${node.description}`
        : node.name;
      result.services.push(entry);
    }
  }

  return result;
}

// ── Sitemap probe ─────────────────────────────────────────────────────────────

async function probeForSitemap(origin: string): Promise<string | null> {
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { redirect: "follow" });
      if (!r.ok) continue;
      const body = await r.text();
      const looksLikeXml = body.trimStart().startsWith("<?xml") || /<urlset|<sitemapindex/i.test(body.slice(0, 500));
      const looksLikeHtml = /<html|<!doctype/i.test(body.slice(0, 200));
      if (looksLikeXml && !looksLikeHtml) return url;
    } catch { /* try next */ }
  }
  return null;
}

// ── Crawler analysis ──────────────────────────────────────────────────────────

function findBlockedAiCrawlers(robots: string): string[] {
  const blocked = new Set<string>();
  const lines = robots.split(/\r?\n/).map((l) => l.trim());
  let currentAgents: string[] = [];
  let groupOpen = false;

  for (const line of lines) {
    if (line === "" || line.startsWith("#")) continue;
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey.toLowerCase().trim();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      if (!groupOpen) currentAgents = [];
      currentAgents.push(value);
      groupOpen = true;
    } else {
      if (key === "disallow" && value === "/") {
        for (const agent of currentAgents) {
          if (agent === "*") {
            AI_CRAWLERS.forEach((c) => blocked.add(c + " (via wildcard *)"));
          } else {
            const hit = AI_CRAWLERS.find((c) => c.toLowerCase() === agent.toLowerCase());
            if (hit) blocked.add(hit);
          }
        }
      }
      groupOpen = false;
    }
  }
  const explicitAgents = [...robots.matchAll(/user-agent:\s*(.+)/gi)].map((m) => m[1].trim().toLowerCase());
  return [...blocked].filter((b) => {
    if (!b.endsWith("(via wildcard *)")) return true;
    const name = b.replace(" (via wildcard *)", "").toLowerCase();
    return !explicitAgents.includes(name);
  });
}

interface RobotsChecklist {
  has_sitemap: boolean;
  sitemap_url: string | null;
  unusual_disallows: string[];
  high_crawl_delay: { agent: string; delay: number }[];
}

function analyzeRobotsTxt(robots: string): RobotsChecklist {
  const lines = robots.split(/\r?\n/).map((l) => l.trim());
  let has_sitemap = false;
  let sitemap_url: string | null = null;
  const unusual_disallows: string[] = [];
  const high_crawl_delay: { agent: string; delay: number }[] = [];
  let currentAgents: string[] = [];
  let groupOpen = false;

  for (const line of lines) {
    if (!line || line.startsWith("#")) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).toLowerCase().trim();
    const value = line.slice(colonIdx + 1).trim();

    if (key === "sitemap") {
      has_sitemap = true;
      if (!sitemap_url) sitemap_url = value;
      groupOpen = false;
      continue;
    }
    if (key === "user-agent") {
      if (!groupOpen) currentAgents = [];
      currentAgents.push(value);
      groupOpen = true;
      continue;
    }
    if (key === "disallow") {
      if (value && value !== "/" && !NON_CONTENT_PATH.test(value)) {
        if (!unusual_disallows.includes(value)) unusual_disallows.push(value);
      }
      groupOpen = false;
    } else if (key === "crawl-delay") {
      const delay = parseFloat(value);
      if (!isNaN(delay) && delay > 5) {
        for (const agent of currentAgents) high_crawl_delay.push({ agent, delay });
      }
      groupOpen = false;
    } else {
      groupOpen = false;
    }
  }

  return { has_sitemap, sitemap_url, unusual_disallows: unusual_disallows.slice(0, 10), high_crawl_delay };
}

interface LlmsChecklist {
  has_business_info: boolean;
  priority_page_count: number;
  has_contact: boolean;
  has_services: boolean;
}

function analyzeLlmsTxt(text: string): LlmsChecklist {
  const lines = text.split("\n");
  const first10 = lines.slice(0, 10);
  const hasHeading = first10.some((l) => /^#\s+\S/.test(l));
  const hasBlockquote = first10.some((l) => /^>\s+\S/.test(l));
  const has_business_info = hasHeading && hasBlockquote;

  let priority_page_count = 0;
  let inPrioritySection = false;
  for (const line of lines) {
    if (/^#{1,2}\s+(páginas|paginas|pages|principales|priority)/i.test(line)) {
      inPrioritySection = true;
      continue;
    }
    if (/^#{1,2}\s+/.test(line)) inPrioritySection = false;
    if (/^priority:/i.test(line)) priority_page_count++;
    if (inPrioritySection && /\[.+?\]\(https?:\/\/.+?\)/.test(line)) priority_page_count++;
  }

  const has_contact = /[\w.+%-]+@[\w-]+\.[a-z]{2,}|\+?\d[\d\s()./-]{7,}\d|contacto|contact/i.test(text);

  let has_services = false;
  let inServicesSection = false;
  for (const line of lines) {
    if (/^#{1,2}\s+(servicios|services)/i.test(line)) { inServicesSection = true; continue; }
    if (/^#{1,2}\s+/.test(line)) inServicesSection = false;
    if (inServicesSection && /^[-*]\s+\S/.test(line)) { has_services = true; break; }
  }

  return { has_business_info, priority_page_count, has_contact, has_services };
}

// ── llms.txt generators ───────────────────────────────────────────────────────

// From-scratch draft (no llms.txt exists). Uses real data where available, bracketed
// placeholders where the schema didn't supply the field.
function draftLlmsTxt(origin: string, business: BusinessData, pageUrls: string[]): string {
  const lines: string[] = [];
  lines.push(`# ${business.name ?? origin}`);

  const desc = business.description
    ?? "[Agrega aquí una descripción breve de tu negocio]";
  lines.push(`\n> ${desc}`);

  if (business.telephone || business.email || business.address) {
    lines.push(`\n## Contacto`);
    if (business.address) lines.push(`- Dirección: ${business.address}`);
    if (business.telephone) lines.push(`- Teléfono: ${business.telephone}`);
    if (business.email) lines.push(`- Email: ${business.email}`);
  } else {
    lines.push(`\n## Contacto\n- [Agrega tu teléfono y correo aquí]`);
  }

  if (business.services.length > 0) {
    lines.push(`\n## Servicios`);
    business.services.forEach((s) => lines.push(`- ${s}`));
  } else {
    lines.push(`\n## Servicios\n- [Agrega aquí una lista de tus servicios principales]`);
  }

  if (pageUrls.length > 0) {
    lines.push(`\n## Páginas principales`);
    pageUrls.slice(0, 5).forEach((url) => lines.push(`- [${url}](${url})`));
  } else {
    lines.push(`\n## Páginas principales\n- [Agrega aquí tus páginas más importantes]`);
  }

  return lines.join("\n") + "\n";
}

// Improved version of an existing llms.txt — starts from existing content, only appends
// missing sections. Uses real data; falls back to bracketed placeholders.
function buildImprovedLlmsTxt(
  existing: string,
  checklist: LlmsChecklist,
  business: BusinessData,
  pageUrls: string[],
): string {
  let content = existing.trimEnd();

  if (!checklist.has_business_info) {
    const desc = business.description
      ?? "[Agrega aquí una descripción breve de tu negocio — no se encontró una en el schema generado]";
    // Try to insert a blockquote right after the first top-level heading
    if (/^#\s+\S/m.test(content)) {
      content = content.replace(/^(#\s+.+)$/m, `$1\n\n> ${desc}`);
    } else {
      // No heading found at all — prepend business info
      content = `> ${desc}\n\n` + content;
    }
    // Collapse triple+ newlines introduced by the replacement
    content = content.replace(/\n{3,}/g, "\n\n");
  }

  if (checklist.priority_page_count < 3) {
    const needed = 3 - checklist.priority_page_count;
    const missing = pageUrls.filter((url) => !content.includes(url)).slice(0, needed);
    if (missing.length > 0) {
      content += "\n\n## Páginas principales\n" + missing.map((u) => `- [${u}](${u})`).join("\n");
    }
  }

  if (!checklist.has_contact) {
    if (business.telephone || business.email) {
      content += "\n\n## Contacto";
      if (business.telephone) content += `\n- Teléfono: ${business.telephone}`;
      if (business.email) content += `\n- Email: ${business.email}`;
    } else {
      content += "\n\n## Contacto\n- [Agrega tu teléfono y correo aquí]";
    }
  }

  if (!checklist.has_services) {
    if (business.services.length > 0) {
      content += "\n\n## Servicios\n" + business.services.map((s) => `- ${s}`).join("\n");
    } else {
      content += "\n\n## Servicios\n- [Agrega aquí una lista de tus servicios principales]";
    }
  }

  return content + "\n";
}

// ── Verdict ───────────────────────────────────────────────────────────────────

function buildVerdict(robotsFound: boolean, blocked: string[], llmsFound: boolean): string {
  const parts: string[] = [];
  if (!robotsFound) parts.push("No robots.txt found — AI crawlers can read the site by default, but there's no crawl control in place.");
  else if (blocked.length) parts.push(`⚠ ${blocked.length} AI crawler(s) blocked: ${blocked.join(", ")}. The site may be invisible to those AI search tools.`);
  else parts.push("✓ robots.txt present and no AI crawlers blocked.");
  parts.push(llmsFound ? "✓ llms.txt already exists." : "No llms.txt — a draft can be generated (frame to clients as emerging best practice, not a guaranteed fix).");
  return parts.join(" ");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
