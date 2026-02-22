// config/tokenStore.js
//
// Stores Google access tokens SERVER-SIDE only.
//
// ── Why the old Map() approach broke on Vercel ───────────────────────
// Vercel serverless functions are stateless: every cold start (which can
// happen between any two requests) wipes the in-process Map, destroying
// all stored Google tokens. Users would see "Google session expired"
// moments after logging in, with no way to recover short of re-logging.
//
// ── The fix: encrypted token inside the JWT ───────────────────────────
// Instead of keeping the Google token in server memory we encrypt it with
// AES-256-GCM (Node built-in crypto, zero new dependencies) and embed it
// in the JWT that the client already carries. On every request:
//   1. requireAuth() verifies the JWT → decodes payload
//   2. getGoogleToken() calls tokenStore.get(userId, req) → decrypts from req.user
//   3. No server state needed at all — survives any cold start
//
// The Google token is encrypted before it enters the JWT and is never
// readable by the client (they see a base64 blob, not the token).
// AES-256-GCM provides both confidentiality and tamper detection.
//
// ── Public API ────────────────────────────────────────────────────────
// tokenStore.encrypt(googleToken) → encryptedBlob   (called at login)
// tokenStore.get(userId, req)     → googleToken | null  (called per-request)
// tokenStore.isExpiringSoon(...)  → boolean
//
// The legacy .set() / .delete() / .has() stubs are kept so no other
// files need to change.

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto'

// ── Derive a 32-byte AES key from JWT_SECRET ─────────────────────────
// Reuses the existing env var — no new secret needed.
// SHA-256 turns any-length string into exactly 32 bytes for AES-256.
function getKey() {
  return createHash('sha256')
    .update(process.env.JWT_SECRET || 'fallback-secret-change-me')
    .digest()
}

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES  = 12  // 96-bit IV — recommended for GCM
const TAG_BYTES = 16  // GCM auth tag

// ── Encryption helpers ────────────────────────────────────────────────

/**
 * Encrypt a Google access token.
 * Returns a compact base64url string: iv(12) + authTag(16) + ciphertext
 */
function encryptToken(plaintext) {
  const iv     = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, getKey(), iv)
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag    = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString('base64url')
}

/**
 * Decrypt a blob produced by encryptToken().
 * Returns the original Google token string, or null on any failure.
 */
function decryptToken(blob) {
  try {
    const buf        = Buffer.from(blob, 'base64url')
    const iv         = buf.subarray(0, IV_BYTES)
    const tag        = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES)
    const ciphertext = buf.subarray(IV_BYTES + TAG_BYTES)
    const decipher   = createDecipheriv(ALGORITHM, getKey(), iv)
    decipher.setAuthTag(tag)
    return decipher.update(ciphertext) + decipher.final('utf8')
  } catch {
    return null  // tampered, malformed, or wrong key
  }
}

// Google tokens live 60 min; we treat them as valid for 55 to avoid
// using a token in the last 5 minutes of its life.
const GOOGLE_TOKEN_TTL_MS = 55 * 60 * 1000

// ── Fallback in-memory store ──────────────────────────────────────────
// Used only as a best-effort cache within the same warm instance.
// userStore.js needs the admin token between requests; this helps there.
// It is NOT relied on for correctness across cold starts.
const _mem = new Map()

// ── Public tokenStore object ──────────────────────────────────────────
export const tokenStore = {

  /**
   * Encrypt a raw Google access token for embedding in the JWT payload.
   * Call this in auth.js right before jwt.sign().
   */
  encrypt(googleToken) {
    return encryptToken(googleToken)
  },

  /**
   * Retrieve and decrypt the Google token for the current request.
   *
   * PRIMARY: decrypts req.user.encryptedGoogleToken that came from the JWT.
   *   Works regardless of cold starts — the client always carries the blob.
   *
   * FALLBACK: in-memory cache for the same warm instance.
   *   Covers admin token access in userStore.js between two quick requests.
   */
  get(userId, req) {
    // Primary path — decrypt from JWT payload
    const blob = req?.user?.encryptedGoogleToken
    if (blob) {
      const token = decryptToken(blob)
      if (token) {
        // Refresh in-memory cache opportunistically
        _mem.set(userId, { googleToken: token, expiresAt: Date.now() + GOOGLE_TOKEN_TTL_MS })
        return token
      }
    }

    // Fallback — same warm instance
    const entry = _mem.get(userId)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) { _mem.delete(userId); return null }
    return entry.googleToken
  },

  /** Keep in-memory cache warm. Called by auth.js after verifying Google token. */
  set(userId, googleToken) {
    _mem.set(userId, { googleToken, expiresAt: Date.now() + GOOGLE_TOKEN_TTL_MS })
  },

  has(userId) { return this.get(userId) !== null },

  delete(userId) { _mem.delete(userId) },

  /**
   * True if the token is within 5 minutes of expiry.
   * Uses the googleTokenExpiresAt timestamp embedded in the JWT when available.
   */
  isExpiringSoon(userId, req) {
    const exp = req?.user?.googleTokenExpiresAt
    if (exp) return (exp - Date.now()) < 5 * 60 * 1000
    const entry = _mem.get(userId)
    if (!entry) return true
    return (entry.expiresAt - Date.now()) < 5 * 60 * 1000
  },
}