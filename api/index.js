// server.js — ELBOB Secure Backend
import 'dotenv/config'
import express        from 'express'
import helmet         from 'helmet'
import cors           from 'cors'
import rateLimit      from 'express-rate-limit'
import jwt            from 'jsonwebtoken'
import authRoutes     from '../routes/auth.js'
import sheetsRoutes   from '../routes/sheets.js'
import { notFound, errorHandler } from '../middleware/errors.js'

// ── Validate required env vars ──────────────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'SHEET_ID', 'ADMIN_EMAILS']
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`❌  Missing required env var: ${key}`)
    process.exit(1)
  }
}

if (process.env.JWT_SECRET.length < 32) {
  console.error('❌  JWT_SECRET must be at least 32 characters long')
  process.exit(1)
}

const app  = express()
const PORT = process.env.PORT || 4000

// Behind Vercel's proxy: use the client IP from X-Forwarded-For, not the proxy's
app.set('trust proxy', 1)

// ── Security headers (helmet) ───────────────────────────────────────
app.use(helmet())

// ── CORS ────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim())

app.use(cors({
  origin: (origin, callback) => {
    // Requests without an Origin (curl, health checks) still need a valid JWT on every data route
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error(`CORS: origin ${origin} not allowed`))
  },
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}))

// ── Body parser ─────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }))

// ── Rate limiting ────────────────────────────────────────────────────
// Signed-in requests are limited per user, so colleagues in the same shop
// (same public IP) don't use up each other's quota.
function rateLimitKey(req) {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) {
    try {
      return `user:${jwt.verify(header.slice(7), process.env.JWT_SECRET).userId}`
    } catch { /* invalid token — fall back to IP */ }
  }
  return `ip:${req.ip}`
}

// Auth endpoints: strict (prevent brute-force / token stuffing)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max:      100,              // 100 requests per window
  message:  { success: false, message: 'Too many auth requests. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
})

// Sheets endpoints: generous (one invoice save is several requests)
const sheetsLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max:      120,              // 120 requests per minute per user
  keyGenerator: rateLimitKey,
  message:  { success: false, message: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders:   false,
})

// ── Routes ───────────────────────────────────────────────────────────
app.use('/api/auth',   authLimiter,   authRoutes)
app.use('/api/sheets', sheetsLimiter, sheetsRoutes)

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', (_, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

app.use(notFound)
app.use(errorHandler)

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  ELBOB Backend running on http://localhost:${PORT}`)
  console.log(`   Allowed origins: ${allowedOrigins.join(', ')}`)
  console.log(`   JWT expires: ${process.env.JWT_EXPIRES_IN || '1y'}\n`)
})
