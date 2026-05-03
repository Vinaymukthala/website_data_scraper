import { fileURLToPath } from "url";

/** Shotgun gauge rows — include run-on (12ga), hyphenated, and common seller typos. */
function shotgunGaugePatterns(n) {
  const s = String(n);
  return [
    new RegExp(`\\b${s}\\s?GAUGE\\b`, "i"),
    new RegExp(`\\b${s}\\s?GA\\b`, "i"),
    new RegExp(`\\b${s}GA\\b`, "i"),
    new RegExp(`\\b${s}\\s*-\\s*GA(?:UGE)?\\b`, "i"),
    new RegExp(`\\b${s}\\s+gauge\\b`, "i"),
  ];
}

export const CALIBER_MAP = [
  // Handgun & Rifle — order matters: longer / multi-digit cartridges before ".45"
  // so "5.56X45" does not match the ".45" entry via a bare "45" suffix.
  { key: "9MM", patterns: [/\b9MM\b/, /\b9\s?X\s?19\b/, /\b9\s?MM\b/] },
  { key: ".380", patterns: [/\.?380\b/, /\b380\s?ACP\b/, /\b380\s?AUTO\b/] },
  {
    key: ".223",
    patterns: [
      /\.?223\b/,
      /\b5\.56\b/,
      /\b556\b/,
      /5\.56\s*[x×]\s*45/i,
      /\b5\.56X45MM?\b/i,
      /\b556\s*NATO\b/i,
      /\b5\.56\s*NATO\b/i,
    ],
  },
  { key: ".308", patterns: [/\.?308\b/, /\b7\.62\b/, /\b762\b/] },
  { key: ".44", patterns: [/\.?44\b/, /\b44\s?MAG\b/, /\b44\s?SPECIAL\b/] },
  { key: ".40", patterns: [/\.?40\b/, /\b40\s?S&W\b/, /\b40\s?SW\b/] },
  {
    key: ".45",
    patterns: [
      /(?<![xX/.\d])\.?45\b(?![\d])/i,
      /\b45\s?ACP\b/i,
      /\b45\s?AUTO\b/i,
      /\b45\s?LC\b/i,
      /\b45\s?COLT\b/i,
    ],
  },
  { key: ".357", patterns: [/\.?357\b/, /\b357\s?MAG\b/] },
  { key: ".22", patterns: [/\.?22\b/, /\b22\s?LR\b/] },
  // Shotgun Gauges (patterns cover "12 ga", "12ga", "12-GA", "12 gauge", etc.)
  { key: "12GA", patterns: shotgunGaugePatterns(12) },
  { key: "20GA", patterns: shotgunGaugePatterns(20) },
  { key: "16GA", patterns: shotgunGaugePatterns(16) },
  { key: "28GA", patterns: shotgunGaugePatterns(28) },
  { key: "10GA", patterns: shotgunGaugePatterns(10) },
  { key: ".410", patterns: [/\.?410\s?(?:GAUGE|GA|BORE)?\b/i] },
];

/** Resolve which CALIBER_MAP entry the user is searching for; prefer explicit caliber string over full query. */
export function resolveSearchCaliberEntry(upQuery, explicitCaliberUpper = "") {
  const hints = [explicitCaliberUpper, upQuery].filter((h) => h && String(h).trim());
  for (const hint of hints) {
    const h = String(hint).toUpperCase();
    const entry = CALIBER_MAP.find(
      (e) => e.patterns.some((p) => p.test(h)) || h.includes(e.key)
    );
    if (entry) return entry;
  }
  return null;
}

/**
 * True if listing text explicitly mentions a different mapped caliber/gauge than the user search
 * (e.g. search 12 GA, listing says 16 GA). Empty or ambiguous listing text → false.
 */
export function listingShowsDifferentCaliberThanSearch(
  listingCaliberText,
  titleOrExtraText = "",
  explicitCaliberHint = "",
  fullQuery = ""
) {
  const searchEntry = resolveSearchCaliberEntry(
    String(fullQuery || "").toUpperCase(),
    String(explicitCaliberHint || "").toUpperCase()
  );
  if (!searchEntry) return false;
  const combined = [listingCaliberText, titleOrExtraText].filter(Boolean).join(" ");
  const up = combined.toUpperCase().replace(/\s+/g, " ").trim();
  if (!up) return false;
  for (const other of CALIBER_MAP) {
    if (other.key === searchEntry.key) continue;
    if (other.patterns.some((p) => p.test(up))) {
      return true;
    }
  }
  return false;
}

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

// ── PDP breadcrumb (category trail) ─────────────────────────────────────────

/**
 * Collects category breadcrumbs from JSON-LD (BreadcrumbList) and common DOM patterns.
 * @param {import("cheerio").CheerioAPI} $ Cheerio root for the PDP HTML
 * @returns {string} e.g. "Firearms > Shotguns > Semi-Auto"
 */
export function extractBreadcrumbTrailFrom$($) {
  const order = [];
  const seen = new Set();

  function push(t) {
    const s = String(t || "")
      .replace(/\s+/g, " ")
      .replace(/^[/>»\s-]+|[/>»\s-]+$/g, "")
      .trim();
    if (s.length < 2) return;
    if (/^home$/i.test(s)) return;
    const low = s.toLowerCase();
    if (seen.has(low)) return;
    seen.add(low);
    order.push(s);
  }

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).html();
    if (!raw) return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const types = node["@type"];
      const typeList = Array.isArray(types) ? types : types ? [types] : [];
      if (!typeList.includes("BreadcrumbList") || !Array.isArray(node.itemListElement)) continue;
      const items = [...node.itemListElement].sort(
        (a, b) => Number(a.position || 0) - Number(b.position || 0)
      );
      for (const it of items) {
        let name = typeof it.name === "string" ? it.name : "";
        if (!name && it.item && typeof it.item === "object" && typeof it.item.name === "string") {
          name = it.item.name;
        }
        push(name);
      }
    }
  });

  if (order.length === 0) {
    const domSelectors = [
      ".breadcrumbs li",
      ".breadcrumbs a",
      ".breadcrumb li",
      ".breadcrumb a",
      '[itemtype*="BreadcrumbList"] li',
      "nav.breadcrumbs li",
      "nav.breadcrumbs a",
      ".page-wrapper .breadcrumbs a",
      ".page-title-wrapper .breadcrumbs li",
      "#woocommerce-breadcrumb a",
      ".woocommerce-breadcrumb a",
    ];
    for (const sel of domSelectors) {
      $(sel).each((_, el) => {
        const t = $(el).text().replace(/\s+/g, " ").trim();
        if (!t || /^[\/>»]+$/i.test(t)) return;
        push(t);
      });
      if (order.length >= 2) break;
    }
  }

  return order.join(" > ");
}

/**
 * True when the store category trail is clearly parts, ammo, reloading, or accessories (not complete firearms).
 * Unknown or empty trails return false.
 */
export function breadcrumbTrailImpliesNonFirearm(trail) {
  const j = String(trail || "")
    .replace(/[:;|\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (j.length < 4) return false;

  const BAD =
    /\b(GUN\s+PARTS|FIREARM\s+PARTS|SHOTGUN\s+PARTS|PISTOL\s+PARTS|RIFLE\s+PARTS|AR\s+PARTS|UPPER\s+PARTS|LOWER\s+PARTS|SLIDE\s+PARTS|FRAME\s+PARTS|PARTS\s+&\s*ACCESSOR|PARTS\s+AND\s+ACCESSOR|ACCESSORIES|RELOADING|AMMUNITION|\bAMMO\b(?!NITION\b)|POWDER\b|PRIMERS?\b|\bBRASS\b|\bBULLETS?\b|PROJECTILES?\b|HOLSTERS?|OPTICS|SCOPES?|CLEANING\s+(?:SUPPLIES|SUPPLY|KIT|GEAR)|MAGAZINES?(?!SPRING\b)|CHOKE\s+TUB|FLASHLIGHTS?|LASERS?|ARCHERY|APPAREL|GIFTS?|BOOKS|KNIVES)\b/i;

  return BAD.test(j);
}

// ── Firearm Filtering & Relevance ───────────────────────────────────────────

// Omit SCOPE/OPTIC/SLING/SCALE: they appear in real gun copy ("scope mounts", "sling swivels", "Rockwell scale", legal "scope of").
const ACCESSORY_RE = /\b(HOLSTER[S]?|CLEANING|AMMO|BAYONET[S]?|PARTS KIT|MANUAL[S]?|CONVERSION KIT|LOADER[S]?|LASER[S]?|FLASHLIGHT[S]?|SUPPRESSOR[S]?|SILENCER[S]?|KNIFE|KNIVES|DIE[S]?|RELOADING|PRESS|BULLET[S]?|PROJECTILE[S]?|BIPOD[S]?|TRIPOD[S]?|BAG[S]?|MOULD|MOLD)\b/i;
// Note: avoid "PAST" alone — matches common English ("in the past") inside long PDP/legal text passed to isAccessory.
const ACCESSORY_BRAND_RE = /\b(ETS|RWB|PMAG|MAGPUL|HEXMAG|E-LANDER|EMTAN|KCI|VORTEX|LEUPOLD|TRIJICON|HOLOSUN|CALDWELL|WHEELER|LEE|RCBS|HORANDY|LYMAN|DILLON)\b/i;

/**
 * Checks if a title likely refers to an accessory rather than a firearm.
 */
export function isAccessory(title, searchedBrand = "") {
  const upper = String(title || "").toUpperCase().trim();
  if (!upper) return true;

  // Long PDP blobs (e.g. GunBroker) repeat words like "SCOPE" ("scope of liability") — only scan listing copy.
  const head = upper.length > 3500 ? upper.slice(0, 3500) : upper;

  // 1. Common accessories (unambiguous)
  if (ACCESSORY_RE.test(head)) return true;
  if (ACCESSORY_BRAND_RE.test(head)) return true;

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
      if (new RegExp(`\\b(FOR|FITS)\\b.*\\b${part}\\b`, "i").test(upper)) return true;

      // If the title ENDS with the part keyword, it's almost certainly an accessory
      // e.g. "Mesa Tactical Benelli M4 12 Gauge Urbino Pistol Grip Stock"
      if (new RegExp(`\\b${part}[S]?\\s*$`, "i").test(upper)) return true;

      // If the title is SHORT and contains the part name, it's likely a part
      if (upper.split(" ").length < 6) return true;
    }
  }

  // 3. Fallback: Check for "FOR [Brand]"
  const GENERAL_BRANDS = "GLOCK|SIG|COLT|SMITH|WESSON|RUGER|BERETTA|CZ|WALTHER|SPRINGFIELD|TAURUS|HK|BROWNING|REMINGTON";
  if (new RegExp(`\\bFOR\\s+(${GENERAL_BRANDS})\\b`, "i").test(upper) && !/\bPISTOL|RIFLE|SHOTGUN|REVOLVER\b/i.test(upper)) {
    return true;
  }

  return false;
}

const CALIBRE_NOISE = new Set([
  "MM", "LUGER", "ACP", "AUTO", "MAG", "MAGNUM", "SPECIAL", "WIN",
  "REM", "NATO", "GAP", "SUPER", "SHORT",
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
 * Flexible model matching — checks if a title contains the model.
 * First tries exact substring, then falls back to word-by-word matching.
 * e.g. model "M&P Shield" matches title "M&P9 Shield Plus" because
 * both words "M&P" and "SHIELD" appear in the title individually.
 */
export function modelMatches(title, model) {
  if (!model) return true;
  const upTitle = (title || "").toUpperCase();
  const upModel = model.toUpperCase().trim();
  if (!upModel) return true;

  // Avoid "Model 12" matching "MODEL 1200" via naive substring / digit substring
  if (/\d/.test(upModel)) {
    const esc = upModel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^A-Z0-9])${esc}([^A-Z0-9]|$)`, "i").test(upTitle)) return true;
  } else if (upTitle.includes(upModel)) return true;

  const modelWords = upModel.split(/\s+/).filter((w) => w.length >= 2);
  const wordOk =
    modelWords.length > 0 &&
    modelWords.every((w) => {
      if (/^\d+$/.test(w)) return new RegExp(`(^|[^0-9])${w}([^0-9]|$)`).test(upTitle);
      return upTitle.includes(w);
    });
  if (wordOk) return true;

  const winMdl = upModel.match(/^MODEL\s+(\d{1,3})\s*$/);
  if (winMdl) {
    const n = winMdl[1];
    if (new RegExp(`\\bM[-\\s]?${n}\\b`).test(upTitle)) return true;
    if (new RegExp(`\\bMOD\\.?\\s*${n}\\b`).test(upTitle)) return true;
  }

  // Catalog titles often space tokens ("SCAR 16S") vs user input "SCAR16S" — compare alphanumerics only.
  const compactTitle = upTitle.replace(/[^A-Z0-9]/g, "");
  const compactModel = upModel.replace(/[^A-Z0-9]/g, "");
  if (compactModel.length >= 3 && compactTitle.includes(compactModel)) return true;

  return false;
}

/**
 * Check if a title is relevant to the search keywords.
 * 
 * Strategy:
 * 1. Must match at least ONE keyword.
 * 2. If a model is provided, IT MUST MATCH (flexible word-by-word).
 * 3. Strictness depends on the source (Marketplace vs Retail).
 * 4. Conflict Check: Block if title contains a different caliber than the search.
 */
export function isRelevant(
  title,
  keywords,
  sourceName = "",
  searchedModel = "",
  fullQuery = "",
  explicitCaliberHint = ""
) {
  if (!title || !keywords || keywords.length === 0) return false;
  const up = title.toUpperCase();
  const upQuery = (fullQuery || keywords.join(" ")).toUpperCase();
  const matches = keywords.filter(kw => up.includes(kw.toUpperCase()));
  
  // 1. Block accessories ...
  if (isAccessory(title)) return false;

  // 2. Must match at least ONE keyword (always)
  if (matches.length === 0) return false;

  // 3. Mandatory Model Match (flexible word-by-word)
  if (searchedModel && !modelMatches(title, searchedModel)) {
    return false;
  }

  // 4. Adjust strictness based on source
  const isMarketplace = ["gunbroker", "gunsinternational", "simpsonltd", "budsgunshop"].includes(sourceName);
  
  if (isMarketplace) {
    const minRequired = Math.max(1, Math.ceil(keywords.length * 0.5));
    if (matches.length < minRequired) return false;
  } else if (keywords.length >= 3 && matches.length < 2) {
    return false;
  }

  // 5. Conflict Check (Calibers)
  // Prefer explicit caliber (e.g. "12 ga") so model numbers like "Model 12" in the query do not steal resolution.
  const upExplicit = String(explicitCaliberHint || "").toUpperCase();
  let searchCalEntry = resolveSearchCaliberEntry(upQuery, upExplicit);

  if (!searchCalEntry) {
    searchCalEntry = CALIBER_MAP.find((entry) =>
      keywords.some((kw) => {
        const upKw = kw.toUpperCase();
        return entry.patterns.some((p) => p.test(upKw)) || upKw === entry.key;
      })
    );
  }

  if (searchCalEntry) {
    for (const otherEntry of CALIBER_MAP) {
      if (otherEntry.key === searchCalEntry.key) continue;
      if (otherEntry.patterns.some((p) => p.test(up))) return false;
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
  let caliber = CALIBER_MAP.find(entry => entry.patterns.some(p => p.test(up)))?.key || null;

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
