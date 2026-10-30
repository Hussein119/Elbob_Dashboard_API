// middleware/auth.js
// Verifies our own JWT on every protected route, then re-checks the user
// against the users list so removals / role changes apply immediately instead
// of when the (long-lived) JWT expires.

import jwt from 'jsonwebtoken'
import { timingSafeEqual } from 'crypto'
import { HttpError, asyncHandler } from './errors.js'
import { getCurrentRole } from '../config/userStore.js'

export const requireAuth = asyncHandler(async (req, _res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Missing or malformed Authorization header', 'NO_TOKEN')
  }

  let payload
  try {
    payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET)
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new HttpError(401, 'Session expired. Please log in again.', 'TOKEN_EXPIRED')
    }
    throw new HttpError(401, 'Invalid token', 'INVALID_TOKEN')
  }

  // null = no longer in the users list; undefined = list unreachable, keep the JWT role
  const currentRole = await getCurrentRole(payload.email || payload.userId)
  if (currentRole === null) {
    throw new HttpError(401, 'تم إلغاء صلاحية دخولك. تواصل مع المدير.', 'USER_REMOVED')
  }

  req.user = { ...payload, role: currentRole ?? payload.role }  // { userId, name, email, role, iat, exp }
  next()
})

/**
 * Vercel Cron calls with `Authorization: Bearer <CRON_SECRET>`; anyone else
 * must be a signed-in admin.
 */
export function requireCronOrAdmin(req, res, next) {
  const secret   = process.env.CRON_SECRET
  const given    = Buffer.from(req.headers.authorization || '')
  const expected = Buffer.from(`Bearer ${secret}`)
  if (secret && given.length === expected.length && timingSafeEqual(given, expected)) {
    req.user = { userId: 'cron', email: 'cron', name: 'Cron', role: 'admin' }
    return next()
  }
  requireAuth(req, res, err => (err ? next(err) : requireAdmin(req, res, next)))
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') {
    return next(new HttpError(403, 'Admin access required', 'ADMIN_ONLY'))
  }
  next()
}
