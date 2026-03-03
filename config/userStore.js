// config/userStore.js
//
// Sheet-backed user management using the logged-in admin's Google OAuth token.
// No Service Account or JSON key needed — the admin's token already has
// spreadsheets scope from the login OAuth flow.
//
// Flow:
//   1. Admin logs in → their Google token is saved in tokenStore
//   2. auth.js calls setAdminToken() to give us a copy
//   3. All sheet operations use that token
//   4. If the token expires, the next admin login refreshes it automatically
//
// Sheet tab "المستخدمون" columns: email | role | addedBy | addedAt

import { tokenStore } from './tokenStore.js'
import { getServiceToken } from './serviceAccount.js'

const USERS_TAB     = 'المستخدمون'
const USERS_HEADERS = ['email', 'role', 'addedBy', 'addedAt']
// Read once at module load — env vars are immutable after startup.
const SHEET_ID      = process.env.SHEET_ID

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

// ── Sheet fetch — service account preferred, admin token fallback ─────
async function sheetFetch(url, options = {}) {
  // Primary: service account token (never expires, auto-refreshes)
  let token = await getServiceToken()

  // Fallback: admin's OAuth token (expires after ~60 min)
  if (!token) {
    token = adminEmail ? tokenStore.get(adminEmail) : null
    if (!token) throw new Error('لا يوجد مشرف مسجل دخوله حالياً. سجّل دخولك مرة أخرى.')
  }

  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    if (res.status === 401) adminEmail = null
    throw new Error(body?.error?.message || `Sheets API error ${res.status}`)
  }
  return res.json()
}

// ── Tab management ────────────────────────────────────────────────────
// Once we confirm the tab exists (or create it) we set this flag so
// subsequent addUser() calls skip the redundant metadata round-trip.
let _tabEnsured = false
let _cachedTabSheetId = undefined  // undefined = not fetched; null = tab missing

async function ensureTab() {
  if (_tabEnsured) return  // skip network call after first successful check

  const meta = await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`
  )
  const existing = (meta.sheets || []).find(s => s.properties.title === USERS_TAB)
  if (existing) {
    _cachedTabSheetId = existing.properties.sheetId
    _tabEnsured = true
    return
  }

  await sheetFetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: USERS_TAB } } }] }),
  })
  await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(USERS_TAB + '!A1')}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values: [USERS_HEADERS] }) }
  )
  // Invalidate cached sheet ID so getUsersTabSheetId() re-fetches the new tab's ID
  _cachedTabSheetId = undefined
  _tabEnsured = true
}

async function readAllRows() {
  const data = await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(USERS_TAB + '!A:D')}`
  )
  if (!data?.values || data.values.length < 2) return []
  return data.values.slice(1).map((row, i) => ({
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
const TTL_MS  = 60_000

export async function refreshCache() {
  await ensureTab()
  const rows = await readAllRows()
  cache     = new Map(rows.map(u => [u.email, u]))
  cacheTime = Date.now()
  return rows
}

// ── Public API ────────────────────────────────────────────────────────

/** Called at login time. Bootstrap admins/users always pass; others checked against sheet. */
export async function lookupUser(email) {
  const e = email.toLowerCase().trim()

  if (_bootstrapAdmins.includes(e)) return { email: e, role: 'admin' }

  // Bootstrap users — defined in USER_EMAILS env var, always have role 'user'
  if (_bootstrapUsers.includes(e)) return { email: e, role: 'user' }

  // Need a valid token (service account or admin) to read the sheet
  if (!(await isReady())) {
    return null
  }

  if (!cache || Date.now() - cacheTime > TTL_MS) await refreshCache()
  return cache?.get(e) || null
}

export async function getAllUsers() {
  if (!cache || Date.now() - cacheTime > TTL_MS) await refreshCache()

  const sheetUsers  = cache ? [...cache.values()] : []
  const sheetEmails = new Set(sheetUsers.map(u => u.email))
  const envAdmins   = _bootstrapAdmins
    .filter(e => !sheetEmails.has(e))
    .map(e => ({ email: e, role: 'admin', addedBy: 'env', addedAt: '' }))
  const envUsers    = _bootstrapUsers
    .filter(e => !sheetEmails.has(e) && !_bootstrapAdmins.includes(e))
    .map(e => ({ email: e, role: 'user', addedBy: 'env', addedAt: '' }))
  const envOnly = [...envAdmins, ...envUsers]

  return [...envOnly, ...sheetUsers]
}

export async function addUser(email, role, addedBy) {
  const e = email.toLowerCase().trim()
  await ensureTab()
  const now = new Date().toLocaleDateString('ar-EG')
  await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(USERS_TAB + '!A:D')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [[e, role, addedBy, now]] }) }
  )
  cache = null
}

export async function removeUser(rowIndex, tabSheetId) {
  await sheetFetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [{ deleteDimension: {
        range: { sheetId: tabSheetId, dimension: 'ROWS', startIndex: rowIndex - 1, endIndex: rowIndex },
      }}],
    }),
  })
  cache = null
}

export async function updateUserRole(rowIndex, role) {
  await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(USERS_TAB + '!B' + rowIndex)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values: [[role]] }) }
  )
  cache = null
}

export async function getUsersTabSheetId() {
  // Return cached value — the tab's numeric sheetId never changes once created.
  if (_cachedTabSheetId !== undefined) return _cachedTabSheetId
  const meta = await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`
  )
  const tab = (meta.sheets || []).find(s => s.properties.title === USERS_TAB)
  _cachedTabSheetId = tab ? tab.properties.sheetId : null
  return _cachedTabSheetId
}

/** True if we have a valid token to access sheets (service account or admin). */
export async function isReady() {
  const saToken = await getServiceToken()
  if (saToken) return true
  return !!(adminEmail && tokenStore.get(adminEmail))
}