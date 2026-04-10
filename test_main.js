import { scrapeFirearm } from './main.js';

const inputRaw = {
  "quickQuoteRequest": {
    "appraisalID": "A0001",
    "site": null,
    "submittedAt": "2026-02-17T19:36:13.344Z",
    "department": "Firearms",
    "location": {
      "locationId": "001"
    },
    "firearm": {
      "firearmType": "SHOTGUN",
      "serial": "SN44397853",
      "brand": "BERETTA",
      "model": "DT10 TRIDENT SPORTING",
      "caliber": "12GA"
    }
  }
};

const firearmInput = inputRaw.quickQuoteRequest.firearm;

console.log('Testing main.js with input:', firearmInput);

scrapeFirearm(firearmInput)
  .then(res => {
    console.log('--- TEST RESULTS ---');
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  })
  .catch(err => {
    console.error('Error during scrape:', err);
    process.exit(1);
  });
