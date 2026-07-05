// src/lib/validation.ts
// Client-side required/recommended field checks per Schema.org type.
// Full validation still goes through Google's Rich Results Test (link-out) —
// there is no free public API for it, so this covers the structural basics.

export interface ValidationIssue {
  severity: "error" | "warning";
  node: string;
  message: string;
}

// Google Rich Results–oriented requirements (structural minimum)
const REQUIRED: Record<string, string[]> = {
  MedicalBusiness: ["name", "address", "telephone", "url"],
  Physician: ["name", "medicalSpecialty"],
  AggregateRating: ["ratingValue", "reviewCount"],
  LegalService: ["name", "address", "telephone", "url"],
  Attorney: ["name"],
  Restaurant: ["name", "address", "telephone", "servesCuisine"],
  Menu: ["name"],
  RealEstateAgent: ["name", "address", "telephone", "url"],
  LocalBusiness: ["name", "address", "telephone"],
  Product: ["name", "image"],
  Offer: ["price", "priceCurrency", "availability"],
  ProfessionalService: ["name", "address", "telephone"],
  Service: ["name", "provider"],
};

const RECOMMENDED: Record<string, string[]> = {
  MedicalBusiness: ["openingHoursSpecification", "image", "priceRange", "geo", "sameAs"],
  Restaurant: ["openingHoursSpecification", "priceRange", "image", "aggregateRating"],
  LocalBusiness: ["openingHoursSpecification", "priceRange", "image", "geo", "sameAs", "url"],
  Product: ["description", "brand", "offers", "aggregateRating"],
};

interface JsonLdNode {
  "@type"?: string | string[];
  [key: string]: unknown;
}

export function validateJsonLd(jsonld: JsonLdNode): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodes = collectNodes(jsonld);

  if (nodes.length === 0) {
    issues.push({ severity: "error", node: "root", message: "No typed nodes found (@type missing everywhere)." });
    return issues;
  }

  const hasContext = "@context" in jsonld;
  if (!hasContext) {
    issues.push({ severity: "error", node: "root", message: 'Missing "@context": "https://schema.org".' });
  }

  for (const node of nodes) {
    const types = ([] as string[]).concat(node["@type"] as string | string[]);
    for (const type of types) {
      for (const field of REQUIRED[type] ?? []) {
        if (isEmpty(node[field])) {
          issues.push({ severity: "error", node: type, message: `Missing required field "${field}".` });
        }
      }
      for (const field of RECOMMENDED[type] ?? []) {
        if (isEmpty(node[field])) {
          issues.push({ severity: "warning", node: type, message: `Recommended field "${field}" not set.` });
        }
      }
      // Common footguns
      if (type === "AggregateRating") {
        const rv = Number(node["ratingValue"]);
        if (!Number.isNaN(rv) && (rv < 1 || rv > 5) && isEmpty(node["bestRating"])) {
          issues.push({ severity: "warning", node: type, message: "ratingValue outside 1–5 without bestRating declared." });
        }
      }
      if (type === "Offer" && typeof node["price"] === "string" && /[^0-9.]/.test(node["price"] as string)) {
        issues.push({ severity: "error", node: type, message: 'price must be a plain number string (no currency symbols) — use priceCurrency.' });
      }
    }
  }
  return issues;
}

// Walks @graph and nested objects collecting every node with an @type
function collectNodes(root: JsonLdNode): JsonLdNode[] {
  const out: JsonLdNode[] = [];
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === "object") {
      const obj = v as JsonLdNode;
      if (obj["@type"]) out.push(obj);
      Object.entries(obj).forEach(([k, val]) => {
        if (!k.startsWith("_")) walk(val); // skip _operator_notes
      });
    }
  };
  walk(root);
  return out;
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

// Builds the link-out to Google's Rich Results Test with the page URL prefilled
export function richResultsTestUrl(pageUrl: string): string {
  return `https://search.google.com/test/rich-results?url=${encodeURIComponent(pageUrl)}`;
}

export function isPlaceholder(v: string): boolean {
  // Normalize underscores, hyphens, and whitespace runs to single spaces so
  // "OPERATOR_MUST_SUPPLY" matches the same as "OPERATOR MUST SUPPLY".
  const n = v.replace(/[_\-\s]+/g, ' ').trim();

  if (/OPERATOR\s+MUST|PLACEHOLDER/i.test(n)) return true;
  if (/\bTODO\b|\bFIXME\b|\bXXX\b/.test(n)) return true;

  // Heuristic: 3+ all-caps words (letters + spaces only) containing a sentinel verb.
  // Catches novel variants like "PLEASE INSERT DOCTOR NAME" without hitting
  // real 1–2-word abbreviations (IMSS, CDMX) or mixed-case place names.
  if (/^[A-Z ]+$/.test(n) && n.split(' ').length >= 3) {
    if (/\b(MUST|SUPPLY|REQUIRED|INSERT|ENTER|FILL)\b/.test(n)) return true;
  }

  return false;
}

function findPlaceholders(root: unknown, path = ''): string[] {
  const out: string[] = [];
  if (Array.isArray(root)) {
    root.forEach((v, i) => out.push(...findPlaceholders(v, `${path}[${i}]`)));
  } else if (root && typeof root === 'object') {
    for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
      if (k.startsWith('_')) continue;
      const childPath = path ? `${path}.${k}` : k;
      if (typeof v === 'string' && isPlaceholder(v)) {
        out.push(childPath);
      } else {
        out.push(...findPlaceholders(v, childPath));
      }
    }
  }
  return out;
}

// Final export block, stripping internal fields
export function toScriptTag(jsonld: JsonLdNode): string {
  const offenders = findPlaceholders(jsonld);
  if (offenders.length > 0) {
    const err = new Error(`Valores de marcador bloqueados: ${offenders.join(', ')}`) as Error & { fields: string[] };
    err.fields = offenders;
    throw err;
  }
  const clean = JSON.parse(JSON.stringify(jsonld, (k, v) => (k.startsWith("_") ? undefined : v)));
  return `<script type="application/ld+json">\n${JSON.stringify(clean, null, 2)}\n</script>`;
}
