// config/serviceAccount.js
//
// Authenticates as a Google Service Account using a JSON key stored in the
// GOOGLE_SERVICE_ACCOUNT_KEY env var (the full JSON stringified).
//
// This gives the server a permanent, stable Google token that never expires
// mid-session and doesn't depend on any user being logged in.
//
// HOW TO SET UP (one-time):
//  1. Go to Google Cloud Console → IAM & Admin → Service Accounts
//  2. Create a service account (e.g. "elbob-sheet-manager")
//  3. Create a JSON key → download it
//  4. Share your Google Sheet with the service account email (Editor access)
//  5. Set env var: GOOGLE_SERVICE_ACCOUNT_KEY=<paste entire JSON content>
//
// The token is cached and auto-refreshed 5 minutes before expiry.

import { createSign } from 'crypto'

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets']

let cachedToken    = null
let tokenExpiresAt = 0

function getKey() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!raw) return null
  try { return JSON.parse(raw) } catch { return null }
}

/** Create a signed JWT for the service account and exchange it for an access token. */
async function fetchNewToken(key) {
  const now    = Math.floor(Date.now() / 1000)
  const expiry = now + 3600

  // Build the JWT header + payload
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({
    iss:   key.client_email,
    scope: SCOPES.join(' '),
    aud:   'https://oauth2.googleapis.com/token',
    exp:   expiry,
    iat:   now,
  })).toString('base64url')

  const unsigned = `${header}.${payload}`

  // Sign with the private key
  const sign      = createSign('RSA-SHA256')
  sign.update(unsigned)
  const signature = sign.sign(key.private_key, 'base64url')
  const signedJwt = `${unsigned}.${signature}`

  // Exchange for an access token
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  signedJwt,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`Service account token error: ${err.error_description || res.status}`)
  }

  const data = await res.json()
  return { token: data.access_token, expiresAt: now + data.expires_in - 300 } // refresh 5 min early
}

/**
 * Get a valid service account access token.
 * Returns null if GOOGLE_SERVICE_ACCOUNT_KEY is not configured.
 */
export async function getServiceToken() {
  const key = getKey()
  if (!key) return null

  const now = Math.floor(Date.now() / 1000)
  if (cachedToken && now < tokenExpiresAt) return cachedToken

  const { token, expiresAt } = await fetchNewToken(key)
  cachedToken    = token
  tokenExpiresAt = expiresAt
  return token
}

/** Check if the service account is configured. */
export function isServiceAccountConfigured() {
  return !!process.env.GOOGLE_SERVICE_ACCOUNT_KEY
}

/** Return the service account email (for display in setup instructions). */
export function getServiceAccountEmail() {
  const key = getKey()
  return key?.client_email || null
}