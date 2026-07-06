// supabase/functions/geo-audit/index.ts
// Checks whether AI crawlers can read the site (robots.txt) and whether llms.txt exists.
// Optionally drafts an llms.txt from provided business data.
// Deploy: supabase functions deploy geo-audit

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// The AI crawlers that matter for GEO visibility
const AI_CRAWLERS = [
  "GPTBot",           // OpenAI training
  "OAI-SearchBot",    // ChatGPT search
  "ChatGPT-User",     // ChatGPT live browsing
  "ClaudeBot",        // Anthropic
  "Claude-Web",       // Claude browsing
  "PerplexityBot",    // Perplexity
  "Google-Extended",  // Gemini training
  "Bingbot",          // Copilot answers
  "Applebot-Extended",
  "cohere-ai",
];

// Paths that are safe to disallow — admin/system, not real content
const NON_CONTENT_PATH = /^\/(wp-admin|wp-includes|wp-login|wp-json|cgi-bin|feed|feeds|trackback|admin|login|xmlrpc)(\/|$)|\.php(\/|\?|$)/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { site_url, business_data } = await req.json();
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
    } catch { /* network failure — leave robotsFound false */ }

    // ---- llms.txt check ----
    let llmsFound = false;
    let llmsRaw: string | null = null;
    try {
      const l = await fetch(`${origin}/llms.txt`, { redirect: "follow" });
      // Many hosts return a 200 HTML 404 page — verify it looks like markdown/text
      if (l.ok) {
        const body = await l.text();
        const looksLikeHtml = /<html|<!doctype/i.test(body.slice(0, 200));
        if (!looksLikeHtml) { llmsFound = true; llmsRaw = body; }
      }
    } catch { /* leave false */ }

    // ---- draft llms.txt if missing and business data provided ----
    const generatedLlmsTxt =
      !llmsFound && business_data ? draftLlmsTxt(origin, business_data) : null;

    // ---- qualitative analysis ----
    const robots_checklist = robotsFound ? analyzeRobotsTxt(robotsRaw) : null;
    const llmsContent = llmsRaw ?? generatedLlmsTxt ?? null;
    const llms_checklist = llmsContent ? analyzeLlmsTxt(llmsContent) : null;

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
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ── Parsers ───────────────────────────────────────────────────────────────────

// Parses robots.txt user-agent groups and reports AI crawlers hit by "Disallow: /"
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
  // A specific "Allow" group for a crawler overrides the wildcard — simple heuristic:
  // remove wildcard-blocked crawlers that have their own explicit group
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
      // Flag non-empty paths that aren't "/" (full block) and aren't admin/system
      if (value && value !== "/" && !NON_CONTENT_PATH.test(value)) {
        if (!unusual_disallows.includes(value)) unusual_disallows.push(value);
      }
      groupOpen = false;
    } else if (key === "crawl-delay") {
      const delay = parseFloat(value);
      if (!isNaN(delay) && delay > 5) {
        for (const agent of currentAgents) {
          high_crawl_delay.push({ agent, delay });
        }
      }
      groupOpen = false;
    } else {
      groupOpen = false;
    }
  }

  return {
    has_sitemap,
    sitemap_url,
    unusual_disallows: unusual_disallows.slice(0, 10),
    high_crawl_delay,
  };
}

interface LlmsChecklist {
  has_business_info: boolean;
  priority_page_count: number;
  has_contact: boolean;
  has_services: boolean;
}

function analyzeLlmsTxt(text: string): LlmsChecklist {
  const lines = text.split("\n");

  // Business info: top-level # heading + at least one blockquote (> ...) in first 10 lines
  const first10 = lines.slice(0, 10);
  const hasHeading = first10.some((l) => /^#\s+\S/.test(l));
  const hasBlockquote = first10.some((l) => /^>\s+\S/.test(l));
  const has_business_info = hasHeading && hasBlockquote;

  // Priority pages: lines with markdown links under a "páginas / pages / priority" heading
  // OR lines starting with "Priority:"
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

  // Contact: email, phone-like pattern, or literal "contacto"/"contact" keyword
  const has_contact =
    /[\w.+%-]+@[\w-]+\.[a-z]{2,}|\+?\d[\d\s()./-]{7,}\d|contacto|contact/i.test(text);

  // Services: a heading with "servicios"/"services" followed by at least one list item
  let has_services = false;
  let inServicesSection = false;
  for (const line of lines) {
    if (/^#{1,2}\s+(servicios|services)/i.test(line)) {
      inServicesSection = true;
      continue;
    }
    if (/^#{1,2}\s+/.test(line)) inServicesSection = false;
    if (inServicesSection && /^[-*]\s+\S/.test(line)) {
      has_services = true;
      break;
    }
  }

  return { has_business_info, priority_page_count, has_contact, has_services };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function draftLlmsTxt(origin: string, d: {
  name?: string; description?: string; services?: string[];
  phone?: string; address?: string; key_pages?: { title: string; url: string; note?: string }[];
}): string {
  const lines: string[] = [];
  lines.push(`# ${d.name ?? origin}`);
  if (d.description) lines.push(`\n> ${d.description}`);
  if (d.address || d.phone) {
    lines.push(`\n## Contacto`);
    if (d.address) lines.push(`- Dirección: ${d.address}`);
    if (d.phone) lines.push(`- Teléfono: ${d.phone}`);
  }
  if (d.services?.length) {
    lines.push(`\n## Servicios`);
    d.services.forEach((s) => lines.push(`- ${s}`));
  }
  if (d.key_pages?.length) {
    lines.push(`\n## Páginas principales`);
    d.key_pages.forEach((p) => lines.push(`- [${p.title}](${p.url})${p.note ? `: ${p.note}` : ""}`));
  }
  return lines.join("\n") + "\n";
}

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
