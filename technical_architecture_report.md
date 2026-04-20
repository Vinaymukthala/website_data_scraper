# Firearm Pricing Aggregator: Technical Architecture Report

## 1. System Overview

The application is a high-performance, concurrent Node.js data ingestion service designed to scrape real-time pricing, availability, and historical market data for firearms. The scraper aggregates data from seven major industry platforms simultaneously, normalizing volatile HTML structures into a standardized, machine-readable JSON schema.

**Supported Providers:**
- GunsInternational
- GunBroker
- BudsGunShop
- Palmetto State Armory (PSA)
- TrueGunValue
- CollectorFirearms
- SimpsonLtd

---

## 2. Core Architecture Pattern

The system follows a **Modular Provider Pattern** orchestrated by a centralized service (`scraperService.js`). 

- **Unified Orchestrator:** The `scraperService.js` receives the user query (e.g., `GLOCK 19 9MM`), boots up the browser environments, and explicitly fires off each registered provider module via `Promise.allSettled()`. This guarantees that if one targeted site is temporarily down or undergoes structural changes, the other six sites successfully return data without failing the master process.
- **Stateless Providers:** Each website has a dedicated, isolated JavaScript module (e.g., `budsgunshop.js`, `gunbroker.js`). These scripts handle the unique DOM structures, pagination, and quirks unique to their target domain.
- **Normalization Engine:** All provider returns are normalized into a unified schema containing: `sourceName`, `condition`, `pageUrl`, `gunName`, `brand`, `caliber`, and parsed numeric `price`.

---

## 3. Web Fetching & Anti-Bot Strategy

Modern retail and auction platforms are protected by advanced Web Application Firewalls (WAFs), specifically enterprise-tier **Cloudflare Turnstile** and bot-fingerprinting systems. To successfully defeat this, the scraper implements a **Dual Fetch Strategy**:

### A. Headless Browser Injection (Puppeteer Extra) 
*Targeting: TrueGunValue, GunsInternational, CollectorFirearms, SimpsonLtd*

For standard sites, the system boots a hidden Chromium instance equipped with `puppeteer-extra-plugin-stealth` to scrub automated navigator flags.
*   **Performance Optimization (Request Interception):** To minimize latency, the browser intercepts and `aborts()` rendering requests for heavy asset files (Images, CSS stylesheets, Fonts, and Media player scripts). This strips the page down to pure HTML/JS data payloads, immediately reducing average page execution times from ~8 seconds to **1.5 seconds**.

### B. Geo-Residential Proxy Bypassing
*Targeting: TrueGunValue, GunsInternational, CollectorFirearms, SimpsonLtd* (Non-Cloudflare sites)

For standard domains, the scraper uses local optimized headless browsers. However, three of our highest-priority targets—**BudsGunShop, GunBroker, and Palmetto State Armory**—utilize Enterprise-tier security.

---

## 4. Why We Use ScraperAPI

Scraping major firearm retailers presents a unique security challenge. Top industry platforms employ **Cloudflare Turnstile** and aggressive bot-management Enterprise solutions.

**The Problem with Standard Scraping Engines:**
If an automated system (such as standard Puppeteer, Playwright, or Crawl4AI) attempts to scrape these domains using a typical datacenter IP address (e.g., AWS, DigitalOcean), Cloudflare immediately detects the non-human browser fingerprint. The crawler is met with a permanent `HTTP 403 Forbidden` response and an endless "Just a moment..." CAPTCHA loop, completely blocking data acquisition.

**The ScraperAPI Solution:**
To bypass this enterprise defense, we integrated ScraperAPI exclusively for our highest-security targets. 
1. **Millions of Residential Proxies:** Instead of hitting the retailer from a blocked datacenter IP, ScraperAPI routes our HTTP request through a randomized US-based mobile phone or home wi-fi IP address.
2. **Automated CAPTCHA Solving & Fingerprint Spoofing:** The API handles the mathematical Turnstile challenges directly on their servers, avoiding heavy processor loads on our end.
3. **No Heavy Browser Overhead:** Because ScraperAPI successfully bypasses the bot-check on their end, our Node.js code receives the fully verified, clean HTML payload natively. This allows us to parse the DOM identically to standard sites, skipping the 10-15 second local browser rendering cost.

Ultimately, ScraperAPI is the only reliable method to achieve 100% success-rate ingestion against Cloudflare Enterprise without triggering automated IP bans.

---

## 5. Advanced Data Filtering

A persistent challenge in raw firearm scraping is "Accessory Pollution"—searching for a "Glock 19" returns pages littered with $15 magazines, holsters, standalone threaded barrels, and compensators instead of the actual $500 firearm. 

The application utilizes a multi-layer heuristic filter engine to clean the data:

1. **Brand & Accessory Regex Matching:** Evaluates every individual listing title against negative-lookup RegEx patterns identifying aftermarket accessory brands (e.g., *Magpul*, *KCI*, *ETS*) and distinct parts (e.g., *Sling*, *Magazine*, *Barrel*, *Holster*, *Muzzle*).
2. **Context-Aware Exemptions:** The Regex engine is smart enough to understand that a "4 Inch Barrel" description inside a listing implies it's a firearm, while starting a title strictly with the word "BARREL" usually identifies an accessory part. 
3. **Relevance Scoring:** Executes dynamic keyword intersection logic (`matchCount()`) to ensure titles natively contain the required query logic (model & keywords) before allowing the item to enter the pipeline.

---

## 5. Performance Metrics 

By executing the decoupled provider modules in massive asynchronous concurrency natively within Node.js and heavily leveraging resource-blocking and ScraperAPI endpoints for speed, the scraper executes the search query, evaluates thousands of DOM nodes, normalizes output, and compiles the response payload uniformly in **under 5 to 9 seconds total**.
