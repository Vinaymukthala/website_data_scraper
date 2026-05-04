import {
  ensureNotBlocked,
  parseUsdPrice,
  extractBrandAndCaliber,
  modelMatches,
  listingShowsDifferentCaliberThanSearch,
  CALIBER_MAP,
} from "./_util.js";

/**
 * TrueGunValue — one category page lists multiple comps; each row uses a distinct `pageUrl` hash
 * so `scraperService` dedupe-by-URL does not collapse them to a single listing.
 *
 * Env: `TRUEGUNVALUE_MAX_LISTINGS` (default 3, max 25) — aligns with other providers' per-site cap.
 */
export const sourceName = "truegunvalue";

/** Max comps returned from the single results page (each row gets a unique #fragment on pageUrl so dedupe does not collapse them). */
const MAX_LISTINGS = Math.min(25, Math.max(1, Number(process.env.TRUEGUNVALUE_MAX_LISTINGS) || 3));

const CATEGORY_SELECT_VALUE = {
  handgun: "pistol",
  rifle: "rifle",
  shotgun: "shotgun",
};

const FIREARM_TYPE_TO_CATEGORY = {
  HANDGUN: "handgun",
  RIFLE: "rifle",
  SHOTGUN: "shotgun",
};

/** CALIBER: cell sometimes aligns with wrong column (e.g. "MANF. PART #:"). */
function trueGunChunkCaliberIsJunk(s) {
  const u = String(s || "").trim().toUpperCase();
  if (!u || u.length > 72) return true;
  if (
    /\b(MANF|MFG)\b.*\bPART\b|\bPART\s*#|SKU\s*:?\s*|UPC\s*:?\s*|GTIN\s*:?\s*|ITEM\s*#|^MODEL\s*:|^CONDITION\s*:|^MANUFACTURER\s*:/i.test(
      u
    )
  ) {
    return true;
  }
  return false;
}

function caliberMatchesKnownPattern(text) {
  const up = String(text || "").trim().toUpperCase();
  if (!up) return false;
  return CALIBER_MAP.some((e) => e.patterns.some((p) => p.test(up)));
}

/**
 * Use CALIBER: field only if plausible; else infer from title; else skip listing (null).
 */
function resolveTrueGunListingCaliber(chunkCaliber, title) {
  const chunk = String(chunkCaliber || "").trim();

  if (chunk && !trueGunChunkCaliberIsJunk(chunk) && caliberMatchesKnownPattern(chunk)) {
    return chunk;
  }

  const t = title || "";
  const fromTitleKey = extractBrandAndCaliber(t).caliber;
  if (fromTitleKey && caliberMatchesKnownPattern(fromTitleKey)) {
    return fromTitleKey;
  }

  const upTitle = t.toUpperCase();
  const hit = CALIBER_MAP.find((e) => e.patterns.some((p) => p.test(upTitle)));
  return hit ? hit.key : null;
}

function trueGunValueResultsUrl(categoryValue, query) {
  const slug = encodeURIComponent(query).replace(/%20/g, "-").replace(/%2F/g, "-");
  const pathPart = `${categoryValue}/${slug}/price-historical-value`;
  return new URL(pathPart, "https://truegunvalue.com/").href;
}

/**
 * Parse sold listing blocks from the page text.
 * Each sold item has structured fields like:
 *   PRICE: $469.00    MANUFACTURER: GLOCK
 *   CONDITION: Used    MODEL: G19
 *   SOLD: 4/14/2026   UPC: ...
 *   CALIBER: 9MM LUGER
 *
 * We extract each block and validate the MODEL field against the searched model
 * to filter out unrelated guns (e.g. G26, G17 when searching for G19).
 */
function listingsFromScrapedText(text, searchModel, searchedCaliber, fullQuery) {
  const lines = String(text || "").split(/\n/);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const priceMatch = lines[i].match(/^PRICE:\s*(.+)$/);
    if (!priceMatch) continue;

    const price = parseUsdPrice(priceMatch[1]);
    if (price == null) continue;

    // Grab the next several lines to form the full listing block
    const chunk = lines.slice(i, Math.min(i + 8, lines.length)).join("\n");

    // Extract condition
    let condition = "Unknown";
    const cMatch = chunk.match(/CONDITION:\s*([^\t\r\n]+)/);
    if (cMatch) condition = cMatch[1].trim();

    // Extract model — this is the KEY filter
    let model = "";
    const mMatch = chunk.match(/MODEL:\s*([^\t\r\n]+)/);
    if (mMatch) model = mMatch[1].trim().toUpperCase();

    // Validate: listing model must match searched model (flexible word-by-word)
    // TrueGunValue often stores just the number (e.g. "12") while we search "Model 12"
    if (model && searchModel) {
      const cleanSearchModel = searchModel.toUpperCase().replace(/\bMODEL\b\s*/gi, "").trim();
      const cleanListingModel = model.toUpperCase().trim();
      const exactMatch = modelMatches(model, searchModel);
      const strippedMatch = cleanSearchModel && (
        cleanListingModel === cleanSearchModel ||
        cleanListingModel.includes(cleanSearchModel) ||
        cleanSearchModel.includes(cleanListingModel)
      );
      if (!exactMatch && !strippedMatch) {
        continue; // Different gun model — skip
      }
    }

    // Extract caliber
    let caliber = "";
    const calMatch = chunk.match(/CALIBER:\s*([^\t\r\n]+)/);
    if (calMatch) caliber = calMatch[1].trim();

    // Extract manufacturer
    let manufacturer = "";
    const manMatch = chunk.match(/MANUFACTURER:\s*([^\t\r\n]+)/);
    if (manMatch) manufacturer = manMatch[1].trim();

    // Extract the title line (usually 1-2 lines before the PRICE line)
    let title = "";
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
      const prevLine = lines[j].trim();
      if (prevLine.length > 10
        && !prevLine.startsWith("PRICE:")
        && !prevLine.startsWith("CONDITION:")
        && !prevLine.startsWith("SOLD:")
        && !prevLine.startsWith("LOCATION:")
        && !prevLine.startsWith("CALIBER:")
        && !prevLine.startsWith("CAPACITY:")
      ) {
        title = prevLine;
        break;
      }
    }

    // Fallback title from structured fields
    if (!title && (manufacturer || model)) {
      title = [manufacturer, model, caliber].filter(Boolean).join(" ");
    }

    const resolvedCaliber = resolveTrueGunListingCaliber(caliber, title);
    if (resolvedCaliber == null) {
      continue;
    }

    if (
      listingShowsDifferentCaliberThanSearch(resolvedCaliber, title, searchedCaliber, fullQuery)
    ) {
      continue;
    }

    out.push({
      price,
      condition,
      model,
      title,
      caliber: resolvedCaliber,
      manufacturer,
    });
  }
  return out;
}

function conditionTypeFromCondition(conditionRaw) {
  const s = String(conditionRaw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  if (!s) return "UNKNOWN";
  if (/\bLIKE NEW\b/.test(s)) return "USED";
  if (/\bNIB\b/.test(s)) return "NEW";
  if (/\bNEW\b/.test(s)) return "NEW";
  if (/\bUSED\b/.test(s)) return "USED";
  if (/\b(EXCELLENT|VERY GOOD|GOOD|FAIR|POOR)\b/.test(s)) return "USED";
  return "UNKNOWN";
}

export async function scrape({ page, query, firearmType, model, caliber = "" }) {
  const categoryKey = FIREARM_TYPE_TO_CATEGORY[String(firearmType || "").trim().toUpperCase()];
  if (!categoryKey) return [];
  const categoryValue = CATEGORY_SELECT_VALUE[categoryKey];
  const pdpUrl = trueGunValueResultsUrl(categoryValue, query);

  // Use the model parameter directly (e.g. "10/22", "P320", "19")
  // Fallback to extracting from query if model not provided
  const searchModel = model
    ? String(model).trim()
    : (query.split(/\s+/).length >= 2 ? query.split(/\s+/).slice(1, -1).join(" ") : "");

  console.log(`[${sourceName}] ${pdpUrl}`);
  // Stay under scraperService withTimeout: leave a few seconds for ensureNotBlocked + evaluate.
  const scrapeBudget = Number(process.env.SCRAPE_TIMEOUT_MS) || 15000;
  const navTimeout = Math.max(12_000, scrapeBudget - 3500);
  await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: navTimeout });
  await ensureNotBlocked(page, `${sourceName}: after navigation`);

  const text = await page.evaluate(() => {
    const main = document.querySelector("main");
    const root = main ?? document.body;
    return (root.innerText || "").trim();
  });

  const allListings = listingsFromScrapedText(text, searchModel, caliber, query);
  console.log(`[${sourceName}] Parsed ${allListings.length} matching listing(s) (model filter: "${searchModel}").`);

  return allListings.slice(0, MAX_LISTINGS).map((l, idx) => {
    const extracted = extractBrandAndCaliber(l.title || "");
    // Same category URL for every comp; scraperService dedupes by (source, pageUrl) — fragment makes each row distinct.
    const pageUrl = `${pdpUrl}#comp-${idx}-${l.price}`;

    return {
      sourceName,
      condition: l.condition || "Unknown",
      conditionType: conditionTypeFromCondition(l.condition),
      pageUrl,
      title: l.title || null,
      description: "",
      model: l.model || "",
      brand: l.manufacturer || extracted.brand,
      caliber: l.caliber || extracted.caliber || "",
      price: { currency: "USD", original: l.price },
    };
  });
}
