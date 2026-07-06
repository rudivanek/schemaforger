// supabase/functions/generate-tldr/index.ts
// Summarizes visible page text into a short TL;DR paragraph for manual placement
// in the page body (HTML/copy) — never written to JSON-LD/schema.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { visible_text_sample, business_name } = await req.json();
    if (!visible_text_sample) return json({ error: "visible_text_sample required" }, 400);

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY not configured" }, 500);

    const systemPrompt =
      "Summarize the following page content into a single short paragraph (2–3 sentences, under 300 characters) suitable as a TL;DR at the top of the page. " +
      "Use ONLY information present in the provided text — do not add facts, statistics, or claims not stated in the source. " +
      "Write in the same language as the source text. " +
      "Output ONLY the summary paragraph, no preamble, no markdown, no quotation marks.";

    const userContent = business_name
      ? `Business: ${business_name}\n\n${visible_text_sample.slice(0, 4000)}`
      : visible_text_sample.slice(0, 4000);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 256,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return json({ error: `Anthropic error: ${res.status} — ${body.slice(0, 200)}` }, 502);
    }

    const data = await res.json();
    const suggested_tldr = data.content?.[0]?.text?.trim() ?? "";
    if (!suggested_tldr) return json({ error: "No response from model" }, 502);

    return json({ suggested_tldr });
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
