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
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  normalizeCondition,
  extractSpecsFromHtml,
  extractBrandAndCaliber
} from "./_util.js";

export const sourceName = "gunbroker";

const MAX_LISTINGS = Number(process.env.GB_MAX_LISTINGS) || 10;
const PDP_LIMIT = 3;
const SEARCH_TIMEOUT_MS = Number(process.env.GB_SEARCH_TIMEOUT_MS) || 20_000;
const PDP_TIMEOUT_MS = Number(process.env.GB_PDP_TIMEOUT_MS) || 15_000;
const FIELD_BOUNDARY_RE = /\b(?:manufacturer|model|mfg model no|family|type|item group|action|caliber\/gauge|caliber|gauge|finish|finish type|stock\/grips|stock frame grips|barrel|barrel length|overall length|drilled \/ tapped|rate-?of-?twist|capacity|# of magazines|mag description|sights|sight type|optics\/sights|markings|serial|upc|weight|safety|frame|trigger|thread pattern|special feature|shipping|condition|country of origin|item condition)\s*:/i;
const PLACEHOLDER_VALUE_RE = /^(other(?:\s+\w+){0,2}|n\/a|na|unknown|see description)$/i;
const KNOWN_BRANDS = [
  "COLT", "GLOCK", "SIG SAUER", "SIG", "SMITH & WESSON", "SMITH AND WESSON", "S&W",
  "RUGER", "BERETTA", "CZ", "WALTHER", "SPRINGFIELD ARMORY", "SPRINGFIELD",
  "TAURUS", "HECKLER & KOCH", "HECKLER AND KOCH", "H&K", "HK",
  "BROWNING", "REMINGTON", "WINCHESTER", "SAVAGE", "MOSSBERG", "BENELLI",
  "KIMBER", "HENRY", "DANIEL DEFENSE", "PALMETTO STATE ARMORY", "PSA"
];

function cleanFieldValue(rawValue) {
  let value = String(rawValue || "").replace(/\s+/g, " ").trim();
  if (!value) return "";

  const boundaryMatch = value.slice(1).match(FIELD_BOUNDARY_RE);
  if (boundaryMatch?.index != null) {
    value = value.slice(0, boundaryMatch.index + 1).trim();
  }

  value = value
    .replace(/\bclick here to view more auctions[\s\S]*$/i, "")
    .replace(/\bhow this works[\s\S]*$/i, "")
    .replace(/\ball items sold by[\s\S]*$/i, "")
    .replace(/\bplease read prior to purchase[\s\S]*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return value;
}

function truncateAtInlineMarkers(rawValue, markers) {
  let value = String(rawValue || "").replace(/\s+/g, " ").trim();
  if (!value) return "";

  for (const marker of markers) {
    const idx = value.search(marker);
    if (idx > 0) {
      value = value.slice(0, idx).trim();
    }
  }

  return value;
}

function isPlaceholderValue(value) {
  return PLACEHOLDER_VALUE_RE.test(String(value || "").trim());
}

function assignSpec(specs, key, rawValue, { overwrite = false } = {}) {
  const value = cleanFieldValue(rawValue);
  if (!value || isPlaceholderValue(value)) return;
  if (!overwrite && specs[key]) return;
  specs[key] = value;
}

function normalizeGunBrokerSpecs(specs, title) {
  const normalized = {};

  for (const [key, rawValue] of Object.entries(specs || {})) {
    const value = cleanFieldValue(rawValue);
    if (!value || isPlaceholderValue(value)) continue;
    normalized[key] = value;
  }

  if (normalized.gauge && !normalized.caliber) {
    normalized.caliber = normalized.gauge;
  }

  const extracted = extractBrandAndCaliber(title);
  const upperTitle = String(title || "").toUpperCase();

  if (!normalized.brand || isPlaceholderValue(normalized.brand)) {
    normalized.brand = extracted.brand || "";
  }

  if (normalized.brand) {
    const upperBrand = normalized.brand.toUpperCase();
    const titleBrand = KNOWN_BRANDS.find((brand) => upperTitle.includes(brand));
    if (titleBrand && upperBrand !== titleBrand && !upperTitle.includes(upperBrand)) {
      normalized.brand = titleBrand;
    }
  }

  if (!normalized.caliber || isPlaceholderValue(normalized.caliber)) {
    normalized.caliber = extracted.caliber || "";
  }

  if (normalized.caliber && /caliber\/gauge|stock frame grips|sights|frame grip/i.test(normalized.caliber)) {
    normalized.caliber = extracted.caliber || "";
  }

  if (normalized.gauge && /stock frame grips|sights|frame grip/i.test(normalized.gauge)) {
    delete normalized.gauge;
  }

  const fieldSpecificTruncators = {
    finish: [/\bFrame Material\b/i, /\bGrips\b/i, /\bModel Number\b/i],
    finishType: [/\bFrame Material\b/i, /\bGrips\b/i, /\bModel Number\b/i],
    frame: [/\bGrip\b/i, /\bGrips\b/i, /\bSights\b/i],
    overallLength: [/\bModel Number\b/i, /\bCapacity\b/i, /\bSights\b/i],
    twist: [/\bSights\b/i, /\bCapacity\b/i],
    "rate-of-twist": [/\bSights\b/i, /\bCapacity\b/i],
  };

  for (const [key, markers] of Object.entries(fieldSpecificTruncators)) {
    if (normalized[key]) {
      normalized[key] = cleanFieldValue(truncateAtInlineMarkers(normalized[key], markers));
    }
  }

  for (const key of Object.keys(normalized)) {
    if (!normalized[key]) {
      delete normalized[key];
    }
  }

  return normalized;
}

function getScopedProductRoot($) {
  const selectors = [
    "[data-testid='item-detail-container']",
    ".view-item-detail",
    ".item-detail",
    "main",
    "#ContentPlaceHolder1_mainContent",
  ];

  for (const selector of selectors) {
    const el = $(selector).first();
    if (el.length) return el;
  }

  return $.root();
}

/**
 * Fetch HTML from a URL via ScraperAPI (plain — no render=true needed for GunBroker).
 */
async function fetchViaScraperAPI(targetUrl, apiKey) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

async function fetchViaScraperAPIWithTimeout(targetUrl, apiKey, timeoutMs) {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

/**
 * Fetch a single PDP page via ScraperAPI and extract description + condition.
 */
async function fetchPdpData(pdpUrl, apiKey) {
  const startedAt = Date.now();
  try {
    const html = await fetchViaScraperAPIWithTimeout(pdpUrl, apiKey, PDP_TIMEOUT_MS);
    const fetchDurationMs = Date.now() - startedAt;
    const $ = cheerio.load(html);

    let description = "";

    // GunBroker puts seller content in multiple iframe srcdoc attributes.
    // The actual product description is typically the LONGEST srcdoc.
    // Noise iframes (layaway, disclaimers) usually START with that text.
    const NOISE_RE = /layaway|subject to change|shipping rates|terms of sale|payment method|money order|certified check|restocking fee|disclaimer|non-compliance|before placing your order/i;

    const candidates = [];
    $("iframe.srcdoc-iframe").each((_, el) => {
      const srcdoc = $(el).attr("srcdoc") || "";
      if (!srcdoc || srcdoc.length < 50) return;

      const $inner = cheerio.load(srcdoc);
      const innerText = $inner.text().replace(/\s+/g, " ").trim();
      if (innerText.length < 30) return;

      // Only skip if noise appears in the FIRST 200 chars (primary noise content)
      const head = innerText.slice(0, 200);
      if (NOISE_RE.test(head)) return;

      candidates.push(innerText);
    });

    // Pick the longest non-noise candidate — that's the real description
    if (candidates.length > 0) {
      description = candidates.sort((a, b) => b.length - a.length)[0];
    }

    // Fallback: meta description
    if (!description) {
      const metaDesc = $("meta[name='description']").attr("content") || "";
      if (metaDesc && metaDesc.length > 20) {
        description = metaDesc.replace(/\s*:\s*GunBroker.*$/i, "").trim();
      }
    }

    // Extract condition from PDP (e.g., "Factory New Condition")
    let condition = "";
    const condEl = $(".condition").first();
    if (condEl.length) {
      condition = condEl.text().replace(/\s+/g, " ").replace(/condition/i, "").trim();
    }

    description = description.replace(/\s+/g, " ").trim();

    // GunBroker-specific spec extraction:
    // 1. dataLayer script has structured item data
    // 2. DOM has label/value span pairs (Manufacturer → RUGER, Model → 10/22 CARBINE, etc.)
    const specs = {};

    // Strategy 1: Parse dataLayer script for structured item data
    $("script").each((_, el) => {
      const text = $(el).html() || "";
      if (text.includes("dataLayer.push") && text.includes("itemID")) {
        const itemMatch = text.match(/item:\s*\{([^}]+(?:\{[^}]*\}[^}]*)*)\}/);
        if (itemMatch) {
          const itemText = itemMatch[1];
          const fieldMap = {
            manufacturer: "brand", model: "model", caliber: "caliber",
            gauge: "gauge", action: "action", barrel_length: "barrelLength",
            category: "category",
          };
          for (const [field, key] of Object.entries(fieldMap)) {
            const m = itemText.match(new RegExp(`${field}\\s*:\\s*"([^"]*)"`, "i"));
            if (m) assignSpec(specs, key, m[1]);
          }
        }
      }
    });

    // Strategy 2: DOM label/value pairs inside the product detail area only
    const productRoot = getScopedProductRoot($);
    productRoot.find("span, td, th, dt").each((_, el) => {
      const text = $(el).text().trim();
      if (/^(Manufacturer|Caliber|Model|Action|Barrel Length|Capacity|Gauge|Condition)$/i.test(text)) {
        const value = $(el).next("span, td, dd").text().trim()
          || $(el).parent().find("td, dd").last().text().trim();
        if (value && value.length < 80) {
          const key = text.toLowerCase().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
          if (key === "manufacturer") assignSpec(specs, "brand", value);
          else assignSpec(specs, key, value);
        }
      }
    });

    // Strategy 3: Parse SPECIFICATIONS block from iframe srcdoc
    //   GunBroker sellers embed detailed specs inside iframe srcdoc HTML
    //   Format: "SPECIFICATIONS:\nMANUFACTURER: Ruger\nMODEL: 10/22\nCALIBER/GAUGE: 22 LR\n..."
    $("iframe.srcdoc-iframe").each((_, el) => {
      const srcdoc = $(el).attr("srcdoc") || "";
      if (!srcdoc || !/SPECIFICATION/i.test(srcdoc)) return;

      const $inner = cheerio.load(srcdoc);
      const text = $inner.text();

      // Extract everything after "SPECIFICATIONS:" 
      const specMatch = text.match(/SPECIFICATIONS?\s*:?\s*([\s\S]+)/i);
      if (!specMatch) return;
      const specBlock = specMatch[1];

      // Known GunBroker spec labels (comprehensive to prevent boundary bleed)
      const GB_LABELS = [
        "MANUFACTURER", "MODEL", "MFG MODEL NO", "FAMILY", "TYPE",
        "ITEM GROUP", "ACTION", "CALIBER/GAUGE", "CALIBER", "GAUGE",
        "FINISH", "FINISH TYPE", "STOCK", "STOCK/GRIPS", "BARREL",
        "BARREL LENGTH", "OVERALL LENGTH", "DRILLED / TAPPED",
        "RATE-OF-TWIST", "CAPACITY", "# OF MAGAZINES", "MAG DESCRIPTION",
        "SIGHTS", "SIGHT TYPE", "OPTICS/SIGHTS", "MARKINGS", "SERIAL",
        "UPC", "WEIGHT", "SAFETY", "FRAME", "TRIGGER",
        "THREAD PATTERN", "SPECIAL FEATURE", "SHIPPING", "CONDITION",
        "COUNTRY OF ORIGIN", "ITEM CONDITION",
      ];
      // Build boundary regex
      const labelPattern = GB_LABELS.map(l => l.replace(/[/\\#]/g, "\\$&").replace(/\s+/g, "\\s*")).join("|");
      const BOUNDARY = `(?=(?:${labelPattern})\\s*:|$)`;

      for (const label of GB_LABELS) {
        const escaped = label.replace(/[/\\#]/g, "\\$&").replace(/\s+/g, "\\s*");
        const re = new RegExp(`${escaped}\\s*:\\s*(.+?)${BOUNDARY}`, "is");
        const m = specBlock.match(re);
        if (m && m[1].trim()) {
          // Normalize label to camelCase
          let key = label.toLowerCase()
            .replace(/[/#]/g, " ")
            .replace(/\s+(.)/g, (_, c) => c.toUpperCase())
            .replace(/^\w/, c => c.toLowerCase());
          // Normalize aliases
          if (key === "manufacturer") key = "brand";
          if (key === "caliberGauge" || key === "gauge") key = specs.caliber ? key : "caliber";
          if (key === "barrel" && !specs.barrelLength) key = "barrelLength";
          if (key === "stockGrips") key = "stock";
          if (key === "rateOfTwist") key = "twist";
          if (key === "ofMagazines") key = "magazineCount";

          assignSpec(specs, key, m[1]);
        }
      }
    });

    // Strategy 4: Fallback to generic extraction scoped to the product area only
    const genericSpecs = extractSpecsFromHtml($, productRoot);
    for (const [k, v] of Object.entries(genericSpecs)) {
      assignSpec(specs, k, v);
    }

    const normalizedSpecs = normalizeGunBrokerSpecs(specs, description || $("title").text());

    const totalDurationMs = Date.now() - startedAt;
    console.log(`[${sourceName}] PDP timing ${pdpUrl.split("/").pop()}: fetch=${fetchDurationMs}ms total=${totalDurationMs}ms`);

    return { description, condition, ...normalizedSpecs };
  } catch (e) {
    console.warn(`[${sourceName}] PDP fetch failed after ${Date.now() - startedAt}ms: ${e.message}`);
    return { description: "", condition: "" };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

export async function scrape({ page, query, model, firearmType }) {
  const apiKey = process.env.SCRAPER_API_KEY || "7260a6ebef2b9568767d0c2cb1c03515";
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  const keywords = extractKeywords(query);

  // Sort=13 = Buy Now items,
  const searchUrl = `https://www.gunbroker.com/guns-firearms/search?keywords=${encodeURIComponent(query)}&Sort=13`;
  console.log(`[${sourceName}] ${searchUrl} (via ScraperAPI)`);

  let html;
  const searchStartedAt = Date.now();
  try {
    html = await fetchViaScraperAPI(searchUrl, apiKey);
    console.log(`[${sourceName}] Search fetch completed in ${Date.now() - searchStartedAt}ms.`);
  } catch (err) {
    console.error(`[${sourceName}] ScraperAPI error after ${Date.now() - searchStartedAt}ms: ${err.message}`);
    throw err;
  }

  // Cloudflare check
  if (html.includes("security verification") || html.includes("Just a moment")) {
    console.warn(`[${sourceName}] Blocked by Cloudflare.`);
    return [];
  }

  const $ = cheerio.load(html);
  const raw = [];

  $("div.listing[id^='item-']").each((_, card) => {
    const $card = $(card);
    const id = ($card.attr("id") || "").replace("item-", "").trim();
    if (!id) return;

    const titleEl = $card.find(".listing-text").first();
    const titleRaw = (titleEl.text() || "").trim().replace(/\s+/g, " ");
    const half = Math.ceil(titleRaw.length / 2);
    const half1 = titleRaw.slice(0, half).trim();
    const half2 = titleRaw.slice(half).trim();
    const title = (half1 === half2 || half2.startsWith(half1)) ? half1 : titleRaw;
    const cleanTitle = title.replace(/\s+/g, " ").trim();

    if (!cleanTitle || cleanTitle.length < 3) return;

    const cardText = $card.text();
    const priceMatch = cardText.match(/Price\s+(\$[\d,]+\.?\d{0,2})/);
    const priceText = priceMatch ? priceMatch[1] : "";

    const pageUrl = `https://www.gunbroker.com/item/${id}`;
    raw.push({ title: cleanTitle, price: priceText, url: pageUrl });
  });

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Filter accessories
  let relevant = raw.filter(l => {
    const title = (l.title || "").toUpperCase();
    const upBrand = (query.split(" ")[0] || "").toUpperCase();
    const upModel = (model || "").toUpperCase();

    const calibers = [".45", "9MM", ".40", ".380", ".22", ".357", ".44", "10MM", ".223", "5.56", ".308", "7.62"];
    const hasCaliber = calibers.some(c => title.includes(c));
    const hasBrand = title.includes(upBrand);
    const hasModel = upModel ? title.includes(upModel) : true;

    if (hasBrand && hasModel && hasCaliber) {
      if (/\b(MOULD|MOLD|DIE[S]?|RELOADING)\b/i.test(title)) return false;
      return true;
    }

    return !isAccessory(l.title) && isRelevant(l.title, keywords, sourceName, model);
  });

  console.log(`[${sourceName}] After site-specific filters: ${relevant.length} relevant listing(s).`);

  // Take top PDP_LIMIT listings for PDP extraction (parallel)
  const pdpTargets = relevant.slice(0, PDP_LIMIT);
  console.log(`[${sourceName}] Fetching ${pdpTargets.length} PDP(s) in parallel...`);

  const pdpBatchStartedAt = Date.now();
  const pdpResults = await Promise.all(
    pdpTargets.map(l => fetchPdpData(l.url, apiKey))
  );
  console.log(`[${sourceName}] PDP batch completed in ${Date.now() - pdpBatchStartedAt}ms.`);

  // Build results
  const results = [];
  for (let i = 0; i < pdpTargets.length; i++) {
    const l = pdpTargets[i];
    const pdp = pdpResults[i] || {};
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const normalizedPdp = normalizeGunBrokerSpecs(pdp, l.title);
    const extracted = extractBrandAndCaliber(l.title);

    const upper = l.title.toUpperCase();
    let rawCond = normalizedPdp.condition || "";
    if (!rawCond) {
      if (/\bNEW\b/.test(upper) && !/\bUSED\b/.test(upper)) rawCond = "New";
      else if (/\bNIB\b/.test(upper) || /\bNEW IN BOX\b/.test(upper)) rawCond = "New";
      else rawCond = "Used";
    }

    results.push({
      sourceName,
      pageUrl: l.url,
      title: l.title.slice(0, 200) || null,
      description: (normalizedPdp.description || "").toLowerCase(),
      ...normalizedPdp,
      condition: normalizeCondition(rawCond),
      model: normalizedPdp.model || model || "",
      caliber: normalizedPdp.caliber || extracted.caliber || "",
      brand: normalizedPdp.brand || extracted.brand || "",
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
