// services/googleSheets.js
//
// Every Google Sheets API call goes through here:
//   - googleFetch retries 429/5xx with backoff (all users share one service
//     account, so Google's per-user quota is shared by the whole team)
//   - tab metadata (title ↔ sheetId) is cached per warm instance
//   - text cells that would be evaluated as formulas are stored as plain text
//   - assertRowsUnchanged guards row-index based writes against concurrent edits
//
// spreadsheetClient(id) works on any spreadsheet; the named exports below are
// bound to the main spreadsheet (SHEET_ID). The archive uses its own client.

import { getServiceToken } from '../config/serviceAccount.js'
import { tokenStore }      from '../config/tokenStore.js'
import { HttpError }       from '../middleware/errors.js'

const RETRYABLE    = new Set([429, 500, 502, 503, 504])
const MAX_ATTEMPTS = 4
const MAX_DELAY_MS = 8000
const META_TTL_MS  = 5 * 60 * 1000

export const STALE_ROWS_MESSAGE = 'البيانات اتغيرت من مستخدم تاني — تم تحديث القائمة، راجع وحاول مرة تانية'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// ── Tokens ────────────────────────────────────────────────────────────

/** Service account token first; falls back to the user's OAuth token embedded in the JWT. */
export async function getRequestToken(req) {
  const serviceToken = await getServiceToken()
  if (serviceToken) return serviceToken

  const userToken = tokenStore.get(req.user.userId, req)
  if (!userToken) {
    throw new HttpError(401, 'Google session expired. Please reconnect Google Sheets.', 'GOOGLE_TOKEN_EXPIRED')
  }
  return userToken
}

// ── Low-level fetch ───────────────────────────────────────────────────

export async function googleFetch(token, url, { method = 'GET', body } = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined && { 'Content-Type': 'application/json' }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (res.ok) return res.json()

    if (RETRYABLE.has(res.status) && attempt < MAX_ATTEMPTS) {
      const retryAfterSec = Number(res.headers.get('retry-after'))
      const delay = retryAfterSec > 0
        ? retryAfterSec * 1000
        : 2 ** attempt * 250 + Math.random() * 250
      await sleep(Math.min(delay, MAX_DELAY_MS))
      continue
    }

    const data    = await res.json().catch(() => ({}))
    const message = data?.error?.message || `Google API error ${res.status}`
    console.error('[sheets] Google error:', res.status, message)
    throw new HttpError(res.status, message, res.status === 401 ? 'GOOGLE_TOKEN_EXPIRED' : undefined)
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** A1 notation with the tab title quoted, so spaces / Arabic / quotes are always valid. */
export function a1(title, range) {
  const quoted = `'${String(title).replace(/'/g, "''")}'`
  return range ? `${quoted}!${range}` : quoted
}

/** 1-based column index → letters (1→A, 26→Z, 27→AA) */
export function colIndexToLetter(index) {
  let letter = ''
  while (index > 0) {
    const mod = (index - 1) % 26
    letter = String.fromCharCode(65 + mod) + letter
    index  = Math.floor((index - 1) / 26)
  }
  return letter
}

const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/

/**
 * Writes use USER_ENTERED, so "=IMPORTXML(...)" typed into a name would run as a
 * formula. A leading apostrophe makes Sheets store the cell as text (the
 * apostrophe itself is not part of the value).
 */
export function sanitizeCell(value) {
  if (typeof value !== 'string' || value.startsWith("'")) return value
  const trimmed = value.trim()
  if (/^[=@]/.test(trimmed)) return "'" + value
  if (/^[+-]/.test(trimmed) && !PLAIN_NUMBER.test(trimmed)) return "'" + value
  return value
}

const sanitizeRow = row => row.map(sanitizeCell)

function normalizeRow(row) {
  const out = (row || []).map(v => String(v ?? '').trim())
  while (out.length && out[out.length - 1] === '') out.pop()
  return out
}

export function rowsEqual(a, b) {
  const x = normalizeRow(a)
  const y = normalizeRow(b)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

const staleError = () => new HttpError(409, STALE_ROWS_MESSAGE, 'STALE_ROWS')

/** Google's 400 for a range outside the tab's grid. */
export const isOutsideGridError = err => err?.status === 400 && /grid limits/i.test(err.message)

/** Contiguous [start, end] runs (1-based, inclusive) from row numbers, highest first. */
function contiguousRuns(rowIndices) {
  const rows = [...new Set(rowIndices)].sort((a, b) => b - a)
  const runs = []
  for (const r of rows) {
    const last = runs[runs.length - 1]
    if (last && last[0] === r + 1) last[0] = r
    else runs.push([r, r])
  }
  return runs
}

// ── Client for one spreadsheet ────────────────────────────────────────

export function spreadsheetClient(spreadsheetId) {
  const baseUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`

  let tabsCache     = null
  let tabsCacheTime = 0

  /** [{ title, sheetId, columnCount }] in spreadsheet order. */
  async function getTabs(token, { fresh = false } = {}) {
    if (!fresh && tabsCache && Date.now() - tabsCacheTime < META_TTL_MS) return tabsCache
    const meta = await googleFetch(
      token,
      `${baseUrl}?fields=sheets.properties(sheetId,title,gridProperties.columnCount)`,
    )
    tabsCache = (meta.sheets || []).map(s => ({
      title:       s.properties.title,
      sheetId:     s.properties.sheetId,
      columnCount: s.properties.gridProperties?.columnCount ?? 26,
    }))
    tabsCacheTime = Date.now()
    return tabsCache
  }

  /** Find a tab by title or sheetId; re-fetches metadata once on a cache miss. */
  async function findTab(token, { title, sheetId }) {
    const match = t => (title !== undefined ? t.title === title : t.sheetId === sheetId)
    let tabs = await getTabs(token)
    let tab  = tabs.find(match)
    if (!tab) {
      tabs = await getTabs(token, { fresh: true })
      tab  = tabs.find(match)
    }
    return { tab: tab || null, tabs }
  }

  /** Widens the tab's grid so it has at least `minColumns` columns (writes past the grid fail). */
  async function ensureColumnCount(token, title, minColumns) {
    const { tab } = await findTab(token, { title })
    if (!tab || tab.columnCount >= minColumns) return
    await googleFetch(token, `${baseUrl}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: [{
          appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: minColumns - tab.columnCount },
        }],
      },
    })
    tab.columnCount = minColumns
  }

  // ── Reads ───────────────────────────────────────────────────────────

  async function readValues(token, title, range = 'A:Z') {
    const data = await googleFetch(token, `${baseUrl}/values/${encodeURIComponent(a1(title, range))}`)
    return data.values || []
  }

  /** Map<rowIndex, row[]> for specific 1-based row numbers, in one request. */
  async function readRows(token, title, rowIndices) {
    const ranges = rowIndices.map(r => a1(title, `A${r}:Z${r}`))
    const data = await googleFetch(token, `${baseUrl}/values:batchGetByDataFilter`, {
      method: 'POST',
      body:   { dataFilters: ranges.map(a1Range => ({ a1Range })), majorDimension: 'ROWS' },
    })
    const rowByRange = new Map(ranges.map((range, i) => [range, rowIndices[i]]))
    const result = new Map()
    ;(data.valueRanges || []).forEach((vr, i) => {
      const echoed = vr.dataFilters?.[0]?.a1Range
      const rowIndex = rowByRange.get(echoed) ?? rowIndices[i]
      result.set(rowIndex, vr.valueRange?.values?.[0] || [])
    })
    return result
  }

  /**
   * checks: [{ rowIndex, expected }] — `expected` is the row exactly as the client
   * last read it. Throws 409 STALE_ROWS if any row changed or no longer exists.
   * Checks without `expected` are skipped (older clients).
   */
  async function assertRowsUnchanged(token, title, checks) {
    const withExpected = checks.filter(c => Array.isArray(c.expected))
    if (!withExpected.length) return

    let current
    try {
      current = await readRows(token, title, withExpected.map(c => c.rowIndex))
    } catch (err) {
      // The row is past the end of the sheet — rows were deleted meanwhile
      if (isOutsideGridError(err)) throw staleError()
      throw err
    }
    for (const { rowIndex, expected } of withExpected) {
      if (!rowsEqual(current.get(rowIndex), expected)) throw staleError()
    }
  }

  // ── Writes ──────────────────────────────────────────────────────────
  // `raw: true` stores values exactly as given (archive copies of already
  // formatted cells); otherwise USER_ENTERED with formula-safe text.

  const inputOption = raw => (raw ? 'RAW' : 'USER_ENTERED')
  const prepare     = (row, raw) => (raw ? row : sanitizeRow(row))

  function appendRows(token, title, rows, { raw = false } = {}) {
    const range = encodeURIComponent(a1(title, 'A1'))
    return googleFetch(
      token,
      `${baseUrl}/values/${range}:append?valueInputOption=${inputOption(raw)}&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: { values: rows.map(r => prepare(r, raw)) } },
    )
  }

  function updateRow(token, title, rowIndex, row) {
    const lastCol = colIndexToLetter(Math.max(row.length, 1))
    const range   = encodeURIComponent(a1(title, `A${rowIndex}:${lastCol}${rowIndex}`))
    return googleFetch(token, `${baseUrl}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body:   { values: [sanitizeRow(row)] },
    })
  }

  function updateRows(token, title, updates, { raw = false } = {}) {
    return googleFetch(token, `${baseUrl}/values:batchUpdate`, {
      method: 'POST',
      body: {
        valueInputOption: inputOption(raw),
        data: updates.map(({ rowIndex, values }) => ({
          range:  a1(title, `A${rowIndex}`),
          values: [prepare(values, raw)],
        })),
      },
    })
  }

  /** Deletes rows (1-based); contiguous rows go in one request, bottom-up so indices stay valid. */
  function deleteRows(token, sheetId, rowIndices) {
    return googleFetch(token, `${baseUrl}:batchUpdate`, {
      method: 'POST',
      body: {
        requests: contiguousRuns(rowIndices).map(([start, end]) => ({
          deleteDimension: {
            range: { sheetId, dimension: 'ROWS', startIndex: start - 1, endIndex: end },
          },
        })),
      },
    })
  }

  async function addTab(token, title) {
    const data = await googleFetch(token, `${baseUrl}:batchUpdate`, {
      method: 'POST',
      body:   { requests: [{ addSheet: { properties: { title } } }] },
    })
    tabsCache = null
    return data.replies[0].addSheet.properties.sheetId
  }

  /** cells: [{ range: 'Z5', value }] — written as-is (RAW), in one request. */
  function writeCells(token, title, cells) {
    return googleFetch(token, `${baseUrl}/values:batchUpdate`, {
      method: 'POST',
      body: {
        valueInputOption: 'RAW',
        data: cells.map(({ range, value }) => ({ range: a1(title, range), values: [[value]] })),
      },
    })
  }

  /** Writes `headers` into row 1 starting at 1-based column `startCol`. */
  function writeHeaderCells(token, title, startCol, headers) {
    const from  = colIndexToLetter(startCol)
    const to    = colIndexToLetter(startCol + headers.length - 1)
    const range = encodeURIComponent(a1(title, `${from}1:${to}1`))
    return googleFetch(token, `${baseUrl}/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body:   { values: [sanitizeRow(headers)] },
    })
  }

  return {
    getTabs, findTab, ensureColumnCount,
    readValues, assertRowsUnchanged,
    appendRows, updateRow, updateRows, deleteRows,
    addTab, writeCells, writeHeaderCells,
  }
}

// ── Main spreadsheet ──────────────────────────────────────────────────

export const mainSheet = spreadsheetClient(process.env.SHEET_ID)

export const {
  getTabs, findTab, ensureColumnCount,
  readValues, assertRowsUnchanged,
  appendRows, updateRow, updateRows, deleteRows,
  addTab, writeCells, writeHeaderCells,
} = mainSheet
