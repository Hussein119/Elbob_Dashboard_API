// routes/auth.js

import { Router }       from 'express'
import jwt              from 'jsonwebtoken'
import { z }            from 'zod'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { ensureJsonBody } from '../middleware/jsonBody.js'
import { validate }     from '../middleware/validate.js'
import { HttpError, asyncHandler } from '../middleware/errors.js'
import { tokenStore }   from '../config/tokenStore.js'
import {
  setAdminEmail, lookupUser, getAllUsers, addUser,
  removeUser, updateUserRole, isReady,
} from '../config/userStore.js'

const router = Router()

const BOOTSTRAP_ADMINS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

// Parsed once at module load so POST /users doesn't re-parse on every request.
const BOOTSTRAP_USERS = (process.env.USER_EMAILS || '')
  .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)

const email = z.string().trim().toLowerCase().email().max(254)
const role  = z.enum(['admin', 'user'])

const verifyBody   = z.object({ googleAccessToken: z.string().min(1).max(4096) })
const addUserBody  = z.object({ email, role })
const roleBody     = z.object({ role })
const emailParams  = z.object({ email })

const bootstrapOnlyUsers = () =>
  BOOTSTRAP_ADMINS.map(e => ({ email: e, role: 'admin', addedBy: 'env', addedAt: '' }))

router.use(ensureJsonBody)

// ── POST /api/auth/verify ────────────────────────────────────────────
router.post('/verify', validate({ body: verifyBody }), asyncHandler(async (req, res) => {
  const { googleAccessToken } = req.valid.body

  // 1. Verify with Google
  const gRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${googleAccessToken}` },
  })
  if (!gRes.ok) throw new HttpError(401, 'Invalid or expired Google token', 'INVALID_GOOGLE_TOKEN')

  const profile = await gRes.json()
  const userEmail = (profile.email || '').toLowerCase().trim()
  if (!userEmail) throw new HttpError(401, 'Could not retrieve email from Google', 'INVALID_GOOGLE_TOKEN')

  // 2. If bootstrap admin → register as the active admin token provider
  if (BOOTSTRAP_ADMINS.includes(userEmail)) setAdminEmail(userEmail)

  // 3. Look up user (bootstrap env check + sheet check)
  let found
  try {
    found = await lookupUser(userEmail)
  } catch (e) {
    console.warn('[auth/verify] lookupUser error:', e.message)
    // Sheet unreachable — only let bootstrap admins through
    found = BOOTSTRAP_ADMINS.includes(userEmail) ? { email: userEmail, role: 'admin' } : null
  }
  if (!found) throw new HttpError(403, 'غير مصرح لك بالدخول. تواصل مع المدير لإضافتك.', 'NOT_ALLOWED')

  // 4. If admin, register their email
  if (found.role === 'admin') setAdminEmail(userEmail)

  // 5. Store token in memory cache (best-effort for same warm instance)
  tokenStore.set(userEmail, googleAccessToken)

  // 6. Issue JWT — embed encrypted Google token so backend survives cold starts.
  //    AES-256-GCM encrypted — client sees only a base64 blob, not the actual token.
  const payload = {
    userId:  userEmail,
    name:    profile.name || profile.given_name || userEmail,
    email:   userEmail,
    picture: profile.picture || null,
    role:    found.role,
    encryptedGoogleToken: tokenStore.encrypt(googleAccessToken),
    googleTokenExpiresAt: Date.now() + 55 * 60 * 1000,
  }
  const token = jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1y',
  })

  // Return user WITHOUT encryptedGoogleToken — that stays server-side only
  const { userId, name, picture } = payload
  res.json({ token, user: { userId, name, email: userEmail, picture, role: found.role } })
}))

// ── GET /api/auth/me ─────────────────────────────────────────────────
router.get('/me', requireAuth, (req, res) => {
  const { userId, name, email: userEmail, picture, role: userRole } = req.user
  res.json({ user: { userId, name, email: userEmail, picture, role: userRole } })
})

// ── POST /api/auth/logout ────────────────────────────────────────────
router.post('/logout', requireAuth, (req, res) => {
  res.json({ success: true })
})

// ── /api/auth/users (admin only) ─────────────────────────────────────
router.use('/users', requireAuth, requireAdmin)

router.get('/users', asyncHandler(async (req, res) => {
  // No token available yet (cold start, no service account)
  if (!(await isReady())) {
    return res.json({ users: bootstrapOnlyUsers(), sheetReady: false })
  }
  try {
    res.json({ users: await getAllUsers(), sheetReady: true })
  } catch (err) {
    console.error('[auth/users GET]', err)
    res.json({ users: bootstrapOnlyUsers(), sheetReady: false, error: err.message })
  }
}))

router.post('/users', validate({ body: addUserBody }), asyncHandler(async (req, res) => {
  const { email: newEmail, role: newRole } = req.valid.body

  if (BOOTSTRAP_ADMINS.includes(newEmail))
    throw new HttpError(400, 'هذا المستخدم موجود بالفعل كمشرف في إعدادات الخادم', 'ENV_USER')
  if (BOOTSTRAP_USERS.includes(newEmail))
    throw new HttpError(400, 'هذا المستخدم موجود بالفعل كمستخدم في إعدادات الخادم', 'ENV_USER')

  const existing = await getAllUsers()
  if (existing.some(u => u.email === newEmail))
    throw new HttpError(409, 'المستخدم مضاف بالفعل', 'USER_EXISTS')

  await addUser(newEmail, newRole, req.user.email)
  res.status(201).json({ success: true, users: await getAllUsers(), sheetReady: true })
}))

// PUT /api/auth/users/:email  { role }
router.put('/users/:email', validate({ params: emailParams, body: roleBody }), asyncHandler(async (req, res) => {
  await updateUserRole(req.valid.params.email, req.valid.body.role)
  res.json({ success: true, users: await getAllUsers(), sheetReady: true })
}))

// DELETE /api/auth/users/:email
router.delete('/users/:email', validate({ params: emailParams }), asyncHandler(async (req, res) => {
  if (req.valid.params.email === req.user.email)
    throw new HttpError(400, 'لا يمكنك حذف حسابك الحالي', 'SELF_DELETE')
  await removeUser(req.valid.params.email)
  res.json({ success: true, users: await getAllUsers(), sheetReady: true })
}))

export default router
