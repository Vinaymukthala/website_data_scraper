import puppeteerExtra from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import * as provider from "./scripts/providers/gunsinternational.js";

puppeteerExtra.use(StealthPlugin());

(async () => {
    const browser = await puppeteerExtra.launch({ headless: true }); // Set false so you can see it work
    const page = await browser.newPage();

    try {
        const results = await provider.scrape({
            page,
            query: "Sig Sauer P320 9mm",
            model: "P320",
            firearmType: "HANDGUN"
        });
        console.log(JSON.stringify(results, null, 2));
    } finally {
        await browser.close();
    }
})();
