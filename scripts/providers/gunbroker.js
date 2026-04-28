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
  extractSpecsFromHtml
} from "./_util.js";

export const sourceName = "gunbroker";

const MAX_LISTINGS = Number(process.env.GB_MAX_LISTINGS) || 10;
const PDP_LIMIT = 3;

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

/**
 * Fetch a single PDP page via ScraperAPI and extract description + condition.
 */
async function fetchPdpData(pdpUrl, apiKey) {
  try {
    const html = await fetchViaScraperAPI(pdpUrl, apiKey);
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
            if (m && m[1].trim()) specs[key] = m[1].trim();
          }
        }
      }
    });

    // Strategy 2: DOM label/value pairs (span elements where label text is followed by value)
    $("span, div, td, th").each((_, el) => {
      const text = $(el).text().trim();
      if (/^(Manufacturer|Caliber|Model|Action|Barrel Length|Capacity|Gauge|Condition)$/i.test(text)) {
        const value = $(el).next().text().trim();
        if (value && value.length < 80) {
          const key = text.toLowerCase().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
          if (key === "manufacturer") { if (!specs.brand) specs.brand = value; }
          else if (!specs[key]) specs[key] = value;
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

          if (!specs[key]) specs[key] = m[1].trim();
        }
      }
    });

    // Strategy 4: Fallback to generic extractSpecsFromHtml
    const genericSpecs = extractSpecsFromHtml($);
    for (const [k, v] of Object.entries(genericSpecs)) {
      if (v && !specs[k]) specs[k] = v;
    }

    return { description, condition, ...specs };
  } catch (e) {
    console.warn(`[${sourceName}] PDP fetch failed: ${e.message}`);
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

  const pdpResults = await Promise.all(
    pdpTargets.map(l => fetchPdpData(l.url, apiKey))
  );

  // Build results
  const results = [];
  for (let i = 0; i < pdpTargets.length; i++) {
    const l = pdpTargets[i];
    const pdp = pdpResults[i] || {};
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    const upper = l.title.toUpperCase();
    let rawCond = pdp.condition || "";
    if (!rawCond) {
      if (/\bNEW\b/.test(upper) && !/\bUSED\b/.test(upper)) rawCond = "New";
      else if (/\bNIB\b/.test(upper) || /\bNEW IN BOX\b/.test(upper)) rawCond = "New";
      else rawCond = "Used";
    }

    results.push({
      sourceName,
      pageUrl: l.url,
      title: l.title.slice(0, 200) || null,
      description: (pdp.description || "").toLowerCase(),
      ...pdp,
      condition: normalizeCondition(rawCond),
      model: pdp.model || model || "",
      caliber: pdp.caliber || "",
      brand: pdp.brand || "",
      price: { currency: "USD", original: p },
    });
  }

  console.log(`[${sourceName}] Done — ${results.length} result(s).`);
  return results;
}
