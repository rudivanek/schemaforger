// supabase/functions/generate-schema/index.ts
// Sends scraped data + vertical template to Claude, returns validated-shape JSON-LD.
// Appends opportunity nodes (BreadcrumbList, FAQPage, VideoObject, etc.) built deterministically
// from extracted_data — never invented by the model.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { scraped, template, extra_info, main_entity, included_opportunities } = await req.json();
    if (!scraped || !template) return json({ error: "scraped and template required" }, 400);

    const systemPrompt = buildSystemPrompt(template, main_entity ?? null);
    const userPrompt = buildUserPrompt(scraped, extra_info);

    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Deno.env.get("ANTHROPIC_API_KEY") ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errBody = await anthropicRes.text();
      return json({ error: `Anthropic API ${anthropicRes.status}: ${errBody}` }, 502);
    }

    const data = await anthropicRes.json();
    const raw = (data.content ?? [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("\n")
      .replace(/```json|```/g, "")
      .trim();

    let jsonld: Record<string, unknown>;
    try {
      jsonld = stripPlaceholders(JSON.parse(raw)) as Record<string, unknown>;
    } catch {
      return json({ error: "Model returned non-JSON output", raw }, 422);
    }

    // Append opportunity nodes built deterministically from extracted_data
    if (Array.isArray(included_opportunities) && included_opportunities.length > 0) {
      const pageUrl: string = scraped?.page_url ?? "";
      const mainEntityId = findMainEntityId(jsonld, main_entity);
      const oppNodes = buildOpportunityNodes(included_opportunities, pageUrl, mainEntityId);
      if (oppNodes.length > 0) {
        jsonld = mergeIntoGraph(jsonld, oppNodes);
      }
    }

    return json({ jsonld });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

// ── Opportunity node builders ─────────────────────────────────────────────────

interface IncludedOpportunity {
  detector_id: string;
  extracted_data: unknown;
}

function findMainEntityId(
  jsonld: Record<string, unknown>,
  mainEntity?: { id: string } | null,
): string | undefined {
  if (mainEntity?.id) return mainEntity.id;
  const graph = jsonld["@graph"];
  if (Array.isArray(graph)) {
    for (const node of graph) {
      const n = node as Record<string, unknown>;
      if (typeof n["@id"] === "string") return n["@id"];
    }
  }
  if (typeof jsonld["@id"] === "string") return jsonld["@id"];
  return undefined;
}

function mergeIntoGraph(jsonld: Record<string, unknown>, nodes: unknown[]): Record<string, unknown> {
  if (Array.isArray(jsonld["@graph"])) {
    return { ...jsonld, "@graph": [...(jsonld["@graph"] as unknown[]), ...nodes] };
  }
  const ctx = jsonld["@context"] ?? "https://schema.org";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { "@context": _ctx, ...rest } = jsonld;
  return { "@context": ctx, "@graph": [rest, ...nodes] };
}

function buildOpportunityNodes(
  included: IncludedOpportunity[],
  pageUrl: string,
  mainEntityId: string | undefined,
): unknown[] {
  const nodes: unknown[] = [];

  for (const opp of included) {
    switch (opp.detector_id) {
      case "breadcrumb": {
        const trail = opp.extracted_data as string[] | null;
        if (!Array.isArray(trail) || trail.length < 2) break;
        nodes.push({
          "@type": "BreadcrumbList",
          "@id": `${pageUrl}#breadcrumb`,
          "itemListElement": trail.map((name, idx) => ({
            "@type": "ListItem",
            "position": idx + 1,
            "name": name,
          })),
        });
        break;
      }

      case "faq": {
        const pairs = opp.extracted_data as Array<{ question: string; answer: string }> | null;
        if (!Array.isArray(pairs) || pairs.length === 0) break;
        const faqNode: Record<string, unknown> = {
          "@type": "FAQPage",
          "@id": `${pageUrl}#faq`,
          "mainEntity": pairs.map(p => ({
            "@type": "Question",
            "name": p.question,
            "acceptedAnswer": { "@type": "Answer", "text": p.answer },
          })),
        };
        if (mainEntityId) faqNode["about"] = { "@id": mainEntityId };
        nodes.push(faqNode);
        break;
      }

      case "video": {
        const video = opp.extracted_data as { url: string; title?: string } | null;
        if (!video?.url) break;
        const videoNode: Record<string, unknown> = {
          "@type": "VideoObject",
          "@id": `${pageUrl}#video`,
          "embedUrl": video.url,
        };
        if (video.title) videoNode["name"] = video.title;
        if (mainEntityId) videoNode["publisher"] = { "@id": mainEntityId };
        nodes.push(videoNode);
        break;
      }

      case "reviews_unmarked": {
        const reviews = opp.extracted_data as Array<{ text: string; author?: string; rating?: number }> | null;
        if (!Array.isArray(reviews)) break;
        reviews.forEach((r, i) => {
          const review: Record<string, unknown> = {
            "@type": "Review",
            "@id": `${pageUrl}#review-${i}`,
            "reviewBody": r.text,
          };
          if (r.author) review["author"] = { "@type": "Person", "name": r.author };
          // Only add numeric rating if explicitly present per review; no fabricated AggregateRating
          if (r.rating) review["reviewRating"] = { "@type": "Rating", "ratingValue": r.rating, "bestRating": 5 };
          if (mainEntityId) review["itemReviewed"] = { "@id": mainEntityId };
          nodes.push(review);
        });
        break;
      }

      case "howto": {
        const steps = opp.extracted_data as Array<{ name: string; text?: string }> | null;
        if (!Array.isArray(steps) || steps.length < 3) break;
        const howtoNode: Record<string, unknown> = {
          "@type": "HowTo",
          "@id": `${pageUrl}#howto`,
          "step": steps.map((s, i) => ({
            "@type": "HowToStep",
            "position": i + 1,
            "name": s.name,
            ...(s.text ? { "text": s.text } : {}),
          })),
        };
        if (mainEntityId) howtoNode["provider"] = { "@id": mainEntityId };
        nodes.push(howtoNode);
        break;
      }

      case "jobposting": {
        const jobs = opp.extracted_data as Array<{ title: string; description?: string }> | null;
        if (!Array.isArray(jobs)) break;
        jobs.forEach((j, i) => {
          const job: Record<string, unknown> = {
            "@type": "JobPosting",
            "@id": `${pageUrl}#job-${i}`,
            "title": j.title,
          };
          if (j.description) job["description"] = j.description;
          if (mainEntityId) job["hiringOrganization"] = { "@id": mainEntityId };
          nodes.push(job);
        });
        break;
      }

      default:
        break;
    }
  }

  return nodes;
}

// ── Prompt builders ───────────────────────────────────────────────────────────

function buildSystemPrompt(
  template: {
    vertical: string;
    schema_type_combo: string[];
    required_fields: Record<string, string[]>;
    recommended_fields: Record<string, string[]>;
    prompt_notes: string | null;
  },
  mainEntity: { id: string; type: string; name: string } | null,
): string {
  const secondaryPageRule = mainEntity
    ? `\n8. SECONDARY PAGE MODE: The business entity already exists in the site's schema as ${mainEntity.type} with @id '${mainEntity.id}' (${mainEntity.name}), defined on the site's main page. Do NOT create a new ${mainEntity.type} node and do NOT repeat its address, telephone, hours, or other business-level properties. Instead: (a) generate only the page-specific types appropriate to THIS page's content (e.g. MedicalProcedure, Service, FAQPage, ContactPage, Physician as main entity of a bio page); (b) wherever a node needs to point to the business (provider, performer, worksFor, publisher, about, parentOrganization), use a bare reference: {"@id": "${mainEntity.id}"}; (c) if this page's content contradicts the main entity's data, do not resolve it silently — flag it in _operator_notes.`
    : "";

  return `You are a technical SEO specialist generating Schema.org JSON-LD markup.

TARGET SCHEMA TYPES for this ${template.vertical} business:
${template.schema_type_combo.join(" + ")}

STRUCTURE RULES:
${template.prompt_notes ?? "Use @graph with @id cross-references when combining multiple types."}

REQUIRED FIELDS (must appear if data exists; if data is missing, OMIT the field — never invent):
${JSON.stringify(template.required_fields, null, 2)}

RECOMMENDED FIELDS (include only when data is clearly present in the source):
${JSON.stringify(template.recommended_fields, null, 2)}

HARD RULES:
1. NEVER invent data. No fabricated ratings, review counts, prices, hours, or addresses. If a required field has no source data, omit it — the human will fill it in during review.
2. Every value must be traceable to the scraped data or the operator's extra notes. Ratings/reviews may ONLY be included if they are visibly present in the page text.
3. Use "@context": "https://schema.org" and a single "@graph" array when emitting multiple types, cross-linked with "@id" values based on the page URL (e.g. "${"{page_url}"}#business").
4. Phone numbers in international format (+52 for Mexico) when the country is identifiable.
5. openingHoursSpecification only if hours are explicitly stated in the source.
6. If the page already contains JSON-LD (provided in input), do not duplicate its nodes — extend or correct instead, and note conflicts in a top-level "_operator_notes" string field.
7. Output ONLY the JSON object. No markdown fences, no preamble, no explanation. The only allowed non-schema field is "_operator_notes" (a string with warnings for the human reviewer: missing required fields, mismatches with visible content, existing schema conflicts). The frontend strips this field before export.
8. For enumerated fields (e.g. medicalSpecialty), if the accurate real-world value has no valid Schema.org enum match, do NOT substitute the closest formal enum value if it would misrepresent the specialty. Instead use a descriptive string literal and note the substitution in _operator_notes.${secondaryPageRule}`;
}

function buildUserPrompt(scraped: unknown, extraInfo?: string): string {
  return `SCRAPED PAGE DATA:
${JSON.stringify(scraped, null, 2)}

${extraInfo ? `OPERATOR NOTES / CORRECTIONS (authoritative — overrides scraped data on conflict):\n${extraInfo}\n` : ""}Generate the JSON-LD now.`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isPlaceholder(v: string): boolean {
  const n = v.replace(/[_\-\s]+/g, " ").trim();
  if (/OPERATOR\s+MUST|PLACEHOLDER/i.test(n)) return true;
  if (/\bTODO\b|\bFIXME\b|\bXXX\b/.test(n)) return true;
  if (/^[A-Z ]+$/.test(n) && n.split(" ").length >= 3) {
    if (/\b(MUST|SUPPLY|REQUIRED|INSERT|ENTER|FILL)\b/.test(n)) return true;
  }
  return false;
}

function stripPlaceholders(obj: unknown): unknown {
  const removed: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    if (v && typeof v === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k.startsWith("_")) { result[k] = val; continue; }
        if (typeof val === "string" && isPlaceholder(val)) {
          removed.push(path ? `${path}.${k}` : k);
          continue;
        }
        result[k] = walk(val, path ? `${path}.${k}` : k);
      }
      return result;
    }
    return v;
  };
  const result = walk(obj, "") as Record<string, unknown>;
  if (removed.length > 0) {
    const note = removed.map(p => `Se removió un marcador del campo "${p}"`).join("\n");
    const existing = typeof result._operator_notes === "string" ? result._operator_notes : "";
    result._operator_notes = existing ? `${existing}\n${note}` : note;
  }
  return result;
}
