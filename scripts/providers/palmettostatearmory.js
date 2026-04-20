/**
 * Palmetto State Armory (PSA) scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * PSA is a Magento store. We scrape their catalog search page, which is
 * server-rendered and accessible via plain ScraperAPI (no render=true needed).
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   PSA_MAX_LISTINGS=10    Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import { parseUsdPrice } from "./_util.js";

export const sourceName = "palmettostatearmory";

const MAX_LISTINGS = Number(process.env.PSA_MAX_LISTINGS) || 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCESSORY_RE = /\bMAGAZINE[S]?\b|\bHOLSTER\b|\bGRIP[S]?\b|\bSCOPE\b|\bOPTIC[S]?\b|\bSLING\b|\bCLEANING\b|\bAMMO\b|\bBAYONET\b|\bPARTS KIT\b|\bMANUAL\b|\bCONVERSION KIT\b|\bLOADER\b|\bLASER\b|\bFLASHLIGHT\b|\bSUPPRESSOR\b|\bSILENCER\b|\bKNIFE\b|\bBARREL\b|\bCOMPENSATOR\b|\bCOMP\b|\bMUZZLE\b|\bBRAKE\b|\bSLIDE\b|\bFRAME\b|\bRECEIVER\b|\bTRIGGER\b|\bSIGHT[S]?\b/i;
const ACCESSORY_BRAND_RE = /\b(MAGPUL|PMAG|KCI|ETS|RWB|HEXMAG|TAPCO|MCARBO|STRIKE\s+INDUSTRIES|BACKUP\s+TACTICAL|RIVAL\s+ARMS|FORTIS|TRUE\s+PRECISION|RADIAN\s+WEAPONS|ZAFFIRI|LONE\s+WOLF)\b/i;

function isAccessory(title) {
  const upper = (title || "").toUpperCase();
  if (ACCESSORY_RE.test(upper)) return true;
  if (ACCESSORY_BRAND_RE.test(upper)) return true;
  // MAG + round count = magazine
  if (/\bMAG\b/.test(upper) && !/\bMAGNUM\b/.test(upper) && /\b\d+\s*ROUND\b|\b\d+RD\b/.test(upper)) return true;
  // "X Round Magazine"
  if (/\b\d+\s*ROUND\s+MAGAZINE\b/.test(upper)) return true;
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
 * Fetch via ScraperAPI — plain mode, no render needed for Magento stores.
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
  const apiKey = process.env.SCRAPER_API_KEY || "e21aad3e18c55591c5186bac018bcfe2";
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

  // PSA uses Magento's catalogsearch
  const searchUrl = `https://palmettostatearmory.com/catalogsearch/result/?q=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  // Cloudflare / block check
  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Blocked by Cloudflare.`);
    return [];
  }

  // Parse HTML with cheerio
  // Magento product card structure:
  //   li.item.product.product-item
  //     a.product-item-photo[href] → product URL
  //     .product-item-name → title text
  //     .price-box
  //       span.price-wrapper.final-price span.price → sale/final price
  //       span.price-wrapper (first one if no sale) span.price → regular price
  const $ = cheerio.load(html);
  const raw = [];

  $(".item.product.product-item").each((_, card) => {
    const $card = $(card);

    // Title
    const title = ($card.find(".product-item-name").text() || "").trim();
    if (!title || title.length < 5) return;

    // URL
    let href = $card.find("a.product-item-link, a.product-item-photo, a").first().attr("href") || "";
    if (!href) return;

    // Price — prefer final-price (sale), fall back to first price-wrapper
    let priceText = $card.find("span.price-wrapper.final-price span.price").first().text().trim();
    if (!priceText) {
      priceText = $card.find("span.price-wrapper span.price").first().text().trim();
    }
    if (!priceText) {
      // Last fallback: any $XX.XX pattern in the card
      const m = $card.text().match(/\$[\d,]+\.?\d{0,2}/);
      if (m) priceText = m[0];
    }

    raw.push({ title, price: priceText, url: href });
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

    const upper = l.title.toUpperCase();
    let condition = "New"; // PSA sells new firearms
    if (/\bUSED\b/.test(upper)) condition = "Used";

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
