// controllers/sheetsController.js — req/res only; logic lives in services/sheetRecords.js

import { getRequestToken } from '../services/googleSheets.js'
import * as records from '../services/sheetRecords.js'

export async function getData(req, res) {
  const token = await getRequestToken(req)
  res.json(await records.readTabOrFirst(token, req.user, req.valid.query.tabName))
}

export async function getTabData(req, res) {
  const token = await getRequestToken(req)
  res.json(await records.readTab(token, req.user, req.valid.query.tabName))
}

export async function append(req, res) {
  const token = await getRequestToken(req)
  const { sheetName, values } = req.valid.body
  res.json(await records.appendRows(token, req.user, sheetName, values))
}

export async function updateRow(req, res) {
  const token = await getRequestToken(req)
  const { sheetName, values, expected } = req.valid.body
  res.json(await records.updateRow(token, req.user, sheetName, req.valid.params.rowIndex, values[0], expected))
}

export async function deleteRow(req, res) {
  const token = await getRequestToken(req)
  const { rowIndex } = req.valid.params
  const { expected } = req.valid.body
  res.json(await records.deleteRows(token, req.user, req.valid.query.sheetId, [rowIndex], { [rowIndex]: expected }))
}

export async function ensureTab(req, res) {
  const token = await getRequestToken(req)
  const { tabName, headers } = req.valid.body
  res.json(await records.ensureTab(token, req.user, tabName, headers))
}

export async function batchRows(req, res) {
  const token = await getRequestToken(req)
  const { sheetName, updates } = req.valid.body
  res.json(await records.updateRows(token, req.user, sheetName, updates))
}

export async function batchDelete(req, res) {
  const token = await getRequestToken(req)
  const { sheetId, rowIndices, expected } = req.valid.body
  res.json(await records.deleteRows(token, req.user, sheetId, rowIndices, expected))
}
