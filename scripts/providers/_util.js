/**
 * Shared utility functions for firearm scraper providers.
 *
 * Exports:
 *   parseUsdPrice(input)        — extract a numeric USD price from text
 *   conditionFromText(text)     — infer New/Used/Unknown from description
 *   toAbsoluteUrl(base, href)   — safely resolve a relative URL
 *   ensureNotBlocked(page, ctx) — throw if page is a bot-block/challenge page
 *   cleanDescription(text)      — clean raw scraped description text
 */

// ── Description cleaning ─────────────────────────────────────────────────────

/**
 * Clean a raw scraped description string by removing CSS noise,
 * navigation boilerplate, HTML entities, prices, and other junk.
 */
export function cleanDescription(raw) {
  if (!raw) return "";
  let d = String(raw);

  // 1. Strip CSS blocks (PSA PageBuilder inline styles)
  d = d.replace(/#html-body\s*\[data-pb-style=[^\]]*\]\{[^}]*\}/g, "");

  // 2. Strip HTML entities
  d = d.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  d = d.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");

  // 3. Truncate at legal / boilerplate boundaries
  //    Seller descriptions often have real product info followed by walls of
  //    terms, shipping policy, layaway, returns, etc.  Cut at the first match.
  const LEGAL_BOUNDARY = /\b(terms and conditions|terms of sale|shipping policy|return policy|layaway option|legal responsibility|payment terms|credit card payments must|all federal firearms|non-returnable items|listing accuracy|check payments|condition of returns|restocking fee|buyers are responsible|please read before|general shipping|our mission statement|no sales to|we do not ship|we will not ship|disclaimer|warranty information|about us|about our|your adventure starts|we provide outstanding)\b/i;
  const boundaryIdx = d.search(LEGAL_BOUNDARY);
  if (boundaryIdx >= 0 && boundaryIdx <= 30) {
    // Entire description is boilerplate
    return "";
  } else if (boundaryIdx > 30) {
    d = d.slice(0, boundaryIdx).trim();
  }

  // 4. Remove navigation / boilerplate phrases
  const NOISE_PHRASES = [
    /\b(add to cart|add to wishlist|buy now|add to compare)\b/gi,
    /\b(back|go back|return to)\s+(item|product|shop|store|search|results)\b/gi,
    /\bitem\s*number:\s*\S+/gi,
    /\bnumber:\s*\S+/gi,
    /\bsku:\s*\S+/gi,
    /\bsn:\s*\S+/gi,
    /\bupc:?\s*#?\s*\d+/gi,
    /\bmfr\s*#?\s*:?\s*\S+/gi,
    /\bmanf\.\s*part\s*#?\s*:?\s*\S*/gi,
    /\b(in stock|out of stock|sold out|limited stock)\b/gi,
    /\bquantity\b/gi,
    /\b(houston|dallas)\s+location\.?\b/gi,
    /\bfree shipping\b/gi,
    /\bseller\s*#?\s*:?\s*\d+/gi,
    /\bguns\s*international\s*#?\s*:?\s*\d+/gi,
    /\bprice:\s*\$[\d,.]+/gi,
    /\bshipping:\s*\$[\d,.]+/gi,
    /\$[\d,]+\.?\d{0,2}/g,
    /\(stock photo\)/gi,
    /\b(please call|please have|if you are interested|for sale from)\b.*$/gim,
    /\bplease add for shipping\b.*$/gim,
    /\bpictures show what you get\b.*$/gim,
    // PSA: "product details details" prefix
    /^product\s+details\s+details\s*/i,
    // CollectorFirearms: leading "back" and location suffixes
    /^back\s+/i,
    /\b(houston|dallas|galveston)\s+location\.?\s*$/gim,
  ];

  for (const re of NOISE_PHRASES) {
    d = d.replace(re, " ");
  }

  // 5. Collapse whitespace & lowercase
  d = d.replace(/\s+/g, " ").trim().toLowerCase();

  // 6. Strip leading punctuation/dots (e.g. ". ruger 10/22...")
  d = d.replace(/^[\s.,;:!?*\-–—]+/, "").trim();

  return d;
}

// ── PDP Spec Extraction ──────────────────────────────────────────────────────

/**
 * Extract ALL structured specs from a Cheerio-loaded PDP page.
 * Tries multiple strategies:
 *   1. Magento additional-attributes table
 *   2. Generic table rows (th/td)
 *   3. dt/dd definition list pairs
 *   4. <li> items with "Label: Value" pattern (PSA/GrabAGun style)
 *
 * Returns a dynamic object — only non-empty values, camelCase keys.
 * E.g. { caliber: "22 LR", model: "10/22", brand: "Ruger", action: "Semi-Auto", ... }
 */
export function extractSpecsFromHtml($, scope) {
  const specs = {};
  const root = scope ? $(scope) : $.root();

  // Skip noise labels that are not gun attributes
  const SKIP_LABELS = /^(sku|upc|mpn|gtin|product|price|qty|availability|weight|shipping|color|image|url|stock|add to|review|rating|share|compare)/i;

  // Helper: set spec only if not already set and value is meaningful
  const setSpec = (rawLabel, value) => {
    if (!rawLabel || !value || value.length > 150) return;
    const label = rawLabel.trim();
    if (label.length < 2 || SKIP_LABELS.test(label)) return;
    // Convert to camelCase key: "Barrel Length" → "barrelLength"
    const key = label.toLowerCase().replace(/\s+(.)/g, (_, c) => c.toUpperCase());
    if (!specs[key]) specs[key] = value.trim();
  };

  // Strategy 1: Magento additional-attributes table (most reliable)
  root.find(".data.table.additional-attributes tr, #product-attribute-specs-table tr").each((_, row) => {
    const label = $(row).find("th").text().trim();
    const value = $(row).find("td").text().trim();
    setSpec(label, value);
  });

  // Strategy 2: Generic table rows (th-td or td-td) — scoped to product area
  root.find(".product-info-main table tr, .product-details table tr, table.specs tr").each((_, row) => {
    const cells = $(row).find("th, td");
    if (cells.length >= 2) {
      const label = $(cells[0]).text().trim();
      const value = $(cells[1]).text().trim();
      setSpec(label, value);
    }
  });

  // Strategy 3: dt/dd definition list pairs
  root.find("dt").each((_, el) => {
    const label = $(el).text().trim();
    const value = $(el).next("dd").text().trim();
    setSpec(label, value);
  });

  // Strategy 4: <li> items with "Label: Value" pattern
  const descArea = root.find(
    ".product.attribute.description, .product_description, " +
    "[itemprop='description'], #tab-description, .product-description"
  );
  descArea.find("li").each((_, el) => {
    const text = $(el).text().trim();
    const match = text.match(/^([A-Za-z][A-Za-z\s]{1,30}):\s*(.+)/);
    if (match) setSpec(match[1], match[2]);
  });

  // Normalize common aliases
  if (specs.manufacturer && !specs.brand) { specs.brand = specs.manufacturer; delete specs.manufacturer; }
  if (specs.gauge && !specs.caliber) { specs.caliber = specs.gauge; delete specs.gauge; }
  if (specs.cartridge && !specs.caliber) { specs.caliber = specs.cartridge; delete specs.cartridge; }
  if (specs.chambering && !specs.caliber) { specs.caliber = specs.chambering; delete specs.chambering; }

  return specs;
}

// ── Price parsing ────────────────────────────────────────────────────────────

export function parseUsdPrice(input) {
  if (input == null) return null;
  const s = String(input).replace(/[^\d.,]/g, "");
  if (!s) return null;
  const n = Number.parseFloat(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ── Condition inference ──────────────────────────────────────────────────────

export function conditionFromText(text) {
  const s = String(text || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return "Unknown";
  if (/\bused\b|\bpre[- ]?owned\b|\brefurb\b/.test(s)) return "Used";
  if (/\blike new\b/.test(s)) return "Used";
  if (/\bnew\b|\bnib\b/.test(s)) return "New";
  return "Unknown";
}

/**
 * Normalize a raw condition string into one of the standard terms:
 * New, Excellent, Very Good, Good, Fair, Used
 */
export function normalizeCondition(rawText) {
  const up = String(rawText || "").toUpperCase();
  if (!up || up === "UNKNOWN") return "Used";
  if (up.includes("NIB") || up.includes("NEW IN BOX") || up.includes("UNFIRED") || up.includes("FACTORY NEW") || up === "NEW") return "New";
  if (up.includes("LIKE NEW") || up.includes("MINT") || up.includes("EXCELLENT") || up.includes("99%")) return "Excellent";
  if (up.includes("VERY GOOD") || up.includes("98%")) return "Very Good";
  if (up.includes("GOOD") || up.includes("FINE")) return "Good";
  if (up.includes("FAIR") || up.includes("POOR")) return "Fair";
  if (up.includes("NEW") && !up.includes("USED")) return "New";
  return "Used";
}

// ── URL helper ───────────────────────────────────────────────────────────────

export function toAbsoluteUrl(baseUrl, href) {
  try { return new URL(href, baseUrl).href; }
  catch { return null; }
}

// ── Bot-block detection ──────────────────────────────────────────────────────

// ── Bot-block detection ──────────────────────────────────────────────────────

function isLikelyBotBlock(title, bodyText) {
  const t = String(title || "").toLowerCase();
  const b = String(bodyText || "").toLowerCase();

  if (/attention required|just a moment|cloudflare/.test(t)) return true;
  if (/access denied|request blocked|forbidden|not authorized/.test(t)) return true;
  if (/cloudflare/.test(b) && /just a moment|checking your browser/.test(b)) return true;
  if (/enable javascript and cookies to continue/.test(b)) return true;
  if (/are you a human|verify you are human|captcha/.test(b)) return true;
  return false;
}

export async function ensureNotBlocked(page, contextLabel) {
  const title = await page.title().catch(() => "");
  const bodySample = await page
    .evaluate(() => (document.body?.innerText || "").slice(0, 1600))
    .catch(() => "");

  if (isLikelyBotBlock(title, bodySample)) {
    const snippet = String(bodySample || "").replace(/\s+/g, " ").slice(0, 240);
    const err = new Error(
      `${contextLabel}: blocked/challenge page. title=${JSON.stringify(title)} snippet=${JSON.stringify(snippet)}`
    );
    err.name = "ScrapeBlockedError";
    throw err;
  }
}

// ── Firearm Filtering & Relevance ───────────────────────────────────────────

const ACCESSORY_RE = /\b(HOLSTER[S]?|SCOPE[S]?|OPTIC[S]?|SLING[S]?|CLEANING|AMMO|BAYONET[S]?|PARTS KIT|MANUAL[S]?|CONVERSION KIT|LOADER[S]?|LASER[S]?|FLASHLIGHT[S]?|SUPPRESSOR[S]?|SILENCER[S]?|KNIFE|KNIVES|DIE[S]?|RELOADING|PRESS|SCALE|BULLET[S]?|PROJECTILE[S]?|BIPOD[S]?|TRIPOD[S]?|BAG[S]?|MOULD|MOLD)\b/i;
const ACCESSORY_BRAND_RE = /\b(ETS|RWB|PMAG|MAGPUL|HEXMAG|E-LANDER|EMTAN|KCI|VORTEX|LEUPOLD|TRIJICON|HOLOSUN|PAST|CALDWELL|WHEELER|LEE|RCBS|HORANDY|LYMAN|DILLON)\b/i;

/**
 * Checks if a title likely refers to an accessory rather than a firearm.
 */
export function isAccessory(title, searchedBrand = "") {
  const upper = String(title || "").toUpperCase().trim();
  if (!upper) return true;

  // 1. Common accessories (unambiguous)
  if (ACCESSORY_RE.test(upper)) {
    console.log(`[debug] Flagged as accessory (matched broad regex): ${title}`);
    return true;
  }
  if (ACCESSORY_BRAND_RE.test(upper)) {
    console.log(`[debug] Flagged as accessory (matched accessory brand): ${title}`);
    return true;
  }

  // 2. Parts that might be in descriptions (only block if they look like standalone items)
  // Subject: [Brand] [Model] [Part]
  // Subject: [Part] for [Brand]
  const PART_KEYWORDS = ["MAGAZINE", "MAGS", "BARREL", "SLIDE", "UPPER", "LOWER", "TRIGGER", "STOCK", "BRACE", "GRIP", "SIGHT", "CASE"];
  
  for (const part of PART_KEYWORDS) {
    const partRe = new RegExp(`\\b${part}[S]?\\b`, "i");
    if (partRe.test(upper)) {
      // If it has "Pistol", "Rifle", "Revolver", "Shotgun", it's probably a gun
      // BUT: "Pistol Grip" is a part descriptor, not a gun type
      if (/\b(RIFLE|REVOLVER|SHOTGUN|HANDGUN)\b/i.test(upper)) continue;
      if (/\bPISTOL\b/i.test(upper) && !/\bPISTOL\s*GRIP\b/i.test(upper)) continue;

      // If it has a caliber AND a barrel length description, it's probably a gun
      // e.g. "6\" Barrel", "3.7\" Barrel"
      if (/\b\d+(\.\d+)?["']\s?BARREL\b/i.test(upper)) continue;
      
      // If it's a specific gun model + part, e.g. "Glock 19 Magazine" vs "Glock 19 9mm ... 2 Mags"
      // If the part name is the primary noun (usually at the end or following the brand/model)
      // We block if it looks like a part listing
      if (new RegExp(`\\b(FOR|FITS)\\b.*\\b${part}\\b`, "i").test(upper)) {
        console.log(`[debug] Flagged as accessory (Fits/For ${part}): ${title}`);
        return true;
      }

      // If the title ENDS with the part keyword, it's almost certainly an accessory
      // e.g. "Mesa Tactical Benelli M4 12 Gauge Urbino Pistol Grip Stock"
      if (new RegExp(`\\b${part}[S]?\\s*$`, "i").test(upper)) {
        console.log(`[debug] Flagged as accessory (title ends with ${part}): ${title}`);
        return true;
      }

      // If the title is SHORT and contains the part name, it's likely a part
      if (upper.split(" ").length < 6) {
        console.log(`[debug] Flagged as accessory (Short title + part): ${title}`);
        return true;
      }
    }
  }

  // 3. Fallback: Check for "FOR [Brand]"
  const GENERAL_BRANDS = "GLOCK|SIG|COLT|SMITH|WESSON|RUGER|BERETTA|CZ|WALTHER|SPRINGFIELD|TAURUS|HK|BROWNING|REMINGTON";
  if (new RegExp(`\\bFOR\\s+(${GENERAL_BRANDS})\\b`, "i").test(upper) && !/\bPISTOL|RIFLE|SHOTGUN|REVOLVER\b/i.test(upper)) {
    console.log(`[debug] Flagged as accessory (For Brand): ${title}`);
    return true;
  }

  return false;
}

const CALIBRE_NOISE = new Set([
  "MM", "LUGER", "ACP", "AUTO", "MAG", "MAGNUM", "SPECIAL", "WIN",
  "WINCHESTER", "REM", "REMINGTON", "NATO", "GAP", "SUPER", "SHORT",
  "LONG", "RIFLE", "PISTOL", "SHOTGUN", "GAUGE", "GA", "FOR", "SALE",
]);

/**
 * Extracts meaningful keywords from a query string.
 */
export function extractKeywords(query) {
  return String(query || "").toUpperCase().split(/\s+/)
    .filter(w => {
      if (w.length < 2) return false;
      if (CALIBRE_NOISE.has(w)) return false;
      // Allow words that are not just digits, OR are exactly 2 digits (e.g. 45, 40, 22)
      return !/^\d+$/.test(w) || /^\d{2}$/.test(w);
    });
}

/**
 * Check if a title is relevant to the search keywords.
 * 
 * Strategy:
 * 1. Must match at least ONE keyword.
 * 2. If a model is provided, IT MUST MATCH.
 * 3. Strictness depends on the source (Marketplace vs Retail).
 * 4. Conflict Check: Block if title contains a different caliber than the search.
 */
export function isRelevant(title, keywords, sourceName = "", searchedModel = "") {
  if (!title || !keywords || keywords.length === 0) return false;
  const up = title.toUpperCase();
  const matches = keywords.filter(kw => up.includes(kw));
  
  // 1. Must match at least ONE keyword (always)
  if (matches.length === 0) return false;

  // 2. Mandatory Model Match (if provided)
  if (searchedModel) {
    const upModel = searchedModel.toUpperCase();
    if (!up.includes(upModel)) return false;
  }

  // 3. Adjust strictness based on source
  const isMarketplace = ["gunbroker", "gunsinternational", "simpsonltd"].includes(sourceName);
  
  if (isMarketplace) {
    const minRequired = Math.max(1, Math.ceil(keywords.length * 0.5));
    if (matches.length < minRequired) {
      console.log(`[debug] Rejected ${title} - matched only ${matches.length}/${keywords.length} keywords.`);
      return false;
    }
  } else {
    if (keywords.length >= 3 && matches.length < 2) {
      console.log(`[debug] Rejected ${title} - matched only ${matches.length}/${keywords.length} keywords.`);
      return false;
    }
  }

  // 4. Conflict Check (Calibers)
  // ... (caliber map definition) ...
  const caliberMap = [
    { key: ".45", patterns: [/\.?45\b/, /\b45\s?ACP\b/, /\b45\s?LC\b/, /\b45\s?COLT\b/] },
    { key: "9MM", patterns: [/\b9MM\b/, /\b9\s?X\s?19\b/, /\b9\s?MM\b/] },
    { key: ".44", patterns: [/\.?44\b/, /\b44\s?MAG\b/, /\b44\s?SPECIAL\b/] },
    { key: ".40", patterns: [/\.?40\b/, /\b40\s?S&W\b/, /\b40\s?SW\b/] },
    { key: ".380", patterns: [/\.?380\b/, /\b380\s?ACP\b/] },
    { key: ".22", patterns: [/\.?22\b/, /\b22\s?LR\b/] },
    { key: ".357", patterns: [/\.?357\b/, /\b357\s?MAG\b/] },
    { key: ".223", patterns: [/\.?223\b/, /\b5\.56\b/, /\b556\b/] },
    { key: ".308", patterns: [/\.?308\b/, /\b7\.62\b/, /\b762\b/] },
  ];

  const searchCalEntry = caliberMap.find(entry => 
    keywords.some(kw => entry.patterns.some(p => p.test(kw)) || kw === entry.key)
  );

  if (searchCalEntry) {
    for (const otherEntry of caliberMap) {
      if (otherEntry.key === searchCalEntry.key) continue;
      if (otherEntry.patterns.some(p => p.test(up))) {
        console.log(`[debug] Rejected ${title} - Caliber conflict: searched ${searchCalEntry.key} but found ${otherEntry.key}`);
        return false;
      }
    }
  }

  return true;
}

/**
 * Attempt to extract brand and caliber from a title string.
 */
export function extractBrandAndCaliber(title, keywords = []) {
  if (!title) return { brand: null, caliber: null };
  const up = title.toUpperCase();

  // 1. Extract Caliber using the same pattern logic as isRelevant
  const caliberMap = [
    { key: ".45", patterns: [/\.?45\b/, /\b45\s?ACP\b/, /\b45\s?LC\b/, /\b45\s?COLT\b/] },
    { key: "9MM", patterns: [/\b9MM\b/, /\b9\s?X\s?19\b/, /\b9\s?MM\b/] },
    { key: ".44", patterns: [/\.?44\b/, /\b44\s?MAG\b/, /\b44\s?SPECIAL\b/] },
    { key: ".40", patterns: [/\.?40\b/, /\b40\s?S&W\b/, /\b40\s?SW\b/] },
    { key: ".380", patterns: [/\.?380\b/, /\b380\s?ACP\b/] },
    { key: ".22", patterns: [/\.?22\b/, /\b22\s?LR\b/] },
    { key: ".357", patterns: [/\.?357\b/, /\b357\s?MAG\b/] },
    { key: ".223", patterns: [/\.?223\b/, /\b5\.56\b/, /\b556\b/] },
    { key: ".308", patterns: [/\.?308\b/, /\b7\.62\b/, /\b762\b/] },
  ];

  let caliber = caliberMap.find(entry => entry.patterns.some(p => p.test(up)))?.key || null;

  // 2. Extract Brand
  const BRANDS = [
    "COLT", "GLOCK", "SIG SAUER", "SIG", "SMITH & WESSON", "SMITH AND WESSON", "S&W", 
    "RUGER", "BERETTA", "CZ", "WALTHER", "SPRINGFIELD ARMORY", "SPRINGFIELD", 
    "TAURUS", "HECKLER & KOCH", "HECKLER AND KOCH", "H&K", "HK", 
    "BROWNING", "REMINGTON", "WINCHESTER", "SAVAGE", "MOSSBERG", "BENELLI",
    "KIMBER", "HENRY", "DANIEL DEFENSE", "PALMETTO STATE ARMORY", "PSA"
  ];

  // Try to find a known brand in the title first
  let brand = BRANDS.find(b => up.includes(b)) || null;

  // Fallback: If no known brand found, check if the first keyword (usually the brand) is in the title
  if (!brand && keywords.length > 0 && up.includes(keywords[0])) {
    brand = keywords[0];
  }

  return { brand, caliber };
}
