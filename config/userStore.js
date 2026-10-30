// config/userStore.js
//
// Sheet-backed user management. Uses the service account when configured,
// otherwise the most recently logged-in admin's Google OAuth token.
//
// Sheet tab "المستخدمون" columns: email | role | addedBy | addedAt

import { tokenStore } from './tokenStore.js'
import { getServiceToken } from './serviceAccount.js'
import { USERS_TAB } from './tabs.js'
import { HttpError } from '../middleware/errors.js'
import * as sheets from '../services/googleSheets.js'

const USERS_HEADERS = ['email', 'role', 'addedBy', 'addedAt']

// Parse bootstrap env arrays once; avoids split/map/filter on every request.
const _bootstrapAdmins = (process.env.ADMIN_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
const _bootstrapUsers  = (process.env.USER_EMAILS  || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

// Most recent admin email — used to pull their token from tokenStore (fallback only)
let adminEmail = null

/** Called by auth.js whenever an admin logs in or refreshes their Google token. */
export function setAdminEmail(email) {
  adminEmail = email
}

// ── Token — service account preferred, admin token fallback ───────────
async function getToken() {
  const serviceToken = await getServiceToken()
  if (serviceToken) return serviceToken

  const token = adminEmail ? tokenStore.get(adminEmail) : null
  if (!token) throw new Error('لا يوجد مشرف مسجل دخوله حالياً. سجّل دخولك مرة أخرى.')
  return token
}

async function withToken(fn) {
  const token = await getToken()
  try {
    return await fn(token)
  } catch (err) {
    if (err.status === 401) adminEmail = null
    throw err
  }
}

// ── Tab management ────────────────────────────────────────────────────
// Once we confirm the tab exists (or create it) we skip the metadata round-trip.
let _tabEnsured = false

async function ensureTab(token) {
  if (_tabEnsured) return
  const { tab } = await sheets.findTab(token, { title: USERS_TAB })
  if (!tab) {
    await sheets.addTab(token, USERS_TAB)
    await sheets.writeHeaderCells(token, USERS_TAB, 1, USERS_HEADERS)
  }
  _tabEnsured = true
}

async function readAllRows(token) {
  const values = await sheets.readValues(token, USERS_TAB, 'A:D')
  if (values.length < 2) return []
  return values.slice(1).map((row, i) => ({
    __rowIndex: i + 2,
    email:    (row[0] || '').toLowerCase().trim(),
    role:      row[1] || 'user',
    addedBy:   row[2] || '',
    addedAt:   row[3] || '',
  })).filter(u => u.email)
}

// ── Cache ─────────────────────────────────────────────────────────────
let cache     = null
let cacheTime = 0
let inFlight  = null
const TTL_MS  = 60_000

const isCacheFresh = () => cache && Date.now() - cacheTime <= TTL_MS

/** Re-reads the users tab. Concurrent callers share one request. */
export function refreshCache() {
  inFlight ??= withToken(async token => {
    await ensureTab(token)
    const rows = await readAllRows(token)
    cache     = new Map(rows.map(u => [u.email, u]))
    cacheTime = Date.now()
    return rows
  }).finally(() => { inFlight = null })
  return inFlight
}

// ── Public API ────────────────────────────────────────────────────────

/** Called at login time. Bootstrap admins/users always pass; others checked against sheet. */
export async function lookupUser(email) {
  const e = email.toLowerCase().trim()

  if (_bootstrapAdmins.includes(e)) return { email: e, role: 'admin' }
  if (_bootstrapUsers.includes(e))  return { email: e, role: 'user' }

  // Need a valid token (service account or admin) to read the sheet
  if (!(await isReady())) return null

  if (!isCacheFresh()) await refreshCache()
  return cache?.get(e) || null
}

/**
 * Role for an already-authenticated user, checked on every request.
 * Returns 'admin' | 'user', null if the user was removed, or undefined when
 * the users list can't be read right now (caller keeps the JWT role).
 */
export async function getCurrentRole(email) {
  const e = String(email || '').toLowerCase().trim()
  if (_bootstrapAdmins.includes(e)) return 'admin'
  if (_bootstrapUsers.includes(e))  return 'user'

  try {
    if (!(await isReady())) return undefined
    if (!isCacheFresh()) await refreshCache()
    return cache?.get(e)?.role ?? null
  } catch (err) {
    console.warn('[userStore] role check skipped:', err.message)
    return undefined
  }
}

export async function getAllUsers() {
  if (!isCacheFresh()) await refreshCache()

  const sheetUsers  = cache ? [...cache.values()] : []
  const sheetEmails = new Set(sheetUsers.map(u => u.email))
  const envAdmins   = _bootstrapAdmins
    .filter(e => !sheetEmails.has(e))
    .map(e => ({ email: e, role: 'admin', addedBy: 'env', addedAt: '' }))
  const envUsers    = _bootstrapUsers
    .filter(e => !sheetEmails.has(e) && !_bootstrapAdmins.includes(e))
    .map(e => ({ email: e, role: 'user', addedBy: 'env', addedAt: '' }))

  return [...envAdmins, ...envUsers, ...sheetUsers]
}

export async function addUser(email, role, addedBy) {
  const e = email.toLowerCase().trim()
  const now = new Date().toLocaleDateString('ar-EG')
  await withToken(async token => {
    await ensureTab(token)
    await sheets.appendRows(token, USERS_TAB, [[e, role, addedBy, now]])
  })
  cache = null
}

/** Looks the row up fresh by email, so a stale row number can never hit another user. */
async function findSheetUser(email) {
  await refreshCache()
  const user = cache?.get(email.toLowerCase().trim())
  if (!user) throw new HttpError(404, 'المستخدم غير موجود في الشيت', 'USER_NOT_FOUND')
  return user
}

export async function updateUserRole(email, role) {
  const user = await findSheetUser(email)
  await withToken(token =>
    sheets.updateRows(token, USERS_TAB, [{ rowIndex: user.__rowIndex, values: [user.email, role] }]),
  )
  cache = null
}

export async function removeUser(email) {
  const user = await findSheetUser(email)
  await withToken(async token => {
    const { tab } = await sheets.findTab(token, { title: USERS_TAB })
    if (!tab) throw new HttpError(404, 'تبويب المستخدمين غير موجود', 'TAB_NOT_FOUND')
    await sheets.deleteRows(token, tab.sheetId, [user.__rowIndex])
  })
  cache = null
}

/** True if we have a valid token to access sheets (service account or admin). */
export async function isReady() {
  const serviceToken = await getServiceToken()
  if (serviceToken) return true
  return !!(adminEmail && tokenStore.get(adminEmail))
}
