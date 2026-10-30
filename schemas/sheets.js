// schemas/sheets.js — request shapes for /api/sheets

import { z } from 'zod'

const MAX_COLUMNS = 52
const MAX_ROWS    = 5000

const tabName  = z.string().trim().min(1).max(100)
const rowIndex = z.coerce.number().int().min(2)
const sheetId  = z.coerce.number().int().min(0)
const cell     = z.union([z.string().max(50_000), z.number().finite(), z.boolean(), z.null()])
const row      = z.array(cell).max(MAX_COLUMNS)

export const dataQuery    = z.object({ tabName: tabName.optional() })
export const tabDataQuery = z.object({ tabName })
export const rowParams    = z.object({ rowIndex })
export const deleteQuery  = z.object({ sheetId })

export const appendBody = z.object({
  sheetName: tabName,
  values:    z.array(row).min(1).max(MAX_ROWS),
})

export const updateRowBody = z.object({
  sheetName: tabName,
  values:    z.array(row).length(1),
  expected:  row.optional(),
})

export const deleteRowBody = z.object({
  expected: row.optional(),
})

export const ensureTabBody = z.object({
  tabName,
  // Blank cells come from gaps in an existing header row; the service skips them
  headers: z.array(z.string().trim().max(200))
    .transform(list => list.filter(Boolean))
    .pipe(z.array(z.string()).min(1).max(MAX_COLUMNS)),
})

export const batchRowsBody = z.object({
  sheetName: tabName,
  updates: z.array(z.object({
    rowIndex,
    values:   row,
    expected: row.optional(),
  })).min(1).max(MAX_ROWS),
})

export const batchDeleteBody = z.object({
  sheetId,
  rowIndices: z.array(rowIndex).min(1).max(MAX_ROWS),
  expected:   z.record(z.string(), row).optional(),
})
