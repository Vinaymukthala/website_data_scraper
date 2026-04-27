import express from 'express';
import { scrapeFirearm } from './scraperService.js';

const app = express();
const PORT = 1717;

// Middleware to parse JSON bodies
app.use(express.json());

app.post('/bp-fallback/scrape', async (req, res) => {
  try {
    const input = req.body;

    // Validate that required fields exist
    if (!input || !input.brand || !input.model) {
      return res.status(400).json({
        error: "Missing required fields. Please provide at least 'brand' and 'model'."
      });
    }

    console.log(`\n[API] Received scrape request for: ${input.brand} ${input.model} ${input.caliber || ''}`);

    // Call the scraper service
    const result = await scrapeFirearm(input);

    // Return the successfully scraped payload
    res.status(200).json(result);
  } catch (error) {
    console.error(`[API] Error during scrape: ${error.message}`);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message
    });
  }
});

// Basic health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'Scraper API is running' });
});

app.listen(PORT, () => {
  console.log(`\n=========================================`);
  console.log(`🚀 Scraper API is running on port ${PORT}`);
  console.log(`=========================================`);
  console.log(`Hit the endpoint using POST http://localhost:${PORT}/bp-fallback/scrape`);
  console.log(`Example JSON Body:`);
  console.log(`{`);
  console.log(`  "firearmType": "HANDGUN",`);
  console.log(`  "brand": "Colt",`);
  console.log(`  "model": "Anaconda",`);
  console.log(`  "caliber": ".45"`);
  console.log(`}`);
});
