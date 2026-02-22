// routes/auth.js

import { Router }      from 'express'
import jwt             from 'jsonwebtoken'
import fetch           from 'node-fetch'
import { tokenStore }  from '../config/tokenStore.js'
import { requireAuth } from '../middleware/auth.js'
import {
  setAdminEmail, lookupUser, getAllUsers, addUser,
  removeUser, updateUserRole, getUsersTabSheetId,
  refreshCache, isReady,
} from '../config/userStore.js'

const router = Router()

const BOOTSTRAP_ADMINS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

// ── POST /api/auth/verify ────────────────────────────────────────────
router.post('/verify', async (req, res) => {
  const { googleAccessToken } = req.body
  if (!googleAccessToken || typeof googleAccessToken !== 'string')
    return res.status(400).json({ error: 'googleAccessToken is required' })

  try {
    // 1. Verify with Google
    const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${googleAccessToken}` },
    })
    if (!gRes.ok) return res.status(401).json({ error: 'Invalid or expired Google token' })

    const profile = await gRes.json()
    const email   = (profile.email || '').toLowerCase().trim()
    if (!email) return res.status(401).json({ error: 'Could not retrieve email from Google' })

    // 2. Store token immediately so userStore can use it if this is an admin
    tokenStore.set(email, googleAccessToken)

    // 3. If bootstrap admin → register as the active admin token provider
    if (BOOTSTRAP_ADMINS.includes(email)) setAdminEmail(email)

    // 4. Look up user (bootstrap env check + sheet check)
    let found
    try {
      found = await lookupUser(email)
    } catch (e) {
      console.warn('[auth/verify] lookupUser error:', e.message)
      // Sheet unreachable — only let bootstrap admins through
      found = BOOTSTRAP_ADMINS.includes(email) ? { email, role: 'admin' } : null
    }

    if (!found) {
      tokenStore.delete(email)
      return res.status(403).json({ error: 'غير مصرح لك بالدخول. تواصل مع المدير لإضافتك.' })
    }

    // 5. If admin, make their token available for sheet user-management calls
    if (found.role === 'admin') setAdminEmail(email)

    // 6. Issue JWT
    const payload = {
      userId: email, name: profile.name || profile.given_name || email,
      email, picture: profile.picture || null, role: found.role,
    }
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '8h',
    })

    return res.json({ token, user: payload, tokenExpiresIn: process.env.JWT_EXPIRES_IN || '8h' })
  } catch (err) {
    console.error('[auth/verify]', err)
    return res.status(500).json({ error: 'Authentication failed. Please try again.' })
  }
})

// ── GET /api/auth/me ─────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user, googleExpiringSoon: tokenStore.isExpiringSoon(req.user.userId) })
})

// ── POST /api/auth/logout ────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  tokenStore.delete(req.user.userId)
  res.json({ success: true })
})

// ── POST /api/auth/refresh-google ───────────────────────────────────
router.post('/refresh-google', requireAuth, async (req, res) => {
  const { googleAccessToken } = req.body
  if (!googleAccessToken) return res.status(400).json({ error: 'googleAccessToken is required' })
  try {
    const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${googleAccessToken}` },
    })
    if (!gRes.ok) return res.status(401).json({ error: 'Invalid Google token' })
    const profile = await gRes.json()
    const email   = (profile.email || '').toLowerCase().trim()
    if (email !== req.user.userId) return res.status(403).json({ error: 'Token belongs to a different account' })
    tokenStore.set(email, googleAccessToken)
    if (req.user.role === 'admin') setAdminEmail(email)
    res.json({ success: true })
  } catch (err) {
    console.error('[auth/refresh-google]', err)
    res.status(500).json({ error: 'Failed to refresh token' })
  }
})

// ── GET /api/auth/users ──────────────────────────────────────────────
router.get('/users', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })

  // Ensure this admin's token is registered as the active one
  const myToken = tokenStore.get(req.user.userId)
  if (myToken) setAdminEmail(req.user.userId)

  // If no admin token available yet (cold start before any admin logged in)
  if (!isReady()) {
    const users = BOOTSTRAP_ADMINS.map(e => ({ email: e, role: 'admin', addedBy: 'env', addedAt: '' }))
    return res.json({ users, sheetId: null, sheetReady: false })
  }

  try {
    const [users, sheetId] = await Promise.all([getAllUsers(), getUsersTabSheetId()])
    res.json({ users, sheetId, sheetReady: true })
  } catch (err) {
    console.error('[auth/users GET]', err)
    const users = BOOTSTRAP_ADMINS.map(e => ({ email: e, role: 'admin', addedBy: 'env', addedAt: '' }))
    res.json({ users, sheetId: null, sheetReady: false, error: err.message })
  }
})

// ── POST /api/auth/users ─────────────────────────────────────────────
router.post('/users', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })

  const myToken = tokenStore.get(req.user.userId)
  if (myToken) setAdminEmail(req.user.userId)

  const { email, role } = req.body
  if (!email || !role) return res.status(400).json({ error: 'email and role are required' })
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be admin or user' })

  const e = email.toLowerCase().trim()
  if (BOOTSTRAP_ADMINS.includes(e))
    return res.status(400).json({ error: 'هذا المستخدم موجود بالفعل كمشرف في إعدادات الخادم' })

  try {
    const existing = await getAllUsers()
    if (existing.find(u => u.email === e))
      return res.status(409).json({ error: 'المستخدم مضاف بالفعل' })

    await addUser(e, role, req.user.email)
    const [users, sheetId] = await Promise.all([getAllUsers(), getUsersTabSheetId()])
    res.json({ success: true, users, sheetId, sheetReady: true })
  } catch (err) {
    console.error('[auth/users POST]', err)
    res.status(500).json({ error: err.message || 'Failed to add user' })
  }
})

// ── PUT /api/auth/users/:rowIndex ────────────────────────────────────
router.put('/users/:rowIndex', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const rowNum = parseInt(req.params.rowIndex)
  const { role } = req.body
  if (!role || !['admin', 'user'].includes(role)) return res.status(400).json({ error: 'Valid role required' })
  if (isNaN(rowNum) || rowNum < 2) return res.status(400).json({ error: 'Invalid rowIndex' })

  const myToken = tokenStore.get(req.user.userId)
  if (myToken) setAdminEmail(req.user.userId)

  try {
    await updateUserRole(rowNum, role)
    await refreshCache()
    const [users, sheetId] = await Promise.all([getAllUsers(), getUsersTabSheetId()])
    res.json({ success: true, users, sheetId, sheetReady: true })
  } catch (err) {
    console.error('[auth/users PUT]', err)
    res.status(500).json({ error: err.message || 'Failed to update role' })
  }
})

// ── DELETE /api/auth/users/:rowIndex ─────────────────────────────────
router.delete('/users/:rowIndex', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })
  const rowNum  = parseInt(req.params.rowIndex)
  const sheetId = parseInt(req.query.sheetId)
  if (isNaN(rowNum) || rowNum < 2) return res.status(400).json({ error: 'Invalid rowIndex' })
  if (isNaN(sheetId)) return res.status(400).json({ error: 'sheetId query param required' })

  const myToken = tokenStore.get(req.user.userId)
  if (myToken) setAdminEmail(req.user.userId)

  try {
    await removeUser(rowNum, sheetId)
    await refreshCache()
    const [users, sid] = await Promise.all([getAllUsers(), getUsersTabSheetId()])
    res.json({ success: true, users, sheetId: sid, sheetReady: true })
  } catch (err) {
    console.error('[auth/users DELETE]', err)
    res.status(500).json({ error: err.message || 'Failed to remove user' })
  }
})

export default router