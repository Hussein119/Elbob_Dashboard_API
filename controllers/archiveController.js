// controllers/archiveController.js — req/res only; logic lives in services/archive.js

import { getRequestToken } from '../services/googleSheets.js'
import * as archive from '../services/archive.js'

export async function getArchivedRows(req, res) {
  const token = await getRequestToken(req)
  const { tabName, year, yearsOnly } = req.valid.query
  res.json(await archive.getArchivedRows(token, req.user, tabName, { year, yearsOnly }))
}

export async function run(req, res) {
  const token = await getRequestToken(req)
  const { dryRun } = req.valid.query
  // A dry run only reads, so it always covers everything that is due
  const options = dryRun ? { dryRun, maxRows: Infinity, timeBudgetMs: Infinity } : {}
  res.json(await archive.runArchive(token, options))
}

export async function log(req, res) {
  const token = await getRequestToken(req)
  res.json(await archive.readLog(token))
}

export async function restore(req, res) {
  const token = await getRequestToken(req)
  const { tabName, ids } = req.valid.body
  res.json(await archive.restoreRows(token, tabName, ids))
}
