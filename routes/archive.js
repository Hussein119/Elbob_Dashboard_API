// routes/archive.js — archive job (cron / admin) and restore. Reading archived
// rows for the app lives in routes/sheets.js (GET /api/sheets/archive).

import { Router }         from 'express'
import { requireAuth, requireAdmin, requireCronOrAdmin } from '../middleware/auth.js'
import { ensureJsonBody } from '../middleware/jsonBody.js'
import { validate }       from '../middleware/validate.js'
import { asyncHandler }   from '../middleware/errors.js'
import * as schemas       from '../schemas/archive.js'
import * as archive       from '../controllers/archiveController.js'

const router = Router()

// GET /api/archive/run[?dryRun=1] — Vercel Cron (Bearer CRON_SECRET) or an admin
router.get('/run', requireCronOrAdmin, validate({ query: schemas.runQuery }), asyncHandler(archive.run))

// GET /api/archive/log — recent runs from the archive log tab
router.get('/log', requireAuth, requireAdmin, asyncHandler(archive.log))

// POST /api/archive/restore  { tabName, ids[] } — move records back to the main sheet
router.post('/restore', requireAuth, requireAdmin, ensureJsonBody,
  validate({ body: schemas.restoreBody }), asyncHandler(archive.restore))

export default router
