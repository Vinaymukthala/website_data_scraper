/**
 * GunBroker.com scraper — uses ScraperAPI to bypass Cloudflare.
 *
 * Flow: one SERP (best search URL), then up to GB_PDP_LIMIT PDPs in parallel.
 * ScraperAPI timeouts are derived only from SCRAPE_TIMEOUT_MS (default 15s, same as scrapeFirearm per-provider cap).
 *
 * Env:
 *   SCRAPER_API_KEY           (required) Your ScraperAPI key
 *   SCRAPE_TIMEOUT_MS         Per-provider budget ms (default 15000)
 *   GB_FETCH_TIMEOUT_MS       Optional override for SERP fetch ms
 *   GB_PDP_FETCH_TIMEOUT_MS   Optional override for each PDP fetch ms
 *   GB_PDP_LIMIT              PDP pages (default 3)
 *   GB_USE_ENRICH             LLM PDP enrich (see code)
 *   GB_FAST=1                 Minimal: 1 PDP, 5s fetches
 */

import * as cheerio from "cheerio";
import {
  parseUsdPrice,
  isAccessory,
  extractKeywords,
  isRelevant,
  normalizeCondition,
  extractSpecsFromHtml,
  listingShowsDifferentCaliberThanSearch,
  resolveSearchCaliberEntry,
  extractBreadcrumbTrailFrom$,
  breadcrumbTrailImpliesNonFirearm,
} from "./_util.js";
import { enrichGunBrokerListing } from "../llmNormalizer.js";

export const sourceName = "gunbroker";

const GB_FAST = process.env.GB_FAST === "1" || process.env.GB_FAST === "true";
const _gbEnrichExplicit = process.env.GB_USE_ENRICH;
const GB_USE_ENRICH =
  _gbEnrichExplicit === "0" || _gbEnrichExplicit === "false"
    ? false
    : _gbEnrichExplicit === "1" || _gbEnrichExplicit === "true"
      ? true
      : Boolean(process.env.OPENAI_API_KEY);

/** Parallel PDP fetches (wall clock ≈ SERP + slowest PDP). Default 3 matches PSA / GunsInternational. */
const PDP_LIMIT = GB_FAST
  ? 1
  : Math.min(10, Math.max(1, Number(process.env.GB_PDP_LIMIT) || 3));

const GB_SKIP_ENRICH = GB_FAST || !GB_USE_ENRICH;

/** Same default as scrapeFirearm `withTimeout` — one number drives SERP/PDP split. */
function gbBudgetMs() {
  if (GB_FAST) return 5000;
  const n = Number(process.env.SCRAPE_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 15000;
}

/** SERP ~62% of budget, each PDP ~32% (parallel PDPs → wall ≈ SERP + one PDP slice, under budget). */
function gbFetchMs(phase) {
  if (GB_FAST) return 5000;
  const T = gbBudgetMs();
  if (phase === "pdp") {
    const ex = Number(process.env.GB_PDP_FETCH_TIMEOUT_MS);
    if (ex > 0) return Math.max(2000, ex);
    return Math.max(2500, Math.floor(T * 0.32));
  }
  const exS = Number(process.env.GB_FETCH_TIMEOUT_MS);
  if (exS > 0) return Math.max(5000, exS);
  return Math.max(6000, Math.floor(T * 0.62));
}

/**
 * Fetch HTML from a URL via ScraperAPI (plain — no render=true needed for GunBroker).
 */
async function fetchViaScraperAPI(targetUrl, apiKey, phase = "serp") {
  const apiUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(targetUrl)}`;
  const response = await fetch(apiUrl, { signal: AbortSignal.timeout(gbFetchMs(phase)) });
  if (!response.ok) {
    throw new Error(`ScraperAPI returned ${response.status}: ${response.statusText}`);
  }
  return await response.text();
}

/**
 * GunBroker "Item Characteristics" is usually a table (th/td or multi-td rows), not span.next().
 * dl/dt/dd blocks appear on some listings. Merges into `specs` without overwriting non-empty keys.
 */
function mergeGunBrokerItemCharacteristics($, specs) {
  const noiseLabel = /^(sku|price|shipping|insurance|quantity|qty|seller|high bidder|bid|time left|views|item id)$/i;

  const setFromLabelValue = (labelRaw, valueRaw) => {
    const label = String(labelRaw || "").trim().replace(/:\s*$/, "");
    let value = String(valueRaw || "").trim().replace(/\s+/g, " ");
    if (!label || !value || value.length > 260) return;
    if (noiseLabel.test(label)) return;

    const norm = label.toLowerCase().replace(/\s+/g, " ");
    if ((norm.includes("caliber") && norm.includes("gauge")) || norm === "caliber/gauge") {
      if (!specs.caliber) specs.caliber = value;
      return;
    }

    let key = label
      .toLowerCase()
      .replace(/\s*\/\s*/g, "/")
      .replace(/\s+(.)/g, (_, c) => c.toUpperCase());
    if (key === "manufacturer" || key === "mfg") {
      if (!specs.brand) specs.brand = value;
      return;
    }
    if (key === "gauge" && !specs.caliber) {
      specs.caliber = value;
      return;
    }
    if (!specs[key]) specs[key] = value;
  };

  const blobLooksLikeSpecs = (s) =>
    /\b(manufacturer|model|caliber|gauge|action|barrel|capacity|item characteristics)\b/i.test(s);

  $("table").each((_, table) => {
    const $t = $(table);
    if (!blobLooksLikeSpecs($t.text())) return;

    $t.find("tr").each((_, row) => {
      const cells = $(row).find("th, td");
      if (cells.length < 2) return;
      const arr = cells.toArray();
      const label = $(arr[0]).text();
      const value = arr
        .slice(1)
        .map((c) => $(c).text().trim())
        .filter(Boolean)
        .join(" ");
      setFromLabelValue(label, value);
    });
  });

  $("dl").each((_, dl) => {
    const $dl = $(dl);
    if (!blobLooksLikeSpecs($dl.text())) return;
    $dl.find("dt").each((_, dt) => {
      const label = $(dt).text();
      const value = $(dt).next("dd").text();
      setFromLabelValue(label, value);
    });
  });
}

/**
 * Fetch a single PDP page via ScraperAPI and extract description + condition.
 */
async function fetchPdpData(pdpUrl, apiKey) {
  try {
    const html = await fetchViaScraperAPI(pdpUrl, apiKey, "pdp");
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

      // Strip embedded SPECIFICATIONS block from description text
      let cleaned = innerText.replace(/SPECIFICATIONS?\s*:?\s*(?:MANUFACTURER|MODEL|CALIBER|GAUGE|ACTION|BARREL)[\s\S]*/i, "").trim();
      if (cleaned.length < 20) cleaned = innerText; // fallback if stripping removed too much

      candidates.push(cleaned);
    });

    // Pick the longest non-noise candidate — that's the real description
    if (candidates.length > 0) {
      description = candidates.sort((a, b) => b.length - a.length)[0];
    }

    // Fallback: .description-content or product description divs
    if (!description) {
      const descEl = $(".description-content, .product-description, [itemprop='description'], #description").first();
      if (descEl.length) {
        description = descEl.text().replace(/\s+/g, " ").trim();
      }
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

    // Strategy 2b: Item Characteristics tables / definition lists (primary GB layout)
    mergeGunBrokerItemCharacteristics($, specs);

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

    const domTrail = extractBreadcrumbTrailFrom$($);
    const gbCat = String(specs.category || "").trim();
    const breadcrumbTrail = [gbCat, domTrail].filter(Boolean).join(" | ");

    return { description, condition, breadcrumbTrail, ...specs };
  } catch (e) {
    console.warn(`[${sourceName}] PDP fetch failed: ${e.message}`);
    return { description: "", condition: "", breadcrumbTrail: "" };
  }
}

// ── Main entry ───────────────────────────────────────────────────────────────

/**
 * GunBroker `ch-model` usually matches catalog tokens ("12", "g30sf"), not display strings ("Model 12", "Mdl 12").
 * Full model stays on `model` from the pipeline for relevance checks — only URLs use this.
 */
function gunBrokerModelFacet(model) {
  let s = String(model || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  s = s.replace(/^model\s+/i, "").replace(/^mdl\.?\s+/i, "").trim();
  return s;
}

/**
 * GunBroker `ch-caliber` facet: use full gauge wording ("12 Gauge") so URL filters match catalog labels.
 */
function gunBrokerCaliberFacet(caliber) {
  const s = String(caliber || "").trim().replace(/\s+/g, " ");
  if (!s) return "";
  let m = s.match(/^(\d{1,2})\s*-?\s*gauge$/i);
  if (m) return `${m[1]} Gauge`;
  m = s.match(/^(\d{1,2})\s*ga$/i);
  if (m) return `${m[1]} Gauge`;
  m = s.match(/^(\d{1,2})\s+GA$/i);
  if (m) return `${m[1]} Gauge`;
  return s;
}

/**
 * GunBroker supports structured catalog facets on search (narrower, more accurate than keywords alone).
 * @see https://www.gunbroker.com/guns-firearms/search?keywords=...&ch-manufacturername=...&ch-model=...&ch-caliber=...
 */
function buildSearchUrl(query, brand, model, caliber) {
  const params = new URLSearchParams();
  params.set("keywords", String(query || "").trim());
  params.set("Sort", "13"); // Buy Now
  const mfg = String(brand || "").trim();
  const mdl = String(model || "").trim();
  const cal = String(caliber || "").trim();
  if (mfg) params.set("ch-manufacturername", mfg);
  if (mdl) params.set("ch-model", mdl);
  if (cal) params.set("ch-caliber", cal);
  return `https://www.gunbroker.com/guns-firearms/search?${params.toString()}`;
}

/** Parse Buy Now SERP cards from HTML (static HTML from ScraperAPI). */
function parseGunBrokerSerp(html) {
  const $ = cheerio.load(html);
  const raw = [];

  $("div.listing[id^='item-']").each((_, card) => {
    const $card = $(card);
    const id = ($card.attr("id") || "").replace("item-", "").trim();
    if (!id) return;

    const titleEl = $card.find(".listing-text a").first();
    let title = (titleEl.text() || "").trim().replace(/\s+/g, " ");

    if (title.length > 10) {
      const halfLen = Math.floor(title.length / 2);
      for (let splitAt = halfLen - 5; splitAt <= halfLen + 5; splitAt++) {
        if (splitAt <= 0 || splitAt >= title.length) continue;
        const first = title.slice(0, splitAt).trim();
        const rest = title.slice(splitAt).trim();
        if (rest.startsWith(first)) {
          title = rest;
          break;
        }
      }
    }

    if (!title || title.length < 3) return;

    const cardText = $card.text().replace(/\s+/g, " ");
    let priceText = "";

    const fixedMatch = cardText.match(/(?:Price|Buy\s*Now|Fixed\s*Price)\s*\$\s*([\d,]+\.?\d{0,2})/i);
    if (fixedMatch) {
      priceText = "$" + fixedMatch[1];
    }

    if (!priceText) {
      const allPrices = cardText.match(/\$([\d,]+\.?\d{0,2})/g) || [];
      const validPrices = allPrices
        .map((p) => parseFloat(p.replace(/[$,]/g, "")))
        .filter((p) => p >= 50);
      if (validPrices.length > 0) {
        priceText = "$" + validPrices[0].toFixed(2);
      }
    }

    const pageUrl = `https://www.gunbroker.com/item/${id}`;
    raw.push({ title, price: priceText, url: pageUrl });
  });

  return raw;
}

export async function scrape({ page, query, model, firearmType, caliber = "", brand = "" }) {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    console.warn(`[${sourceName}] SCRAPER_API_KEY not set — skipping.`);
    return [];
  }

  console.log(`[${sourceName}] LLM PDP enrich: ${GB_SKIP_ENRICH ? "off" : "on"}`);

  const keywords = extractKeywords(query);

  const calFacet = gunBrokerCaliberFacet(caliber);
  const modelFacet = gunBrokerModelFacet(model);

  const serpUrl = buildSearchUrl(query, brand, modelFacet, calFacet);
  let raw = [];

  try {
    console.log(`[${sourceName}] ${serpUrl} (via ScraperAPI)`);
    const html = await fetchViaScraperAPI(serpUrl, apiKey, "serp");
    if (html.includes("security verification") || html.includes("Just a moment")) {
      console.warn(`[${sourceName}] Blocked by Cloudflare.`);
      return [];
    }
    raw = parseGunBrokerSerp(html);
  } catch (err) {
    console.warn(`[${sourceName}] serp fetch failed: ${err.message}`);
    raw = [];
  }

  console.log(`[${sourceName}] Extracted ${raw.length} listing(s).`);
  if (raw.length === 0) return [];

  // Quick SERP pass: valid price + skip obvious accessory titles; then first PDP_LIMIT rows (PDP in parallel).
  const quickSerp = raw.filter((l) => {
    if (!l.title || l.title.length < 3) return false;
    if (isAccessory(l.title)) return false;
    const pr = parseUsdPrice(l.price);
    return pr != null && pr > 0;
  });

  const upQuery = String(query || "").toUpperCase();
  const upCal = String(caliber || "").toUpperCase();
  const searchCalEntry = resolveSearchCaliberEntry(upQuery, upCal);

  let rankedSerp = quickSerp;
  if (searchCalEntry) {
    const noTitleConflict = quickSerp.filter(
      (l) => !listingShowsDifferentCaliberThanSearch("", l.title, caliber, query)
    );
    if (noTitleConflict.length === 0) {
      console.warn(
        `[${sourceName}] SERP titles all look caliber-conflicting (${searchCalEntry.key}) — continuing with SERP anyway; PDP + global filter will validate.`
      );
      rankedSerp = quickSerp;
    } else {
      rankedSerp = noTitleConflict;
      if (noTitleConflict.length < quickSerp.length) {
        console.log(
          `[${sourceName}] Dropped ${quickSerp.length - noTitleConflict.length} SERP card(s) with wrong gauge in title; ${noTitleConflict.length} remain.`
        );
      }
    }
    rankedSerp = [...rankedSerp].sort((a, b) => {
      const ta = String(a.title || "").toUpperCase();
      const tb = String(b.title || "").toUpperCase();
      const ma = searchCalEntry.patterns.some((p) => p.test(ta)) ? 1 : 0;
      const mb = searchCalEntry.patterns.some((p) => p.test(tb)) ? 1 : 0;
      return mb - ma;
    });
  }

  const pdpTargets = rankedSerp.slice(0, PDP_LIMIT);
  console.log(
    `[${sourceName}] Taking top ${pdpTargets.length} SERP row(s) after caliber-aware rank (max ${PDP_LIMIT}); PDP + 2nd-pass filter next.`
  );
  if (pdpTargets.length === 0) return [];

  console.log(`[${sourceName}] Fetching ${pdpTargets.length} PDP(s) in parallel...`);

  const pdpResults = await Promise.all(
    pdpTargets.map((l) => fetchPdpData(l.url, apiKey))
  );

  let enrichedList;
  if (GB_SKIP_ENRICH) {
    enrichedList = pdpTargets.map((l, i) => {
      const pdp = pdpResults[i] || {};
      const { description: rawDesc, ...scraped } = pdp;
      const summary =
        String(rawDesc || "").replace(/\s+/g, " ").trim().slice(0, 2000) || (l.title || "").trim();
      const attributes = {};
      for (const [k, v] of Object.entries(scraped)) {
        if (k === "condition" || v == null) continue;
        const s = typeof v === "object" ? JSON.stringify(v) : String(v).trim();
        if (s) attributes[k] = s;
      }
      return { summary, attributes, fromLlm: false };
    });
  } else {
    enrichedList = await Promise.all(
      pdpTargets.map((l, i) => {
        const pdp = pdpResults[i] || {};
        const { description: rawDesc, condition: condHint, ...scrapedForLlm } = pdp;
        return enrichGunBrokerListing({
          title: l.title || "",
          rawDescription: rawDesc || "",
          scrapedSpecs: scrapedForLlm,
          conditionHint: condHint || "",
        });
      })
    );
  }

  // Build results
  const results = [];
  for (let i = 0; i < pdpTargets.length; i++) {
    const l = pdpTargets[i];
    const pdp = pdpResults[i] || {};
    const enriched = enrichedList[i] || { summary: "", attributes: {}, fromLlm: false };
    const p = parseUsdPrice(l.price);
    if (p == null || p <= 0) continue;

    // 2nd pass: title + PDP specs only (no long LLM/description text — avoids false "sling" / etc.)
    const quickText = [l.title, pdp.brand, pdp.model, pdp.caliber]
      .filter((v) => v != null && String(v).trim())
      .join(" ");
    if (isAccessory(quickText)) {
      console.log(`[${sourceName}] 2nd-pass rejected (accessory): ${l.title.slice(0, 100)}`);
      continue;
    }
    if (breadcrumbTrailImpliesNonFirearm(pdp.breadcrumbTrail)) {
      console.log(
        `[${sourceName}] 2nd-pass rejected (breadcrumb): ${String(pdp.breadcrumbTrail).slice(0, 140)}`
      );
      continue;
    }
    if (!isRelevant(quickText, keywords, sourceName, model, query, caliber)) {
      console.log(`[${sourceName}] 2nd-pass rejected (relevance): ${l.title.slice(0, 100)}`);
      continue;
    }

    const upper = l.title.toUpperCase();
    let rawCond = pdp.condition || "";
    if (!rawCond) {
      if (/\bNEW\b/.test(upper) && !/\bUSED\b/.test(upper)) rawCond = "New";
      else if (/\bNIB\b/.test(upper) || /\bNEW IN BOX\b/.test(upper)) rawCond = "New";
      else rawCond = "Used";
    }

    const { description: _d, ...pdpRest } = pdp;

    results.push({
      sourceName,
      pageUrl: l.url,
      title: l.title.slice(0, 200) || null,
      ...pdpRest,
      description: enriched.summary,
      descriptionFromLlm: enriched.fromLlm,
      llmGunAttributes: enriched.attributes,
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
