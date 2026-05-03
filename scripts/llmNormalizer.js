import OpenAI from "openai";

/**
 * OpenAI (optional): only used when `OPENAI_API_KEY` is set and a feature is turned on.
 *
 * | Variable | Role |
 * |----------|------|
 * | `OPENAI_API_KEY` | Required for any LLM call. If unset, all helpers no-op / use scraped text only. |
 * | `USE_LLM_NORMALIZE` | Set `1` or `true` to run `normalizeInput()` through the model (typos, firearmType). Default: off — input is passed through unchanged. |
 * | `OPENAI_MODEL` | Optional chat model id (default `gpt-5.4-mini`). Used for normalize and GunBroker enrich. |
 */

let openaiInstance = null;

function getOpenAI() {
  if (!openaiInstance) {
    openaiInstance = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }
  return openaiInstance;
}

function resolveChatModel() {
  return process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
}

/** When true (`1` / `true`), OpenAI may normalize input. Default: off — pass input through unchanged. */
function isUseLlmNormalizeEnabled() {
  const v = process.env.USE_LLM_NORMALIZE;
  return v === "1" || v === "true";
}

/**
 * Normalizes firearm input using an LLM.
 * Corrects typos in brand, model, caliber, and infers the firearmType if missing.
 *
 * @param {Object} input - The raw user input { firearmType, brand, model, caliber }
 * @returns {Promise<Object>} - The normalized input, or original input if LLM fails
 */
export async function normalizeInput(input) {
  if (!isUseLlmNormalizeEnabled()) {
    return input;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.warn("[LLM] OPENAI_API_KEY is not set. Skipping normalization.");
    return input;
  }

  const openai = getOpenAI();

  try {
    const prompt = `
You are an expert in firearms. Your task is to correct and normalize the provided input about a firearm.
Fix any typos in the brand, model, or caliber.
If the firearmType is missing or incorrect, infer it based on the brand and model. It must be one of: HANDGUN, SHOTGUN, RIFLE, or UNKNOWN.

Raw Input:
${JSON.stringify(input, null, 2)}

Return a strict JSON object with exactly these four keys:
- "firearmType": string (must be HANDGUN, SHOTGUN, RIFLE, or UNKNOWN)
- "brand": string (corrected brand name, e.g., "Sig Sauer" instead of "Sig saur")
- "model": string (corrected model name, e.g., "P365 XL" instead of "p365xl")
- "caliber": string (corrected caliber, e.g., "9mm Luger" instead of "9m")

Only output the JSON. Do not include markdown formatting or explanation.
`;

    const response = await openai.chat.completions.create({
      model: resolveChatModel(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_completion_tokens: 150,
    });

    const resultText = response.choices[0].message.content;
    const normalized = JSON.parse(resultText);

    console.log("[LLM] Successfully normalized input:");
    console.log(`  Raw:        ${JSON.stringify(input)}`);
    console.log(`  Normalized: ${JSON.stringify(normalized)}`);

    return normalized;
  } catch (error) {
    console.error(`[LLM] Error during normalization: ${error.message}. Falling back to raw input.`);
    return input;
  }
}

/**
 * Build a short listing summary and structured firearm key/values from messy GunBroker PDP text + scraped fields.
 * @param {{ title: string, rawDescription: string, scrapedSpecs: object, conditionHint?: string }} input
 * @returns {Promise<{ summary: string, attributes: Record<string, string>, fromLlm: boolean }>}
 */
export async function enrichGunBrokerListing({
  title = "",
  rawDescription = "",
  scrapedSpecs = {},
  conditionHint = "",
}) {
  const specsForPrompt = { ...scrapedSpecs };
  if (conditionHint) {
    specsForPrompt.listingCondition = conditionHint;
  }

  if (!process.env.OPENAI_API_KEY) {
    const summary = String(rawDescription || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    const attributes = {};
    for (const [k, v] of Object.entries(specsForPrompt)) {
      if (v == null) continue;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v).trim();
      if (s) attributes[k] = s;
    }
    return {
      summary: summary || `GunBroker listing: ${title}`.trim(),
      attributes,
      fromLlm: false,
    };
  }

  const openai = getOpenAI();

  const prompt = `You are a firearms data expert. Input is a GunBroker marketplace listing (title, raw seller HTML text, and fields already scraped from the page).

1) Write "summary": a clear, professional description in exactly 4 to 5 lines (4-5 separate sentences, plain text, no bullet list, no markdown). Summarize the firearm: what it is, condition or configuration if known, and notable features. Do not include shipping, payment, returns, legal boilerplate, or seller contact. Do not fabricate a serial number.

2) Build "firearmDetails": an object of key-value pairs (string values only) for every firearm fact you can infer from the text: e.g. manufacturer, model, caliberOrGauge, action, barrelLength, capacity, finish, stock, sights, weight, countryOfOrigin, category, etc. Use camelCase keys. Prefer facts from the scraped fields when they agree with the text; correct obvious typos. Omit keys you cannot support from the content. Do not copy long policy text into values.

Listing title: ${title}

Scraped fields (JSON): ${JSON.stringify(specsForPrompt)}

Raw listing / description text:
${String(rawDescription || "").slice(0, 12_000)}

Return strict JSON: {"summary": string, "firearmDetails": object}.`;

  try {
    const response = await openai.chat.completions.create({
      model: resolveChatModel(),
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.2,
      max_completion_tokens: 1200,
    });

    const resultText = response.choices[0].message.content;
    const parsed = JSON.parse(resultText);
    const summary = String(parsed.summary || "").replace(/\s+/g, " ").trim();
    const rawDetails = parsed.firearmDetails && typeof parsed.firearmDetails === "object"
      ? parsed.firearmDetails
      : {};

    const attributes = {};
    for (const [k, v] of Object.entries(rawDetails)) {
      if (v == null) continue;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v).trim();
      if (s) {
        attributes[String(k).replace(/\s+/g, "")] = s;
      }
    }

    return {
      summary: summary || String(rawDescription || "").replace(/\s+/g, " ").trim().slice(0, 500),
      attributes,
      fromLlm: true,
    };
  } catch (error) {
    console.error(`[LLM] enrichGunBrokerListing: ${error.message}. Fallback without LLM.`);
    const summary = String(rawDescription || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 2000);
    const attributes = {};
    for (const [k, v] of Object.entries(specsForPrompt)) {
      if (v == null) continue;
      const s = typeof v === "object" ? JSON.stringify(v) : String(v).trim();
      if (s) attributes[k] = s;
    }
    return {
      summary: summary || `GunBroker listing: ${title}`.trim(),
      attributes,
      fromLlm: false,
    };
  }
}
