/**
 * Firearm price scraper service.
 *
 * Exports:
 *   scrapeFirearm(input) → { query, sources, offerValue, errors, _meta }
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";

import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import AnonymizeUAPlugin from "puppeteer-extra-plugin-anonymize-ua";

// ── Provider registry ────────────────────────────────────────────────────────

import * as truegunvalue from "./scripts/providers/truegunvalue.js";
import * as gunsinternational from "./scripts/providers/gunsinternational.js";
import * as simpsonltd from "./scripts/providers/simpsonltd.js";

const PROVIDERS = [truegunvalue, gunsinternational, simpsonltd];

// ── Puppeteer setup ──────────────────────────────────────────────────────────

puppeteerExtra.use(StealthPlugin());
puppeteerExtra.use(AnonymizeUAPlugin({ makeWindows: false }));

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--window-size=1366,768",
  "--no-first-run",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-extensions",
  "--mute-audio",
  "--disable-gpu",
  "--disable-software-rasterizer",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Timeout ${ms}ms (${label})`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);

    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function normalizeRow(row, brand, caliber) {
  const price = row?.price?.original;
  if (typeof price !== "number" || !Number.isFinite(price)) {
    return null;
  }

  const pageUrl = row?.pageUrl ? String(row.pageUrl) : null;
  if (!pageUrl) {
    return null;
  }

  return {
    sourceId: "000",
    sourceName: String(row.sourceName || "unknown"),
    condition: String(row.condition || "Unknown"),
    pageUrl,
    gunName: row.gunName ? String(row.gunName) : null,
    brand,
    caliber,
    price: {
      currency: "USD",
      original: price,
    },
  };
}

function computeOfferValue(sources) {
  const prices = sources.map((source) => source.price.original);

  return {
    min: prices.length ? Math.min(...prices) : null,
    max: prices.length ? Math.max(...prices) : null,
    currency: "USD",
  };
}

function validateInput(input) {
  const { firearmType, brand, model, caliber } = input || {};

  if (!firearmType || !brand || !model || !caliber) {
    throw new Error("Input must include firearmType, brand, model, and caliber");
  }
}

// ── Core API ─────────────────────────────────────────────────────────────────

/**
 * @param {{ firearmType: string, brand: string, model: string, caliber: string }} input
 * @returns {Promise<{
 *   query: object,
 *   sources: object[],
 *   offerValue: { min: number|null, max: number|null, currency: string },
 *   errors: Record<string, string>,
 *   _meta: { durationMs: number, providers: number, results: number }
 * }>}
 */
async function scrapeFirearm(input) {
  validateInput(input);

  const BRAND = String(input.brand).trim();
  const MODEL = String(input.model).trim();
  const CALIBER = String(input.caliber).trim();
  const TYPE = String(input.firearmType).trim();
  const QUERY = [BRAND, MODEL, CALIBER].join(" ");

  const headless = process.env.HEADLESS !== "false";
  const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH?.trim() || undefined;
  const timeoutMs = Number(process.env.SCRAPE_TIMEOUT_MS) || 10000;

  const startedAt = Date.now();

  const browser = await puppeteerExtra.launch({
    headless,
    executablePath,
    pipe: true,
    args: BROWSER_ARGS,
    defaultViewport: { width: 1366, height: 768 },
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const errors = {};
  const allRows = [];
  const providerLatencies = [];

  try {
    const settled = await Promise.allSettled(
      PROVIDERS.map(async (provider) => {
        const page = await browser.newPage();
        const startTime = Date.now();

        try {
          const rows = await withTimeout(
            provider.scrape({
              page,
              query: QUERY,
              firearmType: TYPE,
            }),
            timeoutMs,
            provider.sourceName
          );

          return {
            name: provider.sourceName,
            rows: Array.isArray(rows) ? rows : [],
            latencyMs: Date.now() - startTime
          };
        } catch (error) {
          return {
            name: provider.sourceName,
            rows: [],
            error,
            latencyMs: Date.now() - startTime
          };
        } finally {
          await page.close().catch(() => { });
        }
      })
    );

    for (const result of settled) {
      const value =
        result.status === "fulfilled"
          ? result.value
          : { name: "unknown", rows: [], error: result.reason };

      if (value.error) {
        errors[value.name] = value.error?.message || String(value.error);
      }

      if (!value.rows?.length && !value.error) {
        errors[value.name] = "No results";
      }

      providerLatencies.push({ name: value.name, ms: value.latencyMs });

      for (const row of value.rows || []) {
        allRows.push(row);
      }
    }

    if (process.env.TRACK_LATENCY === 'true' && providerLatencies.length > 0) {
      console.log(`\n--- Latency Tracking for: ${QUERY} ---`);
      providerLatencies.forEach(p => console.log(`  ${p.name}: ${p.ms}ms`));
      console.log(`------------------------------------------------`);
    }
  } finally {
    await browser.close().catch(() => { });
  }

  const sources = allRows
    .map((row) => normalizeRow(row, BRAND, CALIBER))
    .filter(Boolean)
    .sort((a, b) => a.price.original - b.price.original);

  sources.forEach((source, index) => {
    source.sourceId = String(index + 1).padStart(3, "0");
  });

  return {
    query: {
      firearmType: TYPE,
      brand: BRAND,
      model: MODEL,
      caliber: CALIBER,
      searchQuery: QUERY,
    },
    sources,
    offerValue: computeOfferValue(sources),
    errors,
    _meta: {
      durationMs: Date.now() - startedAt,
      providers: PROVIDERS.length,
      results: sources.length,
    },
  };
}

export { scrapeFirearm };

// ── CLI ──────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isCLI =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCLI) {
  (async () => {
    let input;
    const jsonIndex = process.argv.indexOf("--json");

    if (jsonIndex !== -1 && process.argv[jsonIndex + 1]) {
      input = JSON.parse(process.argv[jsonIndex + 1]);
    } else {
      const payloadPath = path.join(__dirname, "input_payload.json");
      const raw = JSON.parse(await fs.readFile(payloadPath, "utf8"));
      input = raw.quickQuoteRequest?.firearm;
    }

    if (!input) {
      console.error("No input found.");
      process.exit(1);
    }

    const result = await scrapeFirearm(input);
    console.log(JSON.stringify(result, null, 2));
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}