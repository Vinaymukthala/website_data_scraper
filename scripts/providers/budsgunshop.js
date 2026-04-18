/**
 * BudsGunShop.com scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * This provider does NOT use Puppeteer. Instead, it calls ScraperAPI's
 * proxy endpoint via fetch() and parses the returned HTML with cheerio.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   BG_MAX_LISTINGS=10     Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import { parseUsdPrice } from "./_util.js";

export const sourceName = "budsgunshop";

const MAX_LISTINGS = Number(process.env.BG_MAX_LISTINGS) || 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCESSORY_RE = /\bMAGAZINE[S]?\b|\bHOLSTER|\bGRIP[S ]\b|\bSCOPE\b|\bOPTIC[S]?\b|\bSLING\b|\bCLEANING\b|\bAMMO\b|\bBAYONET|\bPARTS KIT|\bMANUAL\b|\bCONVERSION KIT|\bLOADER|\bLASER\b|\bFLASHLIGHT|\bSUPPRESSOR|\bSILENCER|\bKNIFE/i;

// Known accessory/magazine manufacturers
const ACCESSORY_BRAND_RE = /\b(ETS|RWB|PMAG|MAGPUL|HEXMAG|E-LANDER|EMTAN|KCI)\b/i;

function isAccessory(title) {
  const upper = (title || "").toUpperCase();
  // Quick check against known accessory keywords
  if (ACCESSORY_RE.test(upper)) return true;

  // Known aftermarket brands are always accessories
  if (ACCESSORY_BRAND_RE.test(upper)) return true;

  // "FOR GLOCK" / "FITS GLOCK" / "FOR G19" = aftermarket part, not a gun
  if (/\bFOR\s+(GLOCK|G\d{2})\b/i.test(upper) && !/\bPISTOL\b/.test(upper)) return true;

  // Standalone barrel part (starts with "BARREL" or "Barrel For/Fits")
  if (/^BARREL\b/i.test(upper.trim())) return true;
  if (/\bBARREL\b/.test(upper) && /\bFOR\b/.test(upper) && /\bFITS?\b|\bFOR\b/i.test(upper)) return true;

  // "MAG" as standalone (not MAGNUM) when it clearly means magazine
  if (/\bMAG\b/.test(upper) && !/\bMAGNUM\b/.test(upper) && /\b\d+RD\b/.test(upper)) return true;

  // "Strike Mag Sleeve" etc.
  if (/\bMAG\s+SLEEVE\b/.test(upper)) return true;

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
 * Fetch HTML from a URL via ScraperAPI.
 */
async function fetchViaScraperAPI(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}&country_code=us`;
  
  const response = await fetch(apiUrl, { 
    signal: AbortSignal.timeout(30_000) 
  });
  
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

  // BudsGunShop search URL
  const searchUrl = `https://www.budsgunshop.com/search?q=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  // Check for Cloudflare block
  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Cloudflare blocked even via ScraperAPI.`);
    return [];
  }

  // Parse HTML with cheerio
  const $ = cheerio.load(html);
  const raw = [];

  // BudsGunShop structure:
  //   .product_box_container
  //     a.product-box-link[href="product_info.php/products_id/XXX/slug"]
  //       span[itemprop="name"] → title
  //     span.search_price → price digits (e.g. "783.49")
  $(".product_box_container").each((_, card) => {
    const $card = $(card);

    // Title from itemprop="name"
    const title = ($card.find("span[itemprop='name']").text() || "").trim();
    if (!title || title.length < 5) return;

    // Link
    let href = $card.find("a.product-box-link, a.list-products-name").first().attr("href") || "";
    if (href && !href.startsWith("http")) {
      href = `https://www.budsgunshop.com/${href.replace(/^\//, "")}`;
    }
    if (!href) return;

    // Price from span.search_price
    const priceText = $card.find("span.search_price").first().text().trim();

    raw.push({ url: href, title, price: `$${priceText}` });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter: accessories
  let listings = raw.filter(l => {
    if (isAccessory(l.title)) {
      console.log(`[${sourceName}] Skipping accessory: "${l.title}"`);
      return false;
    }
    return true;
  });

  // Relevance filter (progressive)
  let relevant = listings.filter(l => matchCount(l.title, keywords) >= minMatch);
  if (relevant.length === 0 && keywords.length > 1)
    relevant = listings.filter(l => matchCount(l.title, keywords) >= 1);
  if (relevant.length === 0) relevant = listings;

  console.log(`[${sourceName}] After filters: ${relevant.length} relevant listing(s).`);

  // Build results
  const results = [];
  for (const l of relevant.slice(0, MAX_LISTINGS)) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    // Infer condition from title
    const upper = l.title.toUpperCase();
    let condition = "New"; // BudsGunShop items are mostly new
    if (/\bUSED\b/.test(upper)) condition = "Used";
    if (/\bREFURB/.test(upper)) condition = "Used";

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
