// routes/sheets.js
//
// All Google Sheets API calls are proxied here.
// The frontend NEVER talks to Google directly — it talks to us.
// We retrieve the Google token from the server-side store and attach it.

import { Router }          from 'express'
import fetch               from 'node-fetch'
import { requireAuth }     from '../middleware/auth.js'
import { getServiceToken } from '../config/serviceAccount.js'
import { tokenStore }      from '../config/tokenStore.js'

const router = Router()

const SHEET_ID = process.env.SHEET_ID

// ── Helper: convert 1-based column index to letter(s) (e.g. 1→A, 26→Z, 27→AA) ──
function colIndexToLetter(index) {
  let letter = ''
  while (index > 0) {
    const mod = (index - 1) % 26
    letter = String.fromCharCode(65 + mod) + letter
    index  = Math.floor((index - 1) / 26)
  }
  return letter
}

// ── Helper: get a valid Google token (service account preferred) ─────
async function getGoogleToken(req, res) {
  // Primary: service account token (never expires, auto-refreshes)
  const saToken = await getServiceToken()
  if (saToken) return saToken

  // Fallback: user's OAuth token from JWT (expires after ~60 min)
  const token = tokenStore.get(req.user.userId, req)
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
  // If Google returns 401, include GOOGLE_TOKEN_EXPIRED code so the
  // frontend can silently refresh the token and retry the request.
  const extra = googleRes.status === 401 ? { code: 'GOOGLE_TOKEN_EXPIRED' } : {}
  return res.status(googleRes.status).json({ error: msg, ...extra })
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/sheets/data
// Returns all rows from the first sheet tab.
// ─────────────────────────────────────────────────────────────────────
router.get('/data', requireAuth, async (req, res) => {
  const googleToken = await getGoogleToken(req, res)
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
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(sheetName + '!A:Z')}`,
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
  const googleToken = await getGoogleToken(req, res)
  if (!googleToken) return

  const { values, sheetName } = req.body
  if (!Array.isArray(values) || !sheetName) {
    return res.status(400).json({ error: 'values (array) and sheetName are required' })
  }

  try {
    // Use the Sheets API native append endpoint — it locates the first empty
    // row automatically and inserts new rows into the grid if the sheet is
    // full, avoiding "exceeds grid limits" errors from manual row calculation.
    const range = encodeURIComponent(`${sheetName}!A1`)
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`
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
  const googleToken = await getGoogleToken(req, res)
  if (!googleToken) return

  const { rowIndex } = req.params

  // Robustly read body — on Vercel serverless, body-parser may not fire for PUT
  let parsedBody = req.body
  if (!parsedBody || typeof parsedBody !== 'object' || !Object.keys(parsedBody).length) {
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = ''
        req.on('data', chunk => { data += chunk })
        req.on('end', () => resolve(data))
        req.on('error', reject)
      })
      parsedBody = raw ? JSON.parse(raw) : {}
    } catch { parsedBody = {} }
  }

  const { values, sheetName } = parsedBody
  if (!values || !sheetName) {
    return res.status(400).json({ error: 'values and sheetName are required' })
  }

  const rowNum = parseInt(rowIndex, 10)
  if (isNaN(rowNum) || rowNum < 2) {
    return res.status(400).json({ error: 'Invalid rowIndex' })
  }

  try {
    // Determine last column letter dynamically based on values array length
    const colCount  = Array.isArray(values[0]) ? values[0].length : values.length
    const lastCol   = colIndexToLetter(colCount)
    const range = `${sheetName}!A${rowNum}:${lastCol}${rowNum}`
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
  const googleToken = await getGoogleToken(req, res)
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

// ─────────────────────────────────────────────────────────────────────
// POST /api/sheets/ensure-tab
// Body: { tabName: "مشتريات بضاعة", headers: ["col1", "col2", ...] }
// Creates a new sheet tab if it doesn't already exist, then writes headers.
// Returns: { created: true/false, sheetId, tabName }
// ─────────────────────────────────────────────────────────────────────
router.post('/ensure-tab', requireAuth, async (req, res) => {
  const googleToken = await getGoogleToken(req, res)
  if (!googleToken) return

  const { tabName, headers } = req.body
  if (!tabName || !Array.isArray(headers) || headers.length === 0) {
    return res.status(400).json({ error: 'tabName and headers[] are required' })
  }

  try {
    // 1. Fetch existing sheets
    const metaRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}?fields=sheets.properties`,
      { headers: { Authorization: `Bearer ${googleToken}` } }
    )
    if (!metaRes.ok) return handleGoogleError(metaRes, res)

    const meta   = await metaRes.json()
    const sheets = meta.sheets || []
    const existing = sheets.find(s => s.properties.title === tabName)

    if (existing) {
      const sheetId = existing.properties.sheetId

      // Read current header row to check for missing columns
      const readUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName + '!1:1')}`
      const readRes = await fetch(readUrl, { headers: { Authorization: `Bearer ${googleToken}` } })
      if (!readRes.ok) return handleGoogleError(readRes, res)
      const readData   = await readRes.json()
      const currentRow = readData.values?.[0] || []

      const missing = headers.filter(h => !currentRow.includes(h))
      if (missing.length > 0) {
        // Append missing headers to the end of row 1
        const nextCol  = colIndexToLetter(currentRow.length + 1)
        const lastCol  = colIndexToLetter(currentRow.length + missing.length)
        const range    = `${tabName}!${nextCol}1:${lastCol}1`
        const writeUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`
        const writeRes = await fetch(writeUrl, {
          method:  'PUT',
          headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ values: [missing] }),
        })
        if (!writeRes.ok) return handleGoogleError(writeRes, res)
      }

      return res.json({ created: false, sheetId, tabName })
    }

    // 2. Create the new tab
    const addRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}:batchUpdate`,
      {
        method:  'POST',
        headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: tabName } } }],
        }),
      }
    )
    if (!addRes.ok) return handleGoogleError(addRes, res)

    const addData  = await addRes.json()
    const newSheetId = addData.replies[0].addSheet.properties.sheetId

    // 3. Write header row
    const headerUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName + '!A1')}?valueInputOption=USER_ENTERED`
    const hRes = await fetch(headerUrl, {
      method:  'PUT',
      headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [headers] }),
    })
    if (!hRes.ok) return handleGoogleError(hRes, res)

    return res.json({ created: true, sheetId: newSheetId, tabName })
  } catch (err) {
    console.error('[sheets/ensure-tab]', err)
    res.status(500).json({ error: 'Failed to ensure tab' })
  }
})

// ─────────────────────────────────────────────────────────────────────
// GET /api/sheets/tab-data?tabName=مشتريات بضاعة
// Returns all rows (including header) from the specified tab.
// ─────────────────────────────────────────────────────────────────────
router.get('/tab-data', requireAuth, async (req, res) => {
  const googleToken = await getGoogleToken(req, res)
  if (!googleToken) return

  const { tabName } = req.query
  if (!tabName) return res.status(400).json({ error: 'tabName query param is required' })

  try {
    const valRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(tabName + '!A:Z')}`,
      { headers: { Authorization: `Bearer ${googleToken}` } }
    )
    if (!valRes.ok) return handleGoogleError(valRes, res)

    const data = await valRes.json()
    res.json({ values: data.values || [], tabName })
  } catch (err) {
    console.error('[sheets/tab-data]', err)
    res.status(500).json({ error: 'Failed to fetch tab data' })
  }
})

// ─────────────────────────────────────────────────────────────────────
// POST /api/sheets/batch-rows
// Body: { sheetName, updates: [{ rowIndex, values: [...] }] }
// Updates multiple rows in a single Google Sheets batchUpdate call.
// ─────────────────────────────────────────────────────────────────────
router.post('/batch-rows', requireAuth, async (req, res) => {
  const googleToken = await getGoogleToken(req, res)
  if (!googleToken) return

  const { sheetName, updates } = req.body
  if (!sheetName || !Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'sheetName and updates[] are required' })
  }

  for (const u of updates) {
    const row = parseInt(u.rowIndex, 10)
    if (isNaN(row) || row < 2) {
      return res.status(400).json({ error: `Invalid rowIndex: ${u.rowIndex}` })
    }
    if (!Array.isArray(u.values)) {
      return res.status(400).json({ error: 'Each update must have a values array' })
    }
  }

  try {
    const url  = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values:batchUpdate`
    const gRes = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${googleToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        valueInputOption: 'USER_ENTERED',
        data: updates.map(({ rowIndex, values }) => ({
          range:  `${sheetName}!A${rowIndex}`,
          values: [values],
        })),
      }),
    })
    if (!gRes.ok) return handleGoogleError(gRes, res)
    res.json({ updated: updates.length })
  } catch (err) {
    console.error('[sheets/batch-rows]', err)
    res.status(500).json({ error: 'Failed to batch update rows' })
  }
})

export default router