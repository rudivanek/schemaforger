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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { site_url, business_data } = await req.json();
    if (!site_url) return json({ error: "site_url required" }, 400);
    const origin = new URL(site_url).origin;

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

    return json({
      robots_txt_found: robotsFound,
      robots_txt_raw: robotsRaw || null,
      blocked_ai_crawlers: blockedCrawlers,
      llms_txt_found: llmsFound,
      llms_txt_raw: llmsRaw,
      generated_llms_txt: generatedLlmsTxt,
      verdict: buildVerdict(robotsFound, blockedCrawlers, llmsFound),
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

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
