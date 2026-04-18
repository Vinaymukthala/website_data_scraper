/**
 * GunBroker.com scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * GunBroker is an auction/marketplace site. We scrape the "Buy Now"
 * search results which include fixed prices, not auction bids.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   GB_MAX_LISTINGS=10     Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import { parseUsdPrice } from "./_util.js";

export const sourceName = "gunbroker";

const MAX_LISTINGS = Number(process.env.GB_MAX_LISTINGS) || 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCESSORY_RE = /\bMAGAZINE[S]?\b|\bHOLSTER\b|\bGRIP[S]?\b|\bSCOPE\b|\bOPTIC[S]?\b|\bSLING\b|\bCLEANING\b|\bAMMO\b|\bBAYONET\b|\bPARTS KIT\b|\bMANUAL\b|\bCONVERSION KIT\b|\bLOADER\b|\bLASER\b|\bFLASHLIGHT\b|\bSUPPRESSOR\b|\bSILENCER\b|\bKNIFE\b/i;
const ACCESSORY_BRAND_RE = /\b(ETS|RWB|PMAG|MAGPUL|HEXMAG|E-LANDER|EMTAN|KCI)\b/i;

function isAccessory(title) {
  const upper = (title || "").toUpperCase();
  if (ACCESSORY_RE.test(upper)) return true;
  if (ACCESSORY_BRAND_RE.test(upper)) return true;
  // Standalone barrel parts
  if (/^BARREL\b/i.test(upper.trim())) return true;
  // "MAG" meaning magazine (not MAGNUM) when paired with round count
  if (/\bMAG\b/.test(upper) && !/\bMAGNUM\b/.test(upper) && /\b\d+RD\b/.test(upper)) return true;
  return false;
}

const CALIBRE_NOISE = new Set([
  "MM", "LUGER", "ACP", "AUTO", "MAG", "MAGNUM", "SPECIAL", "WIN",
  "WINCHESTER", "REM", "REMINGTON", "NATO", "GAP", "SUPER", "SHORT",
  "LONG", "RIFLE", "PISTOL", "SHOTGUN", "GAUGE", "GA", "FOR", "SALE",
]);

function extractKeywords(query) {
  return query.toUpperCase().split(/\s+/)
    .filter(w => w.length >= 2 && !/^\d+$/.test(w) && !CALIBRE_NOISE.has(w));
}

function matchCount(title, keywords) {
  const up = (title || "").toUpperCase();
  return keywords.reduce((n, kw) => n + (up.includes(kw) ? 1 : 0), 0);
}

/**
 * Fetch HTML from a URL via ScraperAPI (plain — no render=true needed for GunBroker).
 */
async function fetchViaScraperAPI(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, firearmType }) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

  // Sort=13 = Buy Now items, SortOrder=1 = price ascending
  const searchUrl = `https://www.gunbroker.com/all/search?keywords=${encodeURIComponent(query)}&Sort=13&SortOrder=1`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  // Cloudflare check
  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Blocked by Cloudflare.`);
    return [];
  }

  // Parse HTML with cheerio
  // GunBroker structure:
  //   div.listing[id="item-XXXXXXXXXX"]
  //     div.listing-text  → title (repeated twice, take first unique)
  //     div.listing-meta  → "Qty: X Item #:XXXXXXXXXX"
  //   Price is in the card text as "Price $XXX.XX"
  const $ = cheerio.load(html);
  const raw = [];

  $("div.listing[id^='item-']").each((_, card) => {
    const $card = $(card);
    const id = ($card.attr("id") || "").replace("item-", "").trim();
    if (!id) return;

    // Title comes from listing-text, which repeats — take the trimmed first line
    const titleEl = $card.find(".listing-text").first();
    const titleRaw = (titleEl.text() || "").trim().replace(/\s+/g, " ");
    // listing-text repeats the title twice (e.g. "GLOCK 19 GLOCK 19"), deduplicate
    const half = Math.ceil(titleRaw.length / 2);
    const half1 = titleRaw.slice(0, half).trim();
    const half2 = titleRaw.slice(half).trim();
    const title = (half1 === half2 || half2.startsWith(half1)) ? half1 : titleRaw;
    const cleanTitle = title.replace(/\s+/g, " ").trim();

    if (!cleanTitle || cleanTitle.length < 3) return;

    // Price: find "Price $XXX.XX" pattern in the full card text
    const cardText = $card.text();
    const priceMatch = cardText.match(/Price\s+(\$[\d,]+\.?\d{0,2})/);
    const priceText = priceMatch ? priceMatch[1] : "";

    const pageUrl = `https://www.gunbroker.com/item/${id}`;
    raw.push({ title: cleanTitle, price: priceText, url: pageUrl });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter accessories
  let listings = raw.filter(l => {
    if (isAccessory(l.title)) {
      console.log(`[${sourceName}] Skipping accessory: "${l.title}"`);
      return false;
    }
    return true;
  });

  // Relevance filter — GunBroker titles are short (e.g. "Glock 19") and
  // rarely include caliber, so 1-keyword match is sufficient
  let relevant = listings.filter(l => matchCount(l.title, keywords) >= 1);

  console.log(`[${sourceName}] After filters: ${relevant.length} relevant listing(s).`);

  // Build results
  const results = [];
  for (const l of relevant.slice(0, MAX_LISTINGS)) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const upper = l.title.toUpperCase();
    let condition = "Used"; // GunBroker is mostly used/private-seller
    if (/\bNEW\b/.test(upper) && !/\bUSED\b/.test(upper)) condition = "New";
    if (/\bNIB\b/.test(upper) || /\bNEW IN BOX\b/.test(upper)) condition = "New";

    results.push({
      sourceName,
      condition,
      pageUrl: l.url,
      gunName: l.title.slice(0, 200) || null,
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
