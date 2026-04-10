import { ensureNotBlocked, parseUsdPrice } from "./_util.js";

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

function listingsFromScrapedText(text) {
  const lines = String(text || "").split(/\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^PRICE:\s*(.+)$/);
    if (!m) continue;
    const price = parseUsdPrice(m[1]);
    if (price == null) continue;
    const chunk = [lines[i], lines[i + 1], lines[i + 2], lines[i + 3]].filter(Boolean).join("\n");
    let condition = "Unknown";
    const cMatch = chunk.match(/CONDITION:\s*([^\t\r\n]+)/);
    if (cMatch) condition = cMatch[1].trim();
    out.push({ price, condition });
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

export async function scrape({ page, query, firearmType }) {
  const categoryKey = FIREARM_TYPE_TO_CATEGORY[String(firearmType || "").trim().toUpperCase()];
  if (!categoryKey) return [];
  const categoryValue = CATEGORY_SELECT_VALUE[categoryKey];
  const pdpUrl = trueGunValueResultsUrl(categoryValue, query);

  await page.goto(pdpUrl, { waitUntil: "domcontentloaded", timeout: 10_000 });
  await ensureNotBlocked(page, `${sourceName}: after navigation`);

  const text = await page.evaluate(() => {
    const main = document.querySelector("main");
    const root = main ?? document.body;
    return (root.innerText || "").trim();
  });

  const listings = listingsFromScrapedText(text);
  return listings.map((l) => ({
    sourceName,
    condition: l.condition || "Unknown",
    conditionType: conditionTypeFromCondition(l.condition),
    pageUrl: pdpUrl,
    gunName: null,
    price: { currency: "USD", original: l.price },
  }));
}
