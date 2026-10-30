// services/rowIds.js
//
// Stable row identity for data tabs. Every data row gets a unique ID in
// column Z (header "ID"). Writes locate their row by that ID, so inserting,
// deleting or sorting rows directly in Google Sheets can't make the app edit
// the wrong record. The ID travels inside the `expected` row the client sends.
//
// Rule for anyone editing the sheet by hand: never type in, clear or sort
// column Z on its own — sort whole rows only.

import { randomUUID } from 'crypto'
import * as sheets from './googleSheets.js'
import { HttpError } from '../middleware/errors.js'

export const ID_HEADER    = 'ID'
export const ID_COL_INDEX = 25            // column Z — every read covers A:Z
const ID_COL              = 'Z'
const ID_CACHE_TTL_MS     = 5 * 60 * 1000

const STALE_MESSAGE = 'السجل ده اتمسح أو اتغير من مستخدم تاني — تم تحديث القائمة، راجع وحاول مرة تانية'
const staleError = () => new HttpError(409, STALE_MESSAGE, 'STALE_ROWS')

const hasData = row => (row || []).slice(0, ID_COL_INDEX).some(v => String(v ?? '').trim() !== '')

function padToIdColumn(row) {
  while (row.length < ID_COL_INDEX) row.push('')
  return row
}

// title → { ready: boolean, at: timestamp }. ready=false when column Z holds other data.
const idColumnCache = new Map()

function remember(title, ready) {
  idColumnCache.set(title, { ready, at: Date.now() })
  return ready
}

/** True when the tab's Z1 header is "ID". */
export async function hasIdColumn(token, title) {
  const cached = idColumnCache.get(title)
  if (cached && Date.now() - cached.at < ID_CACHE_TTL_MS) return cached.ready
  const { tab } = await sheets.findTab(token, { title })
  if (tab && tab.columnCount <= ID_COL_INDEX) return remember(title, false)
  try {
    const [[z1] = []] = await sheets.readValues(token, title, `${ID_COL}1:${ID_COL}1`)
    return remember(title, z1 === ID_HEADER)
  } catch (err) {
    // Tab narrower than column Z — no ID column yet
    if (sheets.isOutsideGridError(err)) return remember(title, false)
    throw err
  }
}

/**
 * Gives every data row of a freshly read tab a unique ID (adding the header
 * if missing). Rows typed in by hand get one; a copy-pasted row's duplicate ID
 * is replaced. Mutates and returns `values`. Leaves the tab alone if column Z
 * already holds something else.
 */
export async function ensureRowIds(token, title, values) {
  const header = values[0]
  if (!header) return values

  const currentHeader = header[ID_COL_INDEX]
  if (currentHeader && currentHeader !== ID_HEADER) {
    console.warn(`[rowIds] column Z of "${title}" is "${currentHeader}" — row IDs disabled for this tab`)
    remember(title, false)
    return values
  }

  const cells = []
  if (currentHeader !== ID_HEADER) {
    padToIdColumn(header)[ID_COL_INDEX] = ID_HEADER
    cells.push({ range: `${ID_COL}1`, value: ID_HEADER })
  }

  const seen = new Set()
  for (let i = 1; i < values.length; i++) {
    const row = values[i]
    if (!hasData(row)) continue
    const id = row[ID_COL_INDEX]
    if (id && !seen.has(id)) { seen.add(id); continue }

    const freshId = randomUUID()
    padToIdColumn(row)[ID_COL_INDEX] = freshId
    seen.add(freshId)
    cells.push({ range: `${ID_COL}${i + 1}`, value: freshId })
  }

  if (cells.length) {
    await sheets.ensureColumnCount(token, title, ID_COL_INDEX + 1)
    await sheets.writeCells(token, title, cells)
  }
  remember(title, true)
  return values
}

/** Client rows never write column Z; appended rows get a new ID there. */
export function stripIdColumn(row) {
  return row.slice(0, ID_COL_INDEX)
}

export function withNewId(row) {
  // Leading apostrophe: stored as text, never parsed as a number/date by USER_ENTERED
  return [...padToIdColumn(stripIdColumn(row)), `'${randomUUID()}`]
}

/**
 * refs: [{ rowIndex, expected }]. For refs whose `expected` row carries an ID,
 * returns the row's CURRENT position (it may have moved). Throws 409 if that
 * record no longer exists. Refs without an ID keep their rowIndex.
 */
export async function resolveRowRefs(token, title, refs) {
  const idOf = ref => (Array.isArray(ref.expected) ? ref.expected[ID_COL_INDEX] : '') || ''
  if (!refs.some(idOf)) return refs

  let column
  try {
    column = await sheets.readValues(token, title, `${ID_COL}:${ID_COL}`)
  } catch (err) {
    if (sheets.isOutsideGridError(err)) return refs
    throw err
  }
  if (column[0]?.[0] !== ID_HEADER) return refs

  const rowsById = new Map()
  column.forEach((cell, i) => {
    const id = cell?.[0]
    if (i === 0 || !id) return
    if (!rowsById.has(id)) rowsById.set(id, [])
    rowsById.get(id).push(i + 1)
  })

  return refs.map(ref => {
    const id = idOf(ref)
    if (!id) return ref
    const matches = rowsById.get(id)
    if (!matches) throw staleError()
    return { ...ref, rowIndex: matches.includes(ref.rowIndex) ? ref.rowIndex : matches[0] }
  })
}
