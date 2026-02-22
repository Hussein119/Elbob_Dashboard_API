# ELBOB Backend — Express.js Secure API

## Setup

```bash
cd elbob-backend
npm install
cp .env.example .env
# Edit .env with your values
npm run dev
```

## Environment Variables

| Variable | Description |
|---|---|
| `PORT` | Port to listen on (default: 4000) |
| `JWT_SECRET` | Long random secret for signing JWTs |
| `JWT_EXPIRES_IN` | JWT lifetime e.g. `8h`, `24h` |
| `SHEET_ID` | Google Sheets spreadsheet ID |
| `ADMIN_EMAILS` | Comma-separated admin Gmail addresses |
| `ALLOWED_ORIGINS` | Comma-separated frontend URLs |

## Generate JWT_SECRET

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## Security features

- ✅ Google tokens stored server-side only — never sent to browser
- ✅ Role assignment is server-side — cannot be tampered with via DevTools
- ✅ JWT signed with secret — cannot be forged
- ✅ Rate limiting on all endpoints
- ✅ Helmet security headers
- ✅ CORS whitelist
- ✅ Automatic token expiry handling

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | /api/auth/verify | None | Exchange Google token for JWT |
| GET | /api/auth/me | JWT | Get current user |
| POST | /api/auth/logout | JWT | Clear session |
| POST | /api/auth/refresh-google | JWT | Update Google token |
| GET | /api/sheets/data | JWT | Get all sheet data |
| POST | /api/sheets/append | JWT | Add new row |
| PUT | /api/sheets/row/:id | JWT | Update row |
| DELETE | /api/sheets/row/:id | JWT | Delete row |

## Deployment (Railway / Render / VPS)

1. Push the `elbob-backend` folder to a repo
2. Set all env vars in your hosting dashboard
3. Set `ALLOWED_ORIGINS` to your Vercel frontend URL
4. Set `VITE_API_URL` in your Vercel frontend env to the backend URL
