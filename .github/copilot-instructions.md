# ELBOB Backend — Copilot Instructions

## Build & Dev

```bash
npm run dev          # Watch mode, auto-loads .env
npm start            # Production (env vars must be set externally)
```

No test suite is configured. There is no `npm test` command.

Generate a JWT secret: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`

## Architecture

- **Runtime**: Node.js (ESM — `"type": "module"` in package.json). Always use `import`/`export`, never `require()`.
- **Entry**: `api/index.js` — validates env vars at startup, mounts rate limiters, CORS, and routes.
- **Auth flow**: Google OAuth token → `/api/auth/verify` → JWT containing AES-256-GCM encrypted Google token → client stores JWT only; raw Google token never leaves the server.
- **User store**: `config/userStore.js` reads/writes the Google Sheet tab `"المستخدمون"` (Arabic; do not rename). Roles: `admin` | `user`. Cached 60 s.
- **Token sources**: Service account (primary, permanent) → admin OAuth token from JWT (fallback). See `config/serviceAccount.js` and `config/tokenStore.js`.
- **Deployment target**: Vercel serverless (`vercel.json`). All state must be stateless — no in-process Maps survive cold starts (token encryption in JWT solves this).

## Required Environment Variables

| Variable | Constraint |
|---|---|
| `JWT_SECRET` | ≥ 32 chars; server crashes on startup if missing/short |
| `SHEET_ID` | Google Sheets spreadsheet ID |
| `ADMIN_EMAILS` | Comma-separated Gmail addresses (case-insensitive, trimmed) |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Full service account JSON stringified; optional but strongly recommended |
| `ALLOWED_ORIGINS` | Comma-separated frontend URLs for CORS whitelist |

## Key Conventions

- **Row indexing**: 1-based. Row 1 = headers; row 2+ = data. `:rowIndex` params in routes follow this convention.
- **Delete endpoint contract**: `DELETE` routes require `?sheetId=<numeric>` query param for the Sheets API `batchUpdate`.
- **Google token expiry**: Tokens expire ~60 min. Frontend must handle `{ code: 'GOOGLE_TOKEN_EXPIRED' }` responses and re-login, or rely on service account (no expiry).
- **Column letter helper**: `colIndexToLetter()` in `routes/sheets.js` converts 0-based array index → A/B/Z/AA etc.
- **Error format**: All error responses return `{ error: "..." }` JSON. Google-specific failures include `{ error: "...", code: 'GOOGLE_TOKEN_EXPIRED' }`.

## Pitfalls

- **Sheet tab name is hardcoded**: `"المستخدمون"` in `config/userStore.js`. Renaming it in Google Sheets breaks user management entirely.
- **Service account must have sheet access**: After deploying, share the spreadsheet with the service account email (`getServiceAccountEmail()`).
- **Rate limiting is per-process**: On Vercel multi-instance deployments, in-memory rate limits are not global.
- **`npm start` does not load `.env`**: Use `node --env-file=.env api/index.js` for local production testing.
- **Role is baked into JWT at login**: Changing a user's role in the sheet takes effect only at next login (JWT expiry).

## Project Structure

```
api/index.js          # Server entry — env validation, middleware, route mounting
config/
  serviceAccount.js   # Google service account JWT + token exchange + caching
  tokenStore.js       # AES-256-GCM encryption of Google tokens inside JWTs
  userStore.js        # Sheet-backed user/role CRUD with 60 s cache
middleware/auth.js    # requireAuth (JWT) + requireAdmin (role check)
routes/auth.js        # /api/auth/* — verify, me, logout, user management (admin)
routes/sheets.js      # /api/sheets/* — CRUD proxy to Google Sheets API
```

See [README.md](../README.md) for API endpoint reference and deployment steps.
