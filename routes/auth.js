// routes/auth.js
//
// POST /api/auth/verify   — receives Google access_token from frontend,
//                           verifies it with Google, assigns role, returns our JWT
// GET  /api/auth/me       — returns current user info from JWT
// POST /api/auth/logout   — deletes server-side Google token
// POST /api/auth/refresh  — tells client whether Google re-auth is needed

import { Router }    from 'express'
import jwt           from 'jsonwebtoken'
import fetch         from 'node-fetch'
import { tokenStore } from '../config/tokenStore.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

// Admin emails (server-side only — never exposed to client)
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.trim().toLowerCase())
  .filter(Boolean)

// ── POST /api/auth/verify ───────────────────────────────────────────
// Frontend sends: { googleAccessToken }
// We verify it with Google, assign role, store google token server-side,
// return our own signed JWT (contains NO google token).
router.post('/verify', async (req, res) => {
  const { googleAccessToken } = req.body

  if (!googleAccessToken || typeof googleAccessToken !== 'string') {
    return res.status(400).json({ error: 'googleAccessToken is required' })
  }

  try {
    // 1. Verify token with Google and fetch profile
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${googleAccessToken}` },
    })

    if (!googleRes.ok) {
      return res.status(401).json({ error: 'Invalid or expired Google token' })
    }

    const profile = await googleRes.json()
    const email   = (profile.email || '').toLowerCase().trim()

    if (!email) {
      return res.status(401).json({ error: 'Could not retrieve email from Google' })
    }

    // 2. Assign role server-side based on email
    const role = ADMIN_EMAILS.includes(email) ? 'admin' : 'user'

    // 3. Store Google token server-side — NEVER sent to the client
    tokenStore.set(email, googleAccessToken)

    // 4. Issue our own short-lived JWT
    //    Payload contains only safe, non-sensitive user info
    const jwtPayload = {
      userId:  email,
      name:    profile.name || profile.given_name || email,
      email,
      picture: profile.picture || null,
      role,
    }

    const token = jwt.sign(jwtPayload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    })

    // 5. Return JWT + user info (no google token)
    return res.json({
      token,
      user: jwtPayload,
      tokenExpiresIn: process.env.JWT_EXPIRES_IN || '8h',
    })

  } catch (err) {
    console.error('[auth/verify] Error:', err)
    return res.status(500).json({ error: 'Authentication failed. Please try again.' })
  }
})

// ── GET /api/auth/me ────────────────────────────────────────────────
// Returns current user from JWT. Also reports if Google token is expiring soon.
router.get('/me', requireAuth, (req, res) => {
  const googleExpiringSoon = tokenStore.isExpiringSoon(req.user.userId)
  res.json({
    user: req.user,
    googleExpiringSoon,   // frontend can use this to prompt re-auth
  })
})

// ── POST /api/auth/logout ───────────────────────────────────────────
// Deletes the server-side Google token.
// The client should also discard its JWT.
router.post('/logout', requireAuth, (req, res) => {
  tokenStore.delete(req.user.userId)
  res.json({ success: true })
})

// ── POST /api/auth/refresh-google ──────────────────────────────────
// Called by the frontend when Google token has expired.
// Frontend sends a new googleAccessToken (from a silent re-auth).
router.post('/refresh-google', requireAuth, async (req, res) => {
  const { googleAccessToken } = req.body
  if (!googleAccessToken) {
    return res.status(400).json({ error: 'googleAccessToken is required' })
  }

  try {
    // Verify the new token belongs to the same user
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${googleAccessToken}` },
    })

    if (!googleRes.ok) {
      return res.status(401).json({ error: 'Invalid Google token' })
    }

    const profile = await googleRes.json()
    const email   = (profile.email || '').toLowerCase().trim()

    // Must match the JWT user
    if (email !== req.user.userId) {
      return res.status(403).json({ error: 'Token belongs to a different account' })
    }

    // Update server-side store
    tokenStore.set(email, googleAccessToken)

    res.json({ success: true, message: 'Google token refreshed successfully' })
  } catch (err) {
    console.error('[auth/refresh-google] Error:', err)
    return res.status(500).json({ error: 'Failed to refresh token' })
  }
})

export default router
