// services/sheetRecords.js
//
// Row-level operations behind /api/sheets. Every function checks that `user`
// may access the target tab before touching Google.
//
// Writes locate their row by the ID in column Z (see rowIds.js) and then
// verify the row still matches what the client last read (`expected`).

import * as sheets from './googleSheets.js'
import * as rowIds from './rowIds.js'
import { assertTabAccess, canCreateTab } from '../config/tabs.js'
import { HttpError } from '../middleware/errors.js'

async function resolveTabByTitle(token, user, title) {
  const { tab, tabs } = await sheets.findTab(token, { title })
  assertTabAccess(user, title, tabs)
  return tab
}

async function resolveTabById(token, user, sheetId) {
  const { tab, tabs } = await sheets.findTab(token, { sheetId })
  if (!tab) throw new HttpError(404, 'Sheet tab not found', 'TAB_NOT_FOUND')
  assertTabAccess(user, tab.title, tabs)
  return tab
}

/** Current positions of the referenced rows, after checking none changed. */
async function lockRows(token, title, refs) {
  const resolved = await rowIds.resolveRowRefs(token, title, refs)
  await sheets.assertRowsUnchanged(token, title, resolved)
  return resolved
}

async function readWithIds(token, title) {
  const values = await sheets.readValues(token, title)
  return rowIds.ensureRowIds(token, title, values)
}

/** Named tab, or the first tab when `tabName` is omitted / unknown. */
export async function readTabOrFirst(token, user, tabName) {
  let target = null
  let tabs
  if (tabName) ({ tab: target, tabs } = await sheets.findTab(token, { title: tabName }))
  else tabs = await sheets.getTabs(token)
  target ||= tabs[0]
  if (!target) throw new HttpError(404, 'Spreadsheet has no tabs', 'TAB_NOT_FOUND')

  assertTabAccess(user, target.title, tabs)
  const values = await readWithIds(token, target.title)
  return { values, sheetName: target.title, sheetId: target.sheetId }
}

/** sheetId is null (and values empty) when the tab hasn't been created yet. */
export async function readTab(token, user, tabName) {
  const tab = await resolveTabByTitle(token, user, tabName)
  if (!tab) return { values: [], tabName, sheetId: null }
  const values = await readWithIds(token, tab.title)
  return { values, tabName, sheetId: tab.sheetId }
}

export async function appendRows(token, user, tabName, rows) {
  await resolveTabByTitle(token, user, tabName)
  const withIds = await rowIds.hasIdColumn(token, tabName)
  return sheets.appendRows(token, tabName, withIds ? rows.map(rowIds.withNewId) : rows)
}

export async function updateRow(token, user, tabName, rowIndex, row, expected) {
  await resolveTabByTitle(token, user, tabName)
  const [target] = await lockRows(token, tabName, [{ rowIndex, expected }])
  const withIds = await rowIds.hasIdColumn(token, tabName)
  return sheets.updateRow(token, tabName, target.rowIndex, withIds ? rowIds.stripIdColumn(row) : row)
}

export async function updateRows(token, user, tabName, updates) {
  await resolveTabByTitle(token, user, tabName)
  const targets = await lockRows(token, tabName, updates)
  const withIds = await rowIds.hasIdColumn(token, tabName)
  await sheets.updateRows(token, tabName, targets.map(({ rowIndex, values }) => ({
    rowIndex,
    values: withIds ? rowIds.stripIdColumn(values) : values,
  })))
  return { updated: targets.length }
}

/** expectedByRow: { [rowIndex]: row[] } — optional per-row identity + staleness guard. */
export async function deleteRows(token, user, sheetId, rowIndices, expectedByRow = {}) {
  const tab  = await resolveTabById(token, user, sheetId)
  const refs = [...new Set(rowIndices)].map(rowIndex => ({ rowIndex, expected: expectedByRow[rowIndex] }))
  const targets = await lockRows(token, tab.title, refs)
  const rows = [...new Set(targets.map(t => t.rowIndex))]
  await sheets.deleteRows(token, sheetId, rows)
  return { deleted: rows.length }
}

/**
 * Creates the tab with `headers` if missing; otherwise adds any missing
 * headers after the last used column (never into the ID column).
 * `updated` tells the client whether row 1 changed.
 */
export async function ensureTab(token, user, tabName, headers) {
  const tab = await resolveTabByTitle(token, user, tabName)
  const wanted = headers.filter(h => h !== rowIds.ID_HEADER)

  if (tab) {
    const [currentRow = []] = await sheets.readValues(token, tabName, '1:1')
    const missing = wanted.filter(h => !currentRow.includes(h))
    if (missing.length > 0) {
      let lastUsed = -1
      currentRow.forEach((h, i) => { if (h && i < rowIds.ID_COL_INDEX) lastUsed = i })
      const startCol = lastUsed + 2
      if (startCol + missing.length - 1 > rowIds.ID_COL_INDEX) {
        throw new HttpError(500, `لا توجد أعمدة فاضية قبل عمود ID في "${tabName}"`, 'NO_FREE_COLUMNS')
      }
      await sheets.ensureColumnCount(token, tabName, startCol + missing.length - 1)
      await sheets.writeHeaderCells(token, tabName, startCol, missing)
    }
    return { created: false, updated: missing.length > 0, sheetId: tab.sheetId, tabName }
  }

  if (!canCreateTab(tabName)) {
    throw new HttpError(403, `غير مسموح بإنشاء التبويب "${tabName}"`, 'TAB_FORBIDDEN')
  }
  const sheetId = await sheets.addTab(token, tabName)
  await sheets.writeHeaderCells(token, tabName, 1, wanted)
  await sheets.writeHeaderCells(token, tabName, rowIds.ID_COL_INDEX + 1, [rowIds.ID_HEADER])
  return { created: true, updated: true, sheetId, tabName }
}
