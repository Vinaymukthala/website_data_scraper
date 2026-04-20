/**
 * GrabAGun.com scraper — uses ScraperAPI to bypass bot protection.
 *
 * Env:
 *   SCRAPER_API_KEY        (required) Your ScraperAPI key
 *   GRABAGUN_MAX_LISTINGS=10 Max products to return (default 10)
 */

import * as cheerio from "cheerio";
import { parseUsdPrice } from "./_util.js";

export const sourceName = "grabagun";

const MAX_LISTINGS = Number(process.env.GRABAGUN_MAX_LISTINGS) || 10;

// ── Helpers ──────────────────────────────────────────────────────────────────

const ACCESSORY_RE = /\bMAGAZINE[S]?\b|\bHOLSTER|\bGRIP[S ]\b|\bSCOPE\b|\bOPTIC[S]?\b|\bSLING\b|\bCLEANING\b|\bAMMO\b|\bBAYONET|\bPARTS KIT|\bMANUAL\b|\bCONVERSION KIT|\bLOADER|\bLASER\b|\bFLASHLIGHT|\bSUPPRESSOR|\bSILENCER|\bKNIFE/i;
const ACCESSORY_BRAND_RE = /\b(ETS|RWB|PMAG|MAGPUL|HEXMAG|E-LANDER|EMTAN|KCI)\b/i;

function isAccessory(title) {
  const upper = (title || "").toUpperCase();
  if (ACCESSORY_RE.test(upper)) return true;
  if (ACCESSORY_BRAND_RE.test(upper)) return true;
  if (/\bFOR\s+(GLOCK|G\d{2})\b/i.test(upper) && !/\bPISTOL\b/.test(upper)) return true;
  if (/^BARREL\b/i.test(upper.trim())) return true;
  if (/\bBARREL\b/.test(upper) && /\bFOR\b/.test(upper) && /\bFITS?\b|\bFOR\b/i.test(upper)) return true;
  if (/\bMAG\b/.test(upper) && !/\bMAGNUM\b/.test(upper) && /\b\d+RD\b/.test(upper)) return true;
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
  const apiKey = process.env.SCRAPER_API_KEY || "e21aad3e18c55591c5186bac018bcfe2";
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);
  const minMatch = Math.min(2, keywords.length);

  const searchUrl = `https://grabagun.com/catalogsearch/result/?q=${encodeURIComponent(query)}`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error: ${err.message}`);
    throw err;
  }

  if (html.includes("security verification") || html.includes("Just a moment") || html.includes("Cloudflare")) {
    console.warn(`[${sourceName}] Cloudflare blocked even via ScraperAPI.`);
    return [];
  }

  const $ = cheerio.load(html);
  const raw = [];

  // Identify product items on GrabAGun (usually .product-item or .item.product)
  $(".product-item, .item.product").each((_, card) => {
    const $card = $(card);

    const titleElem = $card.find(".product-item-link, .product-name a");
    const title = (titleElem.text() || "").trim();
    if (!title || title.length < 5) return;

    let href = titleElem.attr("href") || "";
    if (href && !href.startsWith("http")) {
      href = `https://grabagun.com/${href.replace(/^\//, "")}`;
    }
    if (!href) return;

    // GrabAGun uses standard Magento price boxes: .price-box .price
    const priceText = $card.find(".price-box .price").first().text().trim();

    raw.push({ url: href, title, price: priceText });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  let listings = raw.filter(l => {
    if (isAccessory(l.title)) {
      console.log(`[${sourceName}] Skipping accessory: "${l.title}"`);
      return false;
    }
    return true;
  });

  let relevant = listings.filter(l => matchCount(l.title, keywords) >= minMatch);
  if (relevant.length === 0 && keywords.length > 1) {
    relevant = listings.filter(l => matchCount(l.title, keywords) >= 1);
  }
  if (relevant.length === 0) relevant = listings;

  console.log(`[${sourceName}] After filters: ${relevant.length} relevant listing(s).`);

  const results = [];
  for (const l of relevant.slice(0, MAX_LISTINGS)) {
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const upper = l.title.toUpperCase();
    let condition = "New"; // Usually new items on GrabAGun
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
