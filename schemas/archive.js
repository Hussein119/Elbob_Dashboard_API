// schemas/archive.js — request shapes for /api/archive and /api/sheets/archive

import { z } from 'zod'

const tabName = z.string().trim().min(1).max(100)

export const archivedRowsQuery = z.object({
  tabName,
  year:      z.coerce.number().int().min(2000).max(2100).optional(),
  yearsOnly: z.enum(['1', 'true']).optional().transform(Boolean),
})

export const runQuery = z.object({
  dryRun: z.enum(['1', 'true', '0', 'false']).optional().transform(v => v === '1' || v === 'true'),
})

export const restoreBody = z.object({
  tabName,
  ids: z.array(z.string().trim().min(1).max(100)).min(1).max(2000),
})
