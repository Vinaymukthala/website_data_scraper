import { ensureNotBlocked, parseUsdPrice, extractBrandAndCaliber } from "./_util.js";

export const sourceName = "truegunvalue";

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
function listingsFromScrapedText(text, searchModel) {
  const lines = String(text || "").split(/\n/);
  const out = [];

  // Normalize the search model for flexible matching
  // "19" should match "G19", "19 GEN5", "G19 GEN5", etc.
  const modelNorm = String(searchModel || "").trim().toUpperCase();
  // Strip leading letters like "G" from "G19" to get core digits
  const modelBase = modelNorm.replace(/^[A-Z]+/, "") || modelNorm;

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

    // Validate: model must contain the searched model number
    // e.g. searching "19" should match "G19", "G19 GEN5", "19 GEN4"
    //       but NOT "G17", "G26", "G43"
    if (model && modelBase) {
      const modelClean = model.replace(/^G/, ""); // "G19 GEN5" → "19 GEN5"
      if (!modelClean.startsWith(modelBase) && !model.includes(modelNorm)) {
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

    out.push({ price, condition, model, title, caliber, manufacturer });
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

export async function scrape({ page, query, firearmType, model }) {
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
  await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
  await ensureNotBlocked(page, `${sourceName}: after navigation`);

  const text = await page.evaluate(() => {
    const main = document.querySelector("main");
    const root = main ?? document.body;
    return (root.innerText || "").trim();
  });

  const allListings = listingsFromScrapedText(text, searchModel);
  console.log(`[${sourceName}] Parsed ${allListings.length} matching listing(s) (model filter: "${searchModel}").`);

  return allListings.slice(0, 4).map((l) => {
    const extracted = extractBrandAndCaliber(l.title);

    return {
      sourceName,
      condition: l.condition || "Unknown",
      conditionType: conditionTypeFromCondition(l.condition),
      pageUrl: pdpUrl,
      title: l.title || null,
      description: "",
      model: l.model || "",
      brand: l.manufacturer || extracted.brand,
      caliber: l.caliber || extracted.caliber,
      price: { currency: "USD", original: l.price },
    };
  });
}
