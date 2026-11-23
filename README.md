# Label Studio
- `index.html` landing page, `app.html` Excel labels (/app), `barcode.html` real-time barcode (/barcode)
- `api/master.js` serverless function: user accounts + each user's private saved data in Upstash Redis

Env vars (Vercel project): KV_REST_API_URL, KV_REST_API_TOKEN (added by the Upstash integration).
Optional: SIGNUP_CODE (invite code needed to create an account), USER_LIMIT_MB (per user, default 50), STORAGE_LIMIT_MB (all users, default 256).
Every user signs in and sees only his own data. Passwords are stored hashed (scrypt); sessions last 30 days.
Admin: set ADMIN_USERS=yourname (comma separated for more). Register that username, sign in and an 'Admin panel' button appears: list users with record counts and sizes, clear a user's data, reset a password, delete a user. Admins never see the records themselves.
