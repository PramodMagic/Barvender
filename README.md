# Label Studio
- `index.html`  : landing page
- `app.html`    : Excel label tool (/app) + cloud storage sync
- `barcode.html`: real-time barcode (/barcode)
- `api/master.js`: serverless function that saves/compares master data in Upstash Redis
- `vercel.json`

Env vars (Vercel project): KV_REST_API_URL and KV_REST_API_TOKEN (added by the Upstash integration).
Optional: APP_PASSWORD (protects /api/master), STORAGE_LIMIT_MB (default 256).
Deploy: push all files (including the api folder) to GitHub `main`; Vercel redeploys automatically.
