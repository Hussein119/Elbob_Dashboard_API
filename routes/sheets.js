// routes/sheets.js
//
// All Google Sheets access is proxied here — the frontend never talks to Google.
// Tab access rules: config/tabs.js. Row writes accept an optional `expected`
// copy of the row as last read; the write is rejected with 409 STALE_ROWS if
// someone else changed or removed that row meanwhile.

import { Router }         from 'express'
import { requireAuth }    from '../middleware/auth.js'
import { ensureJsonBody } from '../middleware/jsonBody.js'
import { validate }       from '../middleware/validate.js'
import { asyncHandler }   from '../middleware/errors.js'
import * as schemas       from '../schemas/sheets.js'
import * as archiveSchemas from '../schemas/archive.js'
import * as sheets        from '../controllers/sheetsController.js'
import * as archive       from '../controllers/archiveController.js'

const router = Router()

router.use(requireAuth, ensureJsonBody)

// GET /api/sheets/data?tabName=...  — named tab, or the first tab
router.get('/data', validate({ query: schemas.dataQuery }), asyncHandler(sheets.getData))

// GET /api/sheets/tab-data?tabName=...  — { values, tabName, sheetId | null }
router.get('/tab-data', validate({ query: schemas.tabDataQuery }), asyncHandler(sheets.getTabData))

// GET /api/sheets/archive?tabName=...&year=2024  — read-only archived rows + { years }
router.get('/archive', validate({ query: archiveSchemas.archivedRowsQuery }), asyncHandler(archive.getArchivedRows))

// POST /api/sheets/append  { sheetName, values: [[...]] }
router.post('/append', validate({ body: schemas.appendBody }), asyncHandler(sheets.append))

// PUT /api/sheets/row/:rowIndex  { sheetName, values: [[...]], expected? }
router.put('/row/:rowIndex',
  validate({ params: schemas.rowParams, body: schemas.updateRowBody }),
  asyncHandler(sheets.updateRow))

// DELETE /api/sheets/row/:rowIndex?sheetId=0  { expected? }
router.delete('/row/:rowIndex',
  validate({ params: schemas.rowParams, query: schemas.deleteQuery, body: schemas.deleteRowBody }),
  asyncHandler(sheets.deleteRow))

// POST /api/sheets/ensure-tab  { tabName, headers }  → { created, updated, sheetId, tabName }
router.post('/ensure-tab', validate({ body: schemas.ensureTabBody }), asyncHandler(sheets.ensureTab))

// POST /api/sheets/batch-rows  { sheetName, updates: [{ rowIndex, values, expected? }] }
router.post('/batch-rows', validate({ body: schemas.batchRowsBody }), asyncHandler(sheets.batchRows))

// POST /api/sheets/batch-delete  { sheetId, rowIndices, expected?: { [rowIndex]: [...] } }
router.post('/batch-delete', validate({ body: schemas.batchDeleteBody }), asyncHandler(sheets.batchDelete))

export default router
