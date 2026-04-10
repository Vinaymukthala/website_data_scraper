import { scrapeFirearm } from "./scraperService.js";

/**
 * Scrape firearm prices from multiple online sources.
 *
 * @param {{ firearmType: string, brand: string, model: string, caliber: string }} input
 * @returns {Promise<{ query: object, sources: object[], offerValue: object, errors: object, _meta: object }>}
 */
async function scrapeFirearmMain(input) {
  return scrapeFirearm(input || {});
}

export { scrapeFirearmMain as scrapeFirearm };