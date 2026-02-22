// routes/sheets.js
//
// All Google Sheets API calls are proxied here.
// The frontend NEVER talks to Google directly — it talks to us.
// We retrieve the Google token from the server-side store and attach it.

import { Router }     from 'express'
import fetch          from 'node-fetch'
import { tokenStore } from '../config/tokenStore.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()

const SHEET_ID = process.env.SHEET_ID

// ── Helper: get Google token or return 401 ──────────────────────────
function getGoogleToken(req, res) {
  const token = tokenStore.get(req.user.userId)
  if (!token) {
    res.status(401).json({
      error: 'Google session expired. Please reconnect Google Sheets.',
      code:  'GOOGLE_TOKEN_EXPIRED',
    })
    return null
  }
  return token
}

// ── Helper: forward Google API errors cleanly ───────────────────────
async function handleGoogleError(googleRes, res) {
  const body = await googleRes.json().catch(() => ({}))
  const msg  = body?.error?.message || `Google API error ${googleRes.status}`
  console.error('[sheets] Google error:', msg)
  return res.status(googleRes.status).json({ error: msg })
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/sheets/data
// Returns all rows from the first sheet tab.
// ─────────────────────────────────────────────────────────────────────
router.get('/data', requireAuth, async (req, res) => {
  const googleToken = getGoogleToken(req, res)
  if (!googleToken) return

  try {
    // Step 1: get sheet metadata (tab name + sheetId)
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${googleToken}` } }
    )
    if (!metaRes.ok) return handleGoogleError(metaRes, res)

    const meta       = await metaRes.json()
    const firstSheet = meta.sheets[0].properties
    const sheetName  = firstSheet.title
    const sheetId    = firstSheet.sheetId

    // Step 2: fetch values
    const valRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName + '!A:L')}`,
      { headers: { Authorization: `Bearer ${googleToken}` } }
    )
    if (!valRes.ok) return handleGoogleError(valRes, res)

    const data = await valRes.json()

    res.json({
      values:    data.values || [],
      sheetName,
      sheetId,
    })
  } catch (err) {
    console.error('[sheets/data]', err)
    res.status(500).json({ error: 'Failed to fetch sheet data' })
  }
})

// ─────────────────────────────────────────────────────────────────────
// POST /api/sheets/append
// Body: { values: [...], sheetName: "Sheet1" }
// ─────────────────────────────────────────────────────────────────────
router.post('/append', requireAuth, async (req, res) => {
  const googleToken = getGoogleToken(req, res)
  if (!googleToken) return

  const { values, sheetName } = req.body
  if (!Array.isArray(values) || !sheetName) {
    return res.status(400).json({ error: 'values (array) and sheetName are required' })
  }

  try {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName + '!A:L')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
    const gRes = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values }),
    })
    if (!gRes.ok) return handleGoogleError(gRes, res)
    res.json(await gRes.json())
  } catch (err) {
    console.error('[sheets/append]', err)
    res.status(500).json({ error: 'Failed to append row' })
  }
})

// ─────────────────────────────────────────────────────────────────────
// PUT /api/sheets/row/:rowIndex
// Body: { values: [...], sheetName: "Sheet1" }
// ─────────────────────────────────────────────────────────────────────
router.put('/row/:rowIndex', requireAuth, async (req, res) => {
  const googleToken = getGoogleToken(req, res)
  if (!googleToken) return

  const { rowIndex }          = req.params
  const { values, sheetName } = req.body
  if (!values || !sheetName) {
    return res.status(400).json({ error: 'values and sheetName are required' })
  }

  const rowNum = parseInt(rowIndex, 10)
  if (isNaN(rowNum) || rowNum < 2) {
    return res.status(400).json({ error: 'Invalid rowIndex' })
  }

  try {
    const range = `${sheetName}!A${rowNum}:L${rowNum}`
    const url   = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`
    const gRes  = await fetch(url, {
      method:  'PUT',
      headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ values }),
    })
    if (!gRes.ok) return handleGoogleError(gRes, res)
    res.json(await gRes.json())
  } catch (err) {
    console.error('[sheets/row PUT]', err)
    res.status(500).json({ error: 'Failed to update row' })
  }
})

// ─────────────────────────────────────────────────────────────────────
// DELETE /api/sheets/row/:rowIndex
// Query: ?sheetId=0
// ─────────────────────────────────────────────────────────────────────
router.delete('/row/:rowIndex', requireAuth, async (req, res) => {
  const googleToken = getGoogleToken(req, res)
  if (!googleToken) return

  const { rowIndex } = req.params
  const { sheetId  } = req.query

  const rowNum    = parseInt(rowIndex, 10)
  const sheetIdNum = parseInt(sheetId, 10)

  if (isNaN(rowNum) || rowNum < 2) {
    return res.status(400).json({ error: 'Invalid rowIndex' })
  }
  if (isNaN(sheetIdNum)) {
    return res.status(400).json({ error: 'sheetId query param is required' })
  }

  try {
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`
    const gRes = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: {
              sheetId:    sheetIdNum,
              dimension:  'ROWS',
              startIndex: rowNum - 1,
              endIndex:   rowNum,
            },
          },
        }],
      }),
    })
    if (!gRes.ok) return handleGoogleError(gRes, res)
    res.json(await gRes.json())
  } catch (err) {
    console.error('[sheets/row DELETE]', err)
    res.status(500).json({ error: 'Failed to delete row' })
  }
})

export default router
