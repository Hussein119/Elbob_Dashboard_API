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

- **Layers**: `routes/` (paths + middleware) → `controllers/` (req/res) → `services/` (logic + Google calls). Request shapes are zod schemas in `schemas/`, applied with `middleware/validate.js`; handlers read `req.valid.*`.
- **Tab access**: `/api/sheets/*` only touches tabs listed in `config/tabs.js` (plus the first tab). Admin-only tabs return 403 for users; the users tab is never reachable there.
- **Row indexing**: 1-based. Row 1 = headers; row 2+ = data. `:rowIndex` params in routes follow this convention.
- **Row IDs** (`services/rowIds.js`): column Z of every data tab holds a server-managed unique ID (header `ID`). Reads backfill missing/duplicate IDs; appends add one; client values in column Z are always ignored. Users tab excluded (identified by email).
- **Stale-row guard**: row PUT / DELETE / batch-rows / batch-delete accept `expected` (the row as the client last read it, including its ID). The server finds the row by that ID wherever it moved, then compares content; if the record is gone or changed it returns 409 `{ code: 'STALE_ROWS' }` and writes nothing.
- **Delete endpoint contract**: `DELETE /api/sheets/row/:rowIndex` requires `?sheetId=<numeric>`.
- **Users**: `/api/auth/users/:email` (PUT role, DELETE) — users are identified by email, never by row number.
- **Google calls**: always via `services/googleSheets.js` (`googleFetch` retries 429/5xx; tab metadata cached 5 min; text cells starting with `=`/`@`/`+`/`-` are stored as text).
- **Role checks**: `requireAuth` re-reads the user's role from the users tab (60 s cache) on every request, so removals and role changes apply immediately.
- **Google token expiry**: Tokens expire ~60 min. Frontend must handle `{ code: 'GOOGLE_TOKEN_EXPIRED' }` responses and re-login, or rely on service account (no expiry).
- **Error format**: throw `HttpError(status, message, code)` from `middleware/errors.js`; the central handler returns `{ success: false, message, code? }`.

## Pitfalls

- **Sheet tab name is hardcoded**: `"المستخدمون"` in `config/userStore.js`. Renaming it in Google Sheets breaks user management entirely.
- **Service account must have sheet access**: After deploying, share the spreadsheet with the service account email (`getServiceAccountEmail()`).
- **Rate limiting is per-process**: On Vercel multi-instance deployments, in-memory rate limits are not global. Sheets routes are keyed per user (`trust proxy` is on).
- **`npm start` does not load `.env`**: Use `node --env-file=.env api/index.js` for local production testing.

## Project Structure

```
api/index.js          # Server entry — env validation, middleware, route mounting
config/
  serviceAccount.js   # Google service account JWT + token exchange + caching
  tokenStore.js       # AES-256-GCM encryption of Google tokens inside JWTs
  userStore.js        # Sheet-backed user/role CRUD with 60 s cache
  tabs.js             # Allowed tabs + required role per tab
middleware/
  auth.js             # requireAuth (JWT + live role check) + requireAdmin
  errors.js           # HttpError, asyncHandler, notFound, errorHandler
  validate.js         # zod validation → req.valid
  jsonBody.js         # Vercel PUT/DELETE body fallback
schemas/sheets.js     # zod request schemas for /api/sheets
controllers/sheetsController.js
services/
  googleSheets.js     # Google API client: retry, metadata cache, sanitizing, stale-row check
  sheetRecords.js     # Tab-access-checked row operations
routes/auth.js        # /api/auth/* — verify, me, logout, user management (admin)
routes/sheets.js      # /api/sheets/* — paths + middleware only
```

See [README.md](../README.md) for API endpoint reference and deployment steps.
