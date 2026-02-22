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

const USERS_TAB     = 'المستخدمون'
const USERS_HEADERS = ['email', 'role', 'addedBy', 'addedAt']
const SHEET_ID      = () => process.env.SHEET_ID

// Most recent admin email — used to pull their token from tokenStore
let adminEmail = null

/** Called by auth.js whenever an admin logs in or refreshes their Google token. */
export function setAdminEmail(email) {
  adminEmail = email
}

// ── Sheet fetch using the stored admin token ──────────────────────────
async function sheetFetch(url, options = {}) {
  // Get the freshest available admin token
  const token = adminEmail ? tokenStore.get(adminEmail) : null
  if (!token) throw new Error('لا يوجد مشرف مسجل دخوله حالياً. سجّل دخولك مرة أخرى.')

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
    // Token expired → clear it so next call triggers a proper error message
    if (res.status === 401) adminEmail = null
    throw new Error(body?.error?.message || `Sheets API error ${res.status}`)
  }
  return res.json()
}

// ── Tab management ────────────────────────────────────────────────────
async function ensureTab() {
  const meta = await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}?fields=sheets.properties`
  )
  const exists = (meta.sheets || []).some(s => s.properties.title === USERS_TAB)
  if (exists) return

  await sheetFetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: USERS_TAB } } }] }),
  })
  await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}/values/${encodeURIComponent(USERS_TAB + '!A1')}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values: [USERS_HEADERS] }) }
  )
}

async function readAllRows() {
  const data = await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}/values/${encodeURIComponent(USERS_TAB + '!A:D')}`
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

/** Called at login time. Bootstrap admins always pass; others checked against sheet. */
export async function lookupUser(email) {
  const e = email.toLowerCase().trim()

  const bootstrapAdmins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  if (bootstrapAdmins.includes(e)) return { email: e, role: 'admin' }

  // Need an admin token to read the sheet
  if (!adminEmail || !tokenStore.get(adminEmail)) {
    // No admin logged in yet — only bootstrap admins can log in
    return null
  }

  if (!cache || Date.now() - cacheTime > TTL_MS) await refreshCache()
  return cache?.get(e) || null
}

export async function getAllUsers() {
  if (!cache || Date.now() - cacheTime > TTL_MS) await refreshCache()

  const bootstrapAdmins = (process.env.ADMIN_EMAILS || '')
    .split(',').map(x => x.trim().toLowerCase()).filter(Boolean)
  const sheetUsers  = cache ? [...cache.values()] : []
  const sheetEmails = new Set(sheetUsers.map(u => u.email))
  const envOnly     = bootstrapAdmins
    .filter(e => !sheetEmails.has(e))
    .map(e => ({ email: e, role: 'admin', addedBy: 'env', addedAt: '' }))

  return [...envOnly, ...sheetUsers]
}

export async function addUser(email, role, addedBy) {
  const e = email.toLowerCase().trim()
  await ensureTab()
  const now = new Date().toLocaleDateString('ar-EG')
  await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}/values/${encodeURIComponent(USERS_TAB + '!A:D')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [[e, role, addedBy, now]] }) }
  )
  cache = null
}

export async function removeUser(rowIndex, tabSheetId) {
  await sheetFetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}:batchUpdate`, {
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
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}/values/${encodeURIComponent(USERS_TAB + '!B' + rowIndex)}?valueInputOption=USER_ENTERED`,
    { method: 'PUT', body: JSON.stringify({ values: [[role]] }) }
  )
  cache = null
}

export async function getUsersTabSheetId() {
  const meta = await sheetFetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID()}?fields=sheets.properties`
  )
  const tab = (meta.sheets || []).find(s => s.properties.title === USERS_TAB)
  return tab ? tab.properties.sheetId : null
}

/** True if we have a live admin token ready. */
export function isReady() {
  return !!(adminEmail && tokenStore.get(adminEmail))
}