// server.js — ELBOB Secure Backend
import 'dotenv/config'
import express        from 'express'
import helmet         from 'helmet'
import cors           from 'cors'
import rateLimit      from 'express-rate-limit'
import authRoutes     from '../routes/auth.js'
import sheetsRoutes   from '../routes/sheets.js'

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

// ── Security headers (helmet) ───────────────────────────────────────
app.use(helmet())

// ── CORS ────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map(o => o.trim())

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g. mobile apps, curl)
    if (!origin) return callback(null, true)
    if (allowedOrigins.includes(origin)) return callback(null, true)
    callback(new Error(`CORS: origin ${origin} not allowed`))
  },
  methods:            ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders:     ['Content-Type', 'Authorization'],
  credentials:        true,
}))

// ── Body parser ─────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }))

// ── Rate limiting ────────────────────────────────────────────────────
// Auth endpoints: strict (prevent brute-force / token stuffing)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  max:      100,               // 20 requests per window
  message:  { error: 'Too many auth requests. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders:   false,
})

// Sheets endpoints: generous (normal usage)
const sheetsLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max:      60,               // 60 requests per minute
  message:  { error: 'Too many requests. Please slow down.' },
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

// ── 404 handler ──────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` })
})

// ── Global error handler ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[server] Unhandled error:', err.message)
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message })
  }
  res.status(500).json({ error: 'Internal server error' })
})

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  ELBOB Backend running on http://localhost:${PORT}`)
  console.log(`   Admin emails: ${process.env.ADMIN_EMAILS}`)
  console.log(`   Allowed origins: ${allowedOrigins.join(', ')}`)
  console.log(`   JWT expires: ${process.env.JWT_EXPIRES_IN || '8h'}\n`)
})
