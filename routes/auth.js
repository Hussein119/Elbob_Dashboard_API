// routes/auth.js

import { Router }      from 'express'
import jwt             from 'jsonwebtoken'
import fetch           from 'node-fetch'
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

    // 2. If bootstrap admin → register as the active admin token provider
    if (BOOTSTRAP_ADMINS.includes(email)) setAdminEmail(email)

    // 3. Look up user (bootstrap env check + sheet check)
    let found
    try {
      found = await lookupUser(email)
    } catch (e) {
      console.warn('[auth/verify] lookupUser error:', e.message)
      // Sheet unreachable — only let bootstrap admins through
      found = BOOTSTRAP_ADMINS.includes(email) ? { email, role: 'admin' } : null
    }

    if (!found) {
      return res.status(403).json({ error: 'غير مصرح لك بالدخول. تواصل مع المدير لإضافتك.' })
    }

    // 4. If admin, register their email
    if (found.role === 'admin') setAdminEmail(email)

    // 5. Issue JWT — identity only, no Google token embedded
    const payload = {
      userId: email,
      name:   profile.name || profile.given_name || email,
      email,
      picture: profile.picture || null,
      role:   found.role,
    }
    const token = jwt.sign(payload, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN || '1y',
    })

    return res.json({ token, user: payload })
  } catch (err) {
    console.error('[auth/verify]', err)
    return res.status(500).json({ error: 'Authentication failed. Please try again.' })
  }
})

// ── GET /api/auth/me ─────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user })
})

// ── POST /api/auth/logout ────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  res.json({ success: true })
})

// ── GET /api/auth/users ──────────────────────────────────────────────
router.get('/users', requireAuth, async (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' })

  // If no token available yet (cold start, no service account)
  if (!(await isReady())) {
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

  const { email, role } = req.body
  if (!email || !role) return res.status(400).json({ error: 'email and role are required' })
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be admin or user' })

  const e = email.toLowerCase().trim()
  if (BOOTSTRAP_ADMINS.includes(e))
    return res.status(400).json({ error: 'هذا المستخدم موجود بالفعل كمشرف في إعدادات الخادم' })

  const BOOTSTRAP_USERS = (process.env.USER_EMAILS || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  if (BOOTSTRAP_USERS.includes(e))
    return res.status(400).json({ error: 'هذا المستخدم موجود بالفعل كمستخدم في إعدادات الخادم' })

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