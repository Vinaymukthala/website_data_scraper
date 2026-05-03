# Firearm Pricing Aggregator: Technical Architecture Report

## 1. System Overview

The application is a high-performance, concurrent Node.js data ingestion service that scrapes real-time pricing, availability, and historical market data for firearms from **8 major industry platforms** simultaneously, normalizing volatile HTML structures into a standardized JSON schema.

**Supported Providers (8):**

| # | Provider | Fetch Method | Default Condition | Site Type |
|---|---|---|---|---|
| 1 | TrueGunValue | Puppeteer | Used | Historical price DB |
| 2 | GunsInternational | Puppeteer | Used | Marketplace |
| 3 | SimpsonLtd | Puppeteer | Used | Dealer (WooCommerce-like) |
| 4 | CollectorFirearms | Puppeteer | Used | Dealer (WooCommerce) |
| 5 | BudsGunShop | ScraperAPI | New | Retailer |
| 6 | GunBroker | ScraperAPI | Used | Auction/Marketplace |
| 7 | Palmetto State Armory | ScraperAPI | New | Retailer (Magento) |
| 8 | GrabAGun | ScraperAPI | New | Retailer (Magento) |

> **Guns.com** (`gunscom.js`) exists as a provider module but is currently **disabled** (commented out in the registry).

---

## 2. End-to-End Request Flow

```
User Input (JSON) 
  → LLM Normalizer (GPT-5.4-mini) — fixes typos, infers firearmType
  → validateInput() — ensures brand, model, caliber, firearmType exist
  → Launch Puppeteer browser (single instance, shared across providers)
  → Promise.allSettled() — fires all 8 providers concurrently
    → Each provider gets its own browser page
    → Each provider: Search → Extract → Filter → PDP Fetch → Return rows
  → Centralized post-processing (accessory filter, relevance, normalization)
  → Sort by price ascending → assign sourceIds → return JSON
```

---

## 3. LLM Input Normalization (Pre-Scrape)

**File:** `scripts/llmNormalizer.js`

Before any scraping begins, user input is sent to **OpenAI GPT-5.4-mini** to:
- Fix brand typos (e.g., `"Beneli"` → `"Benelli"`, `"s & W"` → `"Smith & Wesson"`)
- Fix model typos (e.g., `"M 4"` → `"M4"`)
- Fix caliber typos (e.g., `"12 gage"` → `"12 gauge"`)
- **Infer missing `firearmType`** from brand/model knowledge (e.g., M4 → `SHOTGUN`)

**Configuration:**
- Model: `gpt-5.4-mini`
- Temperature: `0.1` (deterministic)
- Max tokens: `150`
- Response format: `json_object` (strict JSON output)
- **Graceful fallback:** If the API key is missing or the call fails, raw input passes through unchanged.

**Environment:** `OPENAI_API_KEY` loaded via `dotenv`.

---

## 4. Web Fetching & Anti-Bot Strategy

### A. Headless Browser (Puppeteer Extra)
**Targets:** TrueGunValue, GunsInternational, CollectorFirearms, SimpsonLtd

- Uses `puppeteer-extra-plugin-stealth` to scrub automation flags
- Uses `puppeteer-extra-plugin-anonymize-ua` for UA spoofing
- **Request interception:** Aborts images, CSS, fonts, media to reduce load time from ~8s to ~1.5s
- Browser args include: `--no-sandbox`, `--disable-blink-features=AutomationControlled`, `--disable-gpu`

### B. ScraperAPI (Residential Proxy Bypass)
**Targets:** BudsGunShop, GunBroker, Palmetto State Armory, GrabAGun, Guns.com

- Routes requests through US residential IPs to bypass Cloudflare Enterprise
- Handles CAPTCHA/Turnstile challenges server-side
- Returns clean HTML for Cheerio parsing (no browser overhead)
- **Timeout:** 25,000ms per ScraperAPI provider; 45,000ms for Puppeteer providers
- **Environment:** `SCRAPER_API_KEY` loaded via `dotenv`

---

## 5. Per-Provider Scraping Flow (Detailed)

### 5.1 TrueGunValue (`truegunvalue.js`)

**Type:** Historical sold-price database (not a store)  
**Fetch:** Puppeteer (direct navigation)  
**PDP Fetching:** None — data is on the listing page itself

**Flow:**
1. Build URL: `https://truegunvalue.com/{category}/{Brand-Model-Caliber}/price-historical-value`
2. Navigate with Puppeteer, check for bot blocks via `ensureNotBlocked()`
3. Extract full page `innerText` from `<main>` element
4. Parse structured sold-listing blocks line-by-line:
   - Each block has `PRICE:`, `CONDITION:`, `MODEL:`, `CALIBER:`, `MANUFACTURER:` fields
5. **Model filter:** Validate `MODEL` field contains the searched model number (e.g., searching "19" matches "G19 GEN5" but rejects "G17")
6. Return top 4 matching listings with extracted brand, caliber, condition
7. No accessory filtering needed — TrueGunValue only returns confirmed firearms

---

### 5.2 GunsInternational (`gunsinternational.js`)

**Type:** Marketplace  
**Fetch:** Puppeteer (direct navigation)  
**PDP Fetching:** Puppeteer (opens new browser pages)

**Flow:**
1. Build advanced search URL with `exclude_term=accessories, gun parts, NFA, Services, Articles` and category filter (Pistols/Rifles/Shotguns)
2. Set age-gate cookie (`alertID_age2=age2`) before navigation
3. Enable request interception — block images, CSS, fonts, media
4. Navigate to search URL, dismiss age-gate overlay if cookie didn't work
5. Wait for `.listing_guts` or `a[href*='gun_id=']` elements
6. **Extract listings** from DOM:
   - **Strategy 1:** `.listing_guts` containers → find `.title_link a` for title/URL, parse price from `<strong>/<b>/<span>`, extract condition from text
   - **Strategy 2 (fallback):** `a[href*='gun_id=']` links with parent context
7. Filter out navigation links (gun shows, recently sold, etc.) via `NAV_RE`
8. **Blind mode:** If ≤3 listings after NAV filter, skip accessory/relevance filtering
9. **Normal mode:** Apply brand+model+caliber strict match OR `isAccessory()` + `isRelevant()` filter
10. **PDP phase (top 3):** Open each URL in a new browser page:
    - Wait for page content > 100 chars
    - Extract specs via label:value parsing from page text (Manufacturer, Caliber, Barrel Length, Condition, etc.)
    - Extract description by matching text between `Description:` and the next spec label
    - Skip seller metadata labels (price, email, contact, etc.)
11. **Post-PDP check:** In blind mode, run `isAccessory()` on title before including result

---

### 5.3 SimpsonLtd (`simpsonltd.js`)

**Type:** Dealer  
**Fetch:** Puppeteer (direct navigation)  
**PDP Fetching:** Puppeteer (opens new browser pages)

**Flow:**
1. Navigate to `https://www.simpsonltd.com/search?query={query}`
2. Check for bot blocks via `ensureNotBlocked()`
3. Wait for `a.list-item-link` or `.search-results a[href*='/products/']`
4. **Extract listings** from search cards:
   - Title from link text, price from `.search-item-price span`
   - Inline specs from `<span>` elements: `Cal:`, `Blue:`, `Bore:`, `Barrel:`, `Stock:`
5. If 0 results, retry with simplified query (first word only)
6. **Blind mode:** If ≤3 listings, skip filtering entirely
7. **Normal mode:** Apply caliber matching (checks both title AND `specs.caliber`), brand+model match, `isAccessory()`, `isRelevant()`
8. **PDP phase (top 3):** Open each `/products/` URL in new page:
   - Extract `<h1>` title, SKU from `<h3>`, price from `.product-price`
   - Parse ALL label:value specs from body text line-by-line
   - Build condition from stock/blue/bore specs
   - Extract description from longest `<p>` elements
9. **Post-PDP check:** Run `isAccessory()` on final title — already built into the PDP loop
10. Clean title: strip SKU codes `(SN: ...)`, item IDs `(L2026-04730)`, trailing condition tags

---

### 5.4 CollectorFirearms (`collectorfirearms.js`)

**Type:** Dealer (WooCommerce)  
**Fetch:** Puppeteer (direct navigation)  
**PDP Fetching:** Puppeteer (opens new browser pages)

**Flow:**
1. Navigate to `https://collectorsfirearms.com/?s={query}`
2. Block heavy assets (images, CSS, fonts, analytics trackers)
3. Wait for `article`, `.product`, or `a[href*='/product/']` elements
4. **Extract listings** from WooCommerce product cards:
   - Title from `.woocommerce-loop-product__title a` or `h2 a`
   - Price from `.price` / `.amount` (handles sale prices — takes last price)
   - Short description from `.woocommerce-product-details__short-description`
5. **Fallback:** If no product cards, try generic `a[href*='/product/']` links
6. **Blind mode:** If ≤3 listings, skip filtering
7. **Normal mode:** Brand+model+caliber strict match OR `isAccessory()` + `isRelevant()`
8. **PDP phase (top 3):** Open each URL in new page:
   - Description from `#tab-description` or `.woocommerce-Tabs-panel--description`
   - Specs from `.woocommerce-product-attributes tr` (th/td pairs)
   - JSON-LD extraction for brand/model
   - Label:value parsing from description text lines
9. **Post-PDP check:** In blind mode, `isAccessory()` on title
10. Clean title: strip `(SN: ...)`, `(L2026-04730)`, trailing NEW/USED
11. Condition inferred from title + description text (New/Used/Excellent/etc.)

---

### 5.5 BudsGunShop (`budsgunshop.js`)

**Type:** Retailer  
**Fetch:** ScraperAPI (plain HTML)  
**PDP Fetching:** ScraperAPI (plain HTML → Cheerio)

**Flow:**
1. Fetch `https://www.budsgunshop.com/search.php/type/firearms/q/{query}/` via ScraperAPI with `country_code=us`
2. Check for Cloudflare block in response HTML
3. **Extract listings** via Cheerio from `.product_box_container` cards:
   - Title from `span[itemprop='name']`
   - URL from `a.product-box-link`
   - Price from `span.search_price`
4. **Blind mode:** If ≤3 listings, skip filtering
5. **Normal mode:** Brand+model+caliber strict match OR `isAccessory()` + `isRelevant()`
6. **PDP phase (top 3):** Fetch each URL via ScraperAPI:
   - Description from `.product_description`, `#tab-description`, `[itemprop='description']`
   - Fallback: largest paragraph > 80 chars
   - Condition from `[class*='condition']`
   - Specs: JSON-LD for brand, first `table.table-striped.table-bordered` for caliber/action/capacity/barrel
7. **Post-PDP check:** In blind mode, `isAccessory()` on title
8. Default condition: New (unless title contains USED/REFURB)

---

### 5.6 GunBroker (`gunbroker.js`)

**Type:** Auction/Marketplace  
**Fetch:** ScraperAPI (plain HTML)  
**PDP Fetching:** ScraperAPI (plain HTML → Cheerio)

**Flow:**
1. Fetch `https://www.gunbroker.com/guns-firearms/search?keywords={query}&Sort=13` (Sort=13 = Buy Now) via ScraperAPI
2. Check for Cloudflare block
3. **Extract listings** from `div.listing[id^='item-']`:
   - Title from `.listing-text` (handles duplicate text: if first half = second half, use first half only)
   - Price via regex: `Price\s+(\$[\d,]+\.?\d{0,2})`
   - URL: `https://www.gunbroker.com/item/{id}`
4. **Blind mode:** If ≤3 listings, skip filtering
5. **Normal mode:** Brand+model+caliber strict match OR `isAccessory()` + `isRelevant()`
6. **PDP phase (top 3):** Fetch each item URL via ScraperAPI, then 4-strategy spec extraction:
   - **Strategy 1:** `dataLayer.push` script parsing for manufacturer, model, caliber, action, barrel_length
   - **Strategy 2:** DOM label/value `<span>` pairs (Manufacturer, Caliber, Model, etc.)
   - **Strategy 3:** `SPECIFICATIONS` block inside `iframe.srcdoc-iframe` — parse 30+ known GunBroker labels with boundary-aware regex
   - **Strategy 4:** Fallback `extractSpecsFromHtml()` generic table/dt-dd parser
   - Description: longest non-noise `iframe.srcdoc-iframe` content (filters out layaway/disclaimers/terms via `NOISE_RE`)
   - Fallback description: `meta[name='description']`
7. **Post-PDP check:** In blind mode, `isAccessory()` on title
8. Condition: PDP `.condition` element, or inferred from title (NEW/NIB → New, else Used)

---

### 5.7 Palmetto State Armory (`palmettostatearmory.js`)

**Type:** Retailer (Magento)  
**Fetch:** ScraperAPI (plain HTML)  
**PDP Fetching:** ScraperAPI (plain HTML → Cheerio)

**Flow:**
1. Fetch `https://palmettostatearmory.com/catalogsearch/result/?q={query}` via ScraperAPI
2. Check for Cloudflare block
3. **Extract listings** from `.item.product.product-item`:
   - Title from `.product-item-name`
   - URL from `a.product-item-link` or first `<a>`
   - Price: `span.price-wrapper.final-price span.price` → fallback `span.price-wrapper span.price` → fallback regex
4. **Blind mode:** If ≤3 listings, skip filtering
5. **Normal mode:** Brand+model+caliber strict match OR `isAccessory()` + `isRelevant()`
6. **PDP phase (top 3):** Fetch via ScraperAPI:
   - **Description** from `.product.attribute.description .value` (Features section) — extracts from `<p>` and `<li>` elements, strips PageBuilder CSS noise
   - **Specs** from `.product.attribute.overview .value` (Details section) — parses 40+ PSA-specific labels (Brand, Model, Caliber/Gauge, Chamber, Capacity, Barrel Length, Action, OAL, Sights, Weight, etc.) using boundary-aware regex
   - Alias normalization: `caliberGauge` → `caliber`, `modelSeries` → `model`
7. **Post-PDP check:** In blind mode, `isAccessory()` on title
8. Default condition: New

---

### 5.8 GrabAGun (`grabagun.js`)

**Type:** Retailer (Magento)  
**Fetch:** ScraperAPI (plain HTML)  
**PDP Fetching:** ScraperAPI (plain HTML → Cheerio)

**Flow:**
1. Fetch `https://grabagun.com/bsearch/result/?q={query}` via ScraperAPI with `country_code=us`
2. Check for Cloudflare block
3. **Extract listings** from `.product-item` / `.item.product`:
   - Title from `.product-item-link`
   - URL from title link href
   - Price from `.price-box .price`
4. Log raw titles for debugging
5. **Blind mode:** If ≤3 listings, skip filtering
6. **Normal mode:** Brand+model+caliber strict match OR `isAccessory()` + `isRelevant()`
7. **PDP phase (top 3):** Fetch via ScraperAPI:
   - Description from `#description`, `.product.description`, `[itemprop='description']`
   - Fallback: largest paragraph > 80 chars
   - **Embedded spec extraction:** GrabAGun descriptions often end with `"specifications manufacturer: benelli model: m4..."`. This block is detected via regex, stripped from the description, and parsed into 20+ spec fields (manufacturer, gauge, caliber, action, barrel length, chamber, capacity, finishes, sights, weight, etc.)
   - Generic `extractSpecsFromHtml()` for table-based specs (merged: table specs take priority over description-embedded specs)
8. **Post-PDP check:** In blind mode, `isAccessory()` on title
9. Default condition: New

---

## 6. Blind Mode (≤3 Listings Logic)

All 7 PDP-fetching providers implement **blind mode**:

- **Trigger:** When the search results page returns **≤3 raw listings**
- **Behavior:** Skip ALL pre-filtering (accessory regex, relevance scoring, brand/model/caliber matching) and blindly open every listing as a PDP target
- **Post-PDP validation:** After fetching PDP data, run `isAccessory()` on the title. If it's an accessory, reject it with a log message
- **Rationale:** With very few search results, aggressive title-based heuristics may incorrectly reject valid firearms. By opening the PDP first, we get richer data to make a better decision

---

## 7. Centralized Data Filtering (`scraperService.js`)

After all providers return their rows, `scraperService.js` applies a **second layer** of filtering:

### 7.1 Universal Explicit Part Filter
Regex patterns that immediately reject:
- `FOR/FITS` + known brand patterns (e.g., "For Glock G19")
- Explicit part names: `MINICLIP`, `CHOKE`, `HEAT SHIELD`, `MOUNT`, `RAIL`
- Part kits: `GRIP KIT`, `STOCK KIT`, `HANDGUARD KIT`
- Aftermarket brands at title start: `PROMAG`, `MAGPUL`, `ETS`, `MEC-GAR`, `OPSOL`
- Standalone `BARREL` at end of title
- `MAGAZINE/MAG` without gun-type words (PISTOL, RIFLE, SHOTGUN, etc.)

### 7.2 Strict Match Bypass
If title contains **Brand + Model + Caliber** (and not reloading/mold terms), it bypasses the accessory filter entirely — high confidence it's a firearm.

### 7.3 Accessory & Relevance Check
For non-strict matches (excluding TrueGunValue which is always trusted):
- `isAccessory(title)` — checks broad regex, accessory brands, part keywords, "FOR Brand" patterns, short titles with parts
- `isRelevant(title, keywords)` — keyword intersection scoring with model mandate and caliber conflict detection

### 7.4 PSA Special Rule
For Palmetto State Armory results: Brand AND Model **must** appear in the title (extra strict to avoid generic PSA product matches).

### 7.5 Row Normalization (`normalizeRow`)
Each surviving row is normalized:
- Validate price is a finite number > 0
- Validate pageUrl exists
- Validate title exists and length ≥ 3
- **Final safety net:** `isAccessory(title)` one more time
- Clean description via `cleanDescription()` (strips CSS noise, HTML entities, legal boilerplate, navigation phrases, prices, seller info)
- Inject default condition if Unknown (per provider defaults table)
- Collect all extra PDP attributes dynamically (excluding core keys and noise fields like serial, UPC, SKU, seller metadata)

### 7.6 Output Schema
```json
{
  "sourceId": "001",
  "sourceName": "budsgunshop",
  "condition": "New",
  "pageUrl": "https://...",
  "title": "Smith & Wesson M&P Shield 9mm",
  "brand": "Smith & Wesson",
  "model": "M&P Shield",
  "caliber": "9mm",
  "price": { "currency": "USD", "original": 399.99 },
  "description": "...",
  "attributes": { "barrelLength": "3.1\"", "capacity": "8", "action": "Semi-Auto" }
}
```

---

## 8. Shared Utility Functions (`_util.js`)

| Function | Purpose |
|---|---|
| `parseUsdPrice(input)` | Extract numeric USD price from any text format |
| `conditionFromText(text)` | Infer New/Used/Unknown from description text |
| `normalizeCondition(raw)` | Map to standard terms: New, Excellent, Very Good, Good, Fair, Used |
| `isAccessory(title, brand)` | Multi-layer heuristic: regex, brand check, part keywords, context-aware |
| `extractKeywords(query)` | Strip caliber noise words, return meaningful search terms |
| `isRelevant(title, keywords, source, model)` | Keyword intersection + model mandate + caliber conflict check |
| `extractSpecsFromHtml($)` | Generic Cheerio spec extractor (Magento tables, dt/dd, li label:value) |
| `cleanDescription(raw)` | Strip CSS, HTML entities, legal boilerplate, navigation, prices |
| `ensureNotBlocked(page)` | Detect Cloudflare/CAPTCHA/bot-block pages |
| `extractBrandAndCaliber(title)` | Extract known brand and caliber from a title string |

---

## 9. Environment Variables

| Variable | Purpose | Used By |
|---|---|---|
| `OPENAI_API_KEY` | OpenAI API key for LLM normalization | `llmNormalizer.js` |
| `SCRAPER_API_KEY` | ScraperAPI key for proxy bypass | BudsGunShop, GunBroker, PSA, GrabAGun |
| `SCRAPE_TIMEOUT_MS` | Global Puppeteer provider timeout (default: 45000) | `scraperService.js` |
| `HEADLESS` | Set to `"false"` for visible browser | `scraperService.js` |
| `PUPPETEER_EXECUTABLE_PATH` | Custom Chrome/Chromium path | `scraperService.js` |

---

## 10. Performance & Concurrency

- **Parallel execution:** All 8 providers run simultaneously via `Promise.allSettled()`
- **Timeout strategy:** ScraperAPI providers capped at 25s, Puppeteer providers at 45s (configurable)
- **Per-provider timing:** Logged to console after every run with OK/FAIL status
- **Typical end-to-end latency:** 10–27 seconds depending on provider response times
- **Browser instance:** Single Puppeteer browser, one page per provider (closed after use)
- **Graceful degradation:** Failed providers don't block others; errors collected in response `errors` object
