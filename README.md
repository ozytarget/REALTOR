# A PRO HANDYMAN LLC Estimate Portal

A full-stack estimate portal for realtors. Upload inspector PDFs, capture
property information, and generate structured repair estimates.

## Run the project

1. Install dependencies:
   npm install
2. Start the server:
   npm start
3. Open the app in your browser at localhost:3000

## Notes

- Uploaded PDFs are stored in the uploads folder and are not tracked in git.
- The estimate engine uses placeholder Home Depot material averages and regional
  labor rate rules. Replace with real pricing data when ready.

## AI report analysis (optional)

1. Copy .env.example to .env
2. Set GEMINI_API_KEY
3. (Optional) Set GEMINI_MODEL

When configured, the server will use Gemini to read PDFs (including scanned
documents) and separate critical repairs from additional repairs.

## Pricing configuration

Update data/pricing.json to change material pricing, labor pricing, and regional
multipliers. This file is the source of fixed prices per state.

## PDF output

The estimate panel includes a "Download Estimate PDF" button that generates a
client-ready invoice-style PDF.
