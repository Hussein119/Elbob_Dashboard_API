// services/archive.js
//
// Moves rows older than ARCHIVE_AFTER_MONTHS (default 12, whole months) from
// the main spreadsheet to the archive spreadsheet (ARCHIVE_SHEET_ID), keeping
// each row's column-Z ID. Order per tab: copy → verify → delete, so a crash can
// leave a row in both sheets but never in neither; re-running is safe.
//
// Never archived: open records (money still owed), rows with an unreadable
// date, and an invoice / dashboard order whose partner must stay.

import { randomUUID } from 'crypto'
import { mainSheet, spreadsheetClient, rowsEqual, isOutsideGridError } from './googleSheets.js'
import * as rowIds from './rowIds.js'
import { assertTabAccess, findConfiguredTab } from '../config/tabs.js'
import { HttpError } from '../middleware/errors.js'
import { parseSheetDate, monthIndex, archiveCutoff, monthKey } from '../utils/dates.js'

const KEEP_MONTHS    = Number(process.env.ARCHIVE_AFTER_MONTHS) || 12
// One run = one batch, sized to finish inside a Vercel function; "run now" and
// the nightly cron repeat batches until nothing is left (report.pending).
const BATCH_ROWS     = Number(process.env.ARCHIVE_BATCH_ROWS) || 1000
const TIME_BUDGET_MS = Number(process.env.ARCHIVE_TIME_BUDGET_MS) || 25_000
const LOG_TAB        = 'سجل الأرشفة'
const LOCK_TAB       = 'قفل الأرشفة'
const LOCK_TTL_MS    = 15 * 60 * 1000
const READ_CACHE_MS  = 5 * 60 * 1000
const INVOICES_TAB   = 'فواتير الجملة'
const ID             = rowIds.ID_COL_INDEX
const ROW_WIDTH      = ID + 1
const SAME_SAVE_MS   = 2 * 60 * 1000

const LOG_HEADERS = [
  'وقت التشغيل', 'النوع', 'التبويب', 'أقدم شهر باقي', 'اتنقل', 'بقي مفتوح',
  'بقي تاريخ غير مقروء', 'بقي مرتبط', 'اتعدل أثناء التشغيل', 'باقي للمرة الجاية',
  'المدة (ث)', 'الحالة', 'ملاحظات', 'أحدث من سنة', 'أسباب البقاء مفتوح',
]

const formatReasons = reasons =>
  Object.entries(reasons || {}).map(([reason, n]) => `${reason}: ${n}`).join(' · ')

// Tabs archived on their own. The dashboard (first tab) and invoices are handled together.
const SIMPLE_TABS = [
  { title: 'المصروفات',        date: 'التاريخ', money: 'المبلغ' },
  { title: 'الرواتب والتوزيع', date: 'الشهر',   money: 'المبلغ' },
  { title: 'مشتريات بضاعة',    date: 'التاريخ', money: 'الاجمالي' },
  { title: 'عروض الأسعار',     date: 'التاريخ', money: 'الاجمالي' },
  { title: 'حسابات الدائنين',  date: 'التاريخ', money: 'المبلغ', openWhen: { header: 'الحالة', closedValue: 'تم السداد' } },
]

// ── Archive spreadsheet client ────────────────────────────────────────

let archiveClient = null
export const isArchiveConfigured = () => !!process.env.ARCHIVE_SHEET_ID

function archiveSheet() {
  if (!isArchiveConfigured()) {
    throw new HttpError(503, 'الأرشيف غير مُعد — ضيف ARCHIVE_SHEET_ID', 'ARCHIVE_NOT_CONFIGURED')
  }
  archiveClient ??= spreadsheetClient(process.env.ARCHIVE_SHEET_ID)
  return archiveClient
}

// ── Column detection ──────────────────────────────────────────────────

const norm    = v => String(v ?? '').trim()
const lower   = h => norm(h).toLowerCase()
const has     = (h, ...words) => words.some(w => norm(h).includes(w))
const num     = v => parseFloat(String(v ?? '').replace(/,/g, '')) || 0
const isPhone = h => has(h, 'رقم', 'هاتف', 'فون') || lower(h).includes('phone') || lower(h).includes('mobile')
const AUDIT_DATE_HEADERS = ['تاريخ الإنشاء', 'تاريخ التعديل']

function ordersColumns(headers) {
  const find = test => headers.findIndex(h => h && test(h))
  return {
    date:      find(h => (has(h, 'تاريخ') || lower(h).includes('date')) && !AUDIT_DATE_HEADERS.includes(norm(h))),
    status:    find(h => has(h, 'حالة') || lower(h).includes('status')),
    deferred:  find(h => has(h, 'مؤخر') || lower(h).includes('deferred')),
    client:    find(h => (has(h, 'عميل') || lower(h).includes('client')) && !isPhone(h)),
    task:      find(h => has(h, 'مطلوب') || lower(h).includes('task') || lower(h).includes('project')),
    money:     find(h => (has(h, 'اجمالي', 'إجمالي') || lower(h).includes('total')) && !has(h, 'تكلفة', 'ربح')),
    createdOn: headers.indexOf('تاريخ الإنشاء'),
  }
}

/** { date, money } column indexes for any archivable tab. */
function tabColumns(title, headers, ordersTitle) {
  if (title === ordersTitle) return ordersColumns(headers)
  if (title === INVOICES_TAB) return { date: headers.indexOf('التاريخ'), money: headers.indexOf('اجمالي الصنف') }
  const rule = SIMPLE_TABS.find(r => r.title === title)
  return rule ? { date: headers.indexOf(rule.date), money: headers.indexOf(rule.money) } : { date: -1, money: -1 }
}

const hasData = row => (row || []).slice(0, ID).some(v => norm(v) !== '')

/** 'empty' | 'badDate' | 'recent' | 'old' */
function classify(row, dateCol, cutoffIdx) {
  if (!hasData(row)) return 'empty'
  const date = dateCol >= 0 ? parseSheetDate(row[dateCol]) : null
  if (!date) return 'badDate'
  return monthIndex(date) < cutoffIdx ? 'old' : 'recent'
}

// ── Planning (no writes) ──────────────────────────────────────────────

function emptyCounts() {
  return { total: 0, move: 0, keptOpen: 0, keptBadDate: 0, keptLinked: 0, recent: 0, remaining: 0, byYear: {}, openReasons: {} }
}

const PAID = 'تم الدفع'

/**
 * Why an order / invoice row must stay in the main sheet, or null if it may
 * be archived. "تم الدفع" is trusted as paid even when مؤخر was never reset
 * (the status button doesn't touch it). A blank status counts as paid only
 * when nothing is deferred; any other status (unpaid, debt, …) stays.
 */
function openReason(status, deferred) {
  if (status === PAID) return null
  if (status === '')   return deferred > 0 ? 'حالة فاضية + مؤخر' : null
  return status
}

function countOpen(counts, reason, n = 1) {
  counts.keptOpen += n
  counts.openReasons[reason] = (counts.openReasons[reason] || 0) + n
}

function countMove(counts, row, dateCol) {
  counts.move++
  const year = parseSheetDate(row[dateCol])?.year
  counts.byYear[year] = (counts.byYear[year] || 0) + 1
}

function planSimpleTab(values, rule, cutoffIdx, maxRows) {
  const headers = values[0] || []
  const dateCol = headers.indexOf(rule.date)
  const openCol = rule.openWhen ? headers.indexOf(rule.openWhen.header) : -1
  const counts  = emptyCounts()
  const move    = []

  for (let i = 1; i < values.length; i++) {
    const row = values[i]
    const cls = classify(row, dateCol, cutoffIdx)
    if (cls === 'empty') continue
    counts.total++
    if (cls === 'badDate') { counts.keptBadDate++; continue }
    if (cls === 'recent')  { counts.recent++; continue }
    if (openCol >= 0 && norm(row[openCol]) !== rule.openWhen.closedValue) { countOpen(counts, norm(row[openCol]) || 'حالة فاضية'); continue }
    if (move.length >= maxRows) { counts.remaining++; continue }
    move.push({ rowIndex: i + 1, row })
    countMove(counts, row, dateCol)
  }
  return { move, counts }
}

/**
 * Dashboard orders + invoice rows. An invoice (its rows share date + client +
 * name) and the dashboard order(s) it created move together or not at all.
 */
function planOrdersAndInvoices(orderValues, invoiceValues, cutoffIdx, maxRows) {
  const oHeaders = orderValues[0] || []
  const oc = ordersColumns(oHeaders)
  const orders = []
  for (let i = 1; i < orderValues.length; i++) {
    const row = orderValues[i]
    const cls = classify(row, oc.date, cutoffIdx)
    if (cls === 'empty') continue
    const status = oc.status >= 0 ? norm(row[oc.status]) : ''
    const reason = openReason(status, oc.deferred >= 0 ? num(row[oc.deferred]) : 0)
    orders.push({
      rowIndex: i + 1, row, cls, reason,
      open:   reason !== null,
      client: norm(row[oc.client]), task: norm(row[oc.task]),
      date:   parseSheetDate(row[oc.date]),
      createdAt: oc.createdOn >= 0 ? Date.parse(row[oc.createdOn] || '') : NaN,
    })
  }

  const iHeaders = invoiceValues[0] || []
  const ic = {
    date: iHeaders.indexOf('التاريخ'), client: iHeaders.indexOf('اسم العميل'),
    name: iHeaders.indexOf('اسم الفاتورة'), status: iHeaders.indexOf('حالة'),
    deferred: iHeaders.indexOf('مؤخر'), createdOn: iHeaders.indexOf('تاريخ الإنشاء'),
  }
  const groups = new Map()
  for (let i = 1; i < invoiceValues.length; i++) {
    const row = invoiceValues[i]
    const cls = classify(row, ic.date, cutoffIdx)
    if (cls === 'empty') continue
    const key = [norm(row[ic.date]), norm(row[ic.client]), norm(row[ic.name])].join('__')
    if (!groups.has(key)) {
      groups.set(key, {
        rows: [], cls: 'old', open: false, reason: null,
        client: norm(row[ic.client]), name: norm(row[ic.name]), date: parseSheetDate(row[ic.date]),
        createdAt: ic.createdOn >= 0 ? Date.parse(row[ic.createdOn] || '') : NaN,
      })
    }
    const g = groups.get(key)
    g.rows.push({ rowIndex: i + 1, row })
    if (cls === 'badDate' || g.cls === 'badDate') g.cls = 'badDate'
    else if (cls === 'recent') g.cls = 'recent'
    const reason = openReason(
      ic.status >= 0 ? norm(row[ic.status]) : '',
      ic.deferred >= 0 ? num(row[ic.deferred]) : 0,
    )
    if (reason) { g.open = true; g.reason ??= reason }
  }

  const sameDay = (a, b) => a && b && a.year === b.year && a.month === b.month && a.day === b.day
  const linkedOrders = g => orders.filter(o =>
    o.client === g.client && o.task === g.name &&
    (sameDay(o.date, g.date) || Math.abs(o.createdAt - g.createdAt) < SAME_SAVE_MS))
  const movable = x => x.cls === 'old' && !x.open

  const groupList = [...groups.values()].map(g => ({ ...g, linked: linkedOrders(g) }))
  // An order linked to any invoice that must stay, stays — and so do that order's other invoices
  const blockedOrders = new Set()
  for (const g of groupList) {
    if (!movable(g) || !g.linked.every(movable)) g.linked.forEach(o => blockedOrders.add(o))
  }

  const invoiceCounts = emptyCounts()
  const orderCounts   = emptyCounts()
  const invoiceMove   = []
  const orderMove     = new Map()   // rowIndex → { rowIndex, row }
  const handledOrders = new Set()
  let movedRows = 0

  for (const g of groupList) {
    g.linked.forEach(o => handledOrders.add(o))
    invoiceCounts.total += g.rows.length
    if (g.cls === 'badDate') { invoiceCounts.keptBadDate += g.rows.length; continue }
    if (g.cls === 'recent')  { invoiceCounts.recent += g.rows.length; continue }
    if (g.open)              { countOpen(invoiceCounts, g.reason, g.rows.length); continue }
    if (g.linked.some(o => blockedOrders.has(o))) { invoiceCounts.keptLinked += g.rows.length; continue }
    if (movedRows >= maxRows) { invoiceCounts.remaining += g.rows.length; continue }

    g.rows.forEach(r => { invoiceMove.push(r); countMove(invoiceCounts, r.row, ic.date) })
    g.linked.forEach(o => orderMove.set(o.rowIndex, { rowIndex: o.rowIndex, row: o.row }))
    movedRows += g.rows.length + g.linked.length
  }

  for (const o of orders) {
    orderCounts.total++
    if (orderMove.has(o.rowIndex)) { countMove(orderCounts, o.row, oc.date); continue }
    if (o.cls === 'badDate') { orderCounts.keptBadDate++; continue }
    if (o.cls === 'recent')  { orderCounts.recent++; continue }
    if (o.open)              { countOpen(orderCounts, o.reason); continue }
    if (handledOrders.has(o)) { orderCounts.keptLinked++; continue }
    if (movedRows >= maxRows) { orderCounts.remaining++; continue }
    orderMove.set(o.rowIndex, { rowIndex: o.rowIndex, row: o.row })
    countMove(orderCounts, o.row, oc.date)
    movedRows++
  }

  return {
    invoices: { move: invoiceMove, counts: invoiceCounts },
    orders:   { move: [...orderMove.values()], counts: orderCounts },
  }
}

// ── Writing to the archive ────────────────────────────────────────────

// Numbers stay numbers; everything else (dates, phones with leading 0, IDs) is stored as text
const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/
function toEnteredCell(value) {
  const s = String(value ?? '')
  if (s === '' || PLAIN_NUMBER.test(s)) return s
  return `'${s}`
}

function toEnteredRow(row) {
  const out = [...(row || [])]
  while (out.length < ROW_WIDTH) out.push('')
  return out.slice(0, ROW_WIDTH).map(toEnteredCell)
}

/** Map<id, rowIndex> from a tab's ID column (empty when the tab is narrower than Z). */
async function readIdColumn(client, token, title) {
  let column = []
  try {
    column = await client.readValues(token, title, 'Z:Z')
  } catch (err) {
    if (!isOutsideGridError(err)) throw err
  }
  const ids = new Map()
  column.forEach((cell, i) => { if (i > 0 && cell?.[0]) ids.set(cell[0], i + 1) })
  return ids
}

async function ensureTabWithHeader(client, token, title, header) {
  const { tab } = await client.findTab(token, { title })
  if (!tab) {
    await client.addTab(token, title)
    await client.ensureColumnCount(token, title, ROW_WIDTH)
    await client.updateRows(token, title, [{ rowIndex: 1, values: toEnteredRow(header) }])
    return
  }
  const [current = []] = await client.readValues(token, title, '1:1')
  const compatible = current.every((h, i) => !h || h === header[i])
  if (!compatible) {
    throw new HttpError(409, `أعمدة "${title}" في الأرشيف مختلفة عن الشيت الأساسي — راجعها يدوياً`, 'ARCHIVE_HEADERS_MISMATCH')
  }
  if (!rowsEqual(current, header)) {
    await client.ensureColumnCount(token, title, ROW_WIDTH)
    await client.updateRows(token, title, [{ rowIndex: 1, values: toEnteredRow(header) }])
  }
}

/** Copies rows (upsert by ID) and verifies every ID landed. */
async function copyToArchive(token, title, header, rows) {
  const archive = archiveSheet()
  await ensureTabWithHeader(archive, token, title, header)
  const existing = await readIdColumn(archive, token, title)

  const updates = []
  const appends = []
  for (const { row } of rows) {
    const at = existing.get(row[ID])
    if (at) updates.push({ rowIndex: at, values: toEnteredRow(row) })
    else appends.push(toEnteredRow(row))
  }
  if (updates.length) await archive.updateRows(token, title, updates)
  if (appends.length) await archive.appendRows(token, title, appends)

  const after = await readIdColumn(archive, token, title)
  const missing = rows.filter(r => !after.has(r.row[ID]))
  if (missing.length) {
    throw new HttpError(500, `فشل التحقق من نسخ ${missing.length} صف إلى أرشيف "${title}" — لم يتم حذف شيء`, 'ARCHIVE_VERIFY_FAILED')
  }
  return after
}

/** Deletes the copied rows from main — only those still identical to what was copied. */
async function deleteFromMain(token, tab, copiedRows) {
  const fresh = await mainSheet.readValues(token, tab.title)
  const byId = new Map()
  fresh.forEach((row, i) => { if (i > 0 && row[ID]) byId.set(row[ID], { rowIndex: i + 1, row }) })

  const toDelete = []
  const changed  = []
  for (const { row } of copiedRows) {
    const current = byId.get(row[ID])
    if (!current) continue
    if (rowsEqual(current.row, row)) toDelete.push(current.rowIndex)
    else changed.push(row[ID])
  }
  if (toDelete.length) await mainSheet.deleteRows(token, tab.sheetId, toDelete)
  return { deleted: toDelete.length, changed }
}

/** Removes archive copies of rows that were edited during the run (they stay in main). */
async function undoArchiveCopies(token, title, ids) {
  if (!ids.length) return
  const archive = archiveSheet()
  const { tab } = await archive.findTab(token, { title })
  const positions = await readIdColumn(archive, token, title)
  const rows = ids.map(id => positions.get(id)).filter(Boolean)
  if (tab && rows.length) await archive.deleteRows(token, tab.sheetId, rows)
}

async function moveRows(token, tab, header, rows) {
  if (!rows.length) return { moved: 0, changed: 0 }
  await copyToArchive(token, tab.title, header, rows)
  const { deleted, changed } = await deleteFromMain(token, tab, rows)
  await undoArchiveCopies(token, tab.title, changed)
  readCache.delete(tab.title)
  return { moved: deleted, changed: changed.length }
}

// ── Lock + log ────────────────────────────────────────────────────────

async function ensureSimpleTab(client, token, title, headers) {
  const { tab } = await client.findTab(token, { title })
  if (tab) return
  await client.addTab(token, title)
  if (headers) await client.updateRows(token, title, [{ rowIndex: 1, values: headers.map(toEnteredCell) }])
}

const lockedError = () => new HttpError(409, 'فيه عملية أرشفة شغالة حالياً — حاول بعد شوية', 'ARCHIVE_LOCKED')

async function acquireLock(token) {
  const archive = archiveSheet()
  await ensureSimpleTab(archive, token, LOCK_TAB)
  const [[current] = []] = await archive.readValues(token, LOCK_TAB, 'A1:A1')
  if (current) {
    const lockedAt = Date.parse(String(current).split('|')[1])
    if (!isNaN(lockedAt) && Date.now() - lockedAt < LOCK_TTL_MS) throw lockedError()
  }
  const mine = `${randomUUID()}|${new Date().toISOString()}`
  await archive.writeCells(token, LOCK_TAB, [{ range: 'A1', value: mine }])
  const [[check] = []] = await archive.readValues(token, LOCK_TAB, 'A1:A1')
  if (check !== mine) throw lockedError()
}

async function releaseLock(token) {
  await archiveSheet().writeCells(token, LOCK_TAB, [{ range: 'A1', value: '' }])
}

async function writeLog(token, report) {
  const archive = archiveSheet()
  await ensureSimpleTab(archive, token, LOG_TAB, LOG_HEADERS)
  // Log tabs created by an older version have fewer columns — upgrade the header row
  const [currentHeaders = []] = await archive.readValues(token, LOG_TAB, '1:1')
  if (!rowsEqual(currentHeaders, LOG_HEADERS)) {
    await archive.updateRows(token, LOG_TAB, [{ rowIndex: 1, values: LOG_HEADERS.map(toEnteredCell) }])
  }
  const seconds = Math.round(report.durationMs / 1000)
  const kind = report.dryRun ? 'تجربة' : 'تشغيل'
  const rows = report.tabs.map(t => [
    report.startedAt, kind, t.tab, report.cutoff,
    t.moved ?? 0, t.keptOpen ?? 0, t.keptBadDate ?? 0, t.keptLinked ?? 0,
    t.changedDuringRun ?? 0, t.remaining ?? 0, seconds,
    t.error ? 'خطأ' : t.skipped ? 'اتأجل' : 'تم', t.error || t.skipped || '',
    t.recent ?? 0, formatReasons(t.openReasons),
  ])
  if (report.error) rows.push([report.startedAt, kind, '—', report.cutoff, 0, 0, 0, 0, 0, 0, seconds, 'خطأ', report.error, 0, ''])
  if (rows.length) await archive.appendRows(token, LOG_TAB, rows.map(r => r.map(toEnteredCell)))
}

export async function readLog(token, limit = 100) {
  if (!isArchiveConfigured()) return { configured: false, rows: [] }
  const archive = archiveSheet()
  const { tab } = await archive.findTab(token, { title: LOG_TAB })
  if (!tab) return { configured: true, rows: [] }
  const values = await archive.readValues(token, LOG_TAB, 'A:O')
  const [headers = LOG_HEADERS, ...rows] = values
  return { configured: true, headers, rows: rows.slice(-limit).reverse() }
}

// ── Run ───────────────────────────────────────────────────────────────

async function readMainTab(token, title, dryRun) {
  const values = await mainSheet.readValues(token, title)
  // A real run needs every row to have an ID; a dry run must not write anything
  if (!dryRun) await rowIds.ensureRowIds(token, title, values)
  return values
}

function summarize(tab, counts, result = {}) {
  return {
    tab,
    total:            counts.total,
    willMove:         counts.move,
    moved:            result.moved,
    keptOpen:         counts.keptOpen,
    keptBadDate:      counts.keptBadDate,
    keptLinked:       counts.keptLinked,
    recent:           counts.recent,
    remaining:        counts.remaining,
    changedDuringRun: result.changed,
    byYear:           counts.byYear,
    openReasons:      counts.openReasons,
  }
}

/**
 * options: { dryRun, maxRows, timeBudgetMs, now }
 * Returns a report per tab. A real run takes the lock and writes to the log.
 */
export async function runArchive(token, { dryRun = false, maxRows = BATCH_ROWS, timeBudgetMs = TIME_BUDGET_MS, now = new Date() } = {}) {
  archiveSheet()   // fail fast when not configured
  const startedAt = new Date()
  const cutoff    = archiveCutoff(KEEP_MONTHS, now)
  const cutoffIdx = monthIndex(cutoff)
  const report = { dryRun, cutoff: monthKey(cutoff), keepMonths: KEEP_MONTHS, startedAt: startedAt.toISOString(), tabs: [] }
  const outOfTime = () => Date.now() - startedAt.getTime() > timeBudgetMs

  if (!dryRun) await acquireLock(token)
  try {
    const tabs = await mainSheet.getTabs(token, { fresh: true })
    const ordersTab = tabs[0]

    for (const rule of SIMPLE_TABS) {
      const tab = tabs.find(t => t.title === rule.title)
      if (!tab) continue
      if (outOfTime()) { report.tabs.push({ tab: rule.title, skipped: 'الوقت خلص — هيكمل في المرة الجاية' }); continue }
      try {
        const values = await readMainTab(token, tab.title, dryRun)
        const plan = planSimpleTab(values, rule, cutoffIdx, maxRows)
        const result = dryRun ? {} : await moveRows(token, tab, values[0], plan.move)
        report.tabs.push(summarize(tab.title, plan.counts, result))
      } catch (err) {
        report.tabs.push({ tab: rule.title, error: err.message })
      }
    }

    const invoicesTab = tabs.find(t => t.title === INVOICES_TAB)
    if (ordersTab && !outOfTime()) {
      try {
        const orderValues   = await readMainTab(token, ordersTab.title, dryRun)
        const invoiceValues = invoicesTab ? await readMainTab(token, invoicesTab.title, dryRun) : []
        const plan = planOrdersAndInvoices(orderValues, invoiceValues, cutoffIdx, maxRows)
        const invoiceResult = dryRun || !invoicesTab ? {} : await moveRows(token, invoicesTab, invoiceValues[0], plan.invoices.move)
        const orderResult   = dryRun ? {} : await moveRows(token, ordersTab, orderValues[0], plan.orders.move)
        if (invoicesTab) report.tabs.push(summarize(invoicesTab.title, plan.invoices.counts, invoiceResult))
        report.tabs.push(summarize(ordersTab.title, plan.orders.counts, orderResult))
      } catch (err) {
        report.tabs.push({ tab: `${ordersTab.title} + ${INVOICES_TAB}`, error: err.message })
      }
    } else if (ordersTab) {
      report.tabs.push({ tab: ordersTab.title, skipped: 'الوقت خلص — هيكمل في المرة الجاية' })
    }
  } catch (err) {
    report.error = err.message
  } finally {
    report.durationMs = Date.now() - startedAt.getTime()
    // More rows are due than this batch handled — call again to continue
    report.pending = !report.error && report.tabs.some(t => t.skipped || (t.remaining ?? 0) > 0)
    if (!dryRun) {
      await writeLog(token, report).catch(err => console.error('[archive] log failed:', err.message))
      await releaseLock(token).catch(err => console.error('[archive] unlock failed:', err.message))
    }
  }
  return report
}

// ── Reading the archive (app) ─────────────────────────────────────────

const readCache = new Map()   // title → { values, at }

async function readArchiveTab(token, title) {
  const cached = readCache.get(title)
  if (cached && Date.now() - cached.at < READ_CACHE_MS) return cached.values
  const archive = archiveSheet()
  const { tab } = await archive.findTab(token, { title })
  const values = tab ? await archive.readValues(token, title) : []
  readCache.set(title, { values, at: Date.now() })
  return values
}

/**
 * Archived rows of `tabName` for `year` + the years available (yearsOnly skips
 * the rows). Rows whose ID is still in the main sheet are left out — the main
 * copy wins. Read-only.
 */
export async function getArchivedRows(token, user, requestedTab, { year, yearsOnly = false } = {}) {
  const tabs = await mainSheet.getTabs(token)
  // Archive tabs carry the main tab's current title (old names resolve to it)
  const tabName = findConfiguredTab(tabs, requestedTab)?.title ?? requestedTab
  assertTabAccess(user, tabName, tabs)
  if (!isArchiveConfigured()) return { tabName, configured: false, years: [], values: [] }

  const values = await readArchiveTab(token, tabName)
  const [header = [], ...rows] = values
  const { date: dateCol } = tabColumns(tabName, header, tabs[0]?.title)
  const years = new Set()
  const picked = []
  for (const row of rows) {
    if (!hasData(row)) continue
    const rowYear = parseSheetDate(row[dateCol])?.year
    if (rowYear) years.add(rowYear)
    if (!yearsOnly && year && rowYear === year) picked.push(row)
  }

  let visible = picked
  if (picked.length) {
    const inMain = await readIdColumn(mainSheet, token, tabName)
    visible = picked.filter(row => !inMain.has(row[ID]))
  }
  return {
    tabName,
    configured: true,
    years:  [...years].sort((a, b) => b - a),
    values: header.length && !yearsOnly ? [header, ...visible] : [],
  }
}

// ── Restore ───────────────────────────────────────────────────────────

/** Moves archived rows (by ID, or the whole tab when ids is empty) back to the main sheet. */
export async function restoreRows(token, requestedTab, ids = []) {
  const archive = archiveSheet()
  const mainTab = findConfiguredTab(await mainSheet.getTabs(token, { fresh: true }), requestedTab)
  const tabName = mainTab?.title ?? requestedTab
  const { tab: archiveTab } = await archive.findTab(token, { title: tabName })
  if (!archiveTab || !mainTab) throw new HttpError(404, `التبويب "${tabName}" مش موجود`, 'TAB_NOT_FOUND')

  const wanted = ids.length ? new Set(ids) : null
  const values = await archive.readValues(token, tabName)
  const rows = []
  values.forEach((row, i) => {
    if (i > 0 && row[ID] && (!wanted || wanted.has(row[ID]))) rows.push({ rowIndex: i + 1, row })
  })
  if (!rows.length) return { restored: 0 }

  const inMain = await readIdColumn(mainSheet, token, tabName)
  const toAppend = rows.filter(r => !inMain.has(r.row[ID]))
  if (toAppend.length) {
    await mainSheet.ensureColumnCount(token, tabName, ROW_WIDTH)
    await mainSheet.appendRows(token, tabName, toAppend.map(r => toEnteredRow(r.row)))
  }

  const after = await readIdColumn(mainSheet, token, tabName)
  const missing = rows.filter(r => !after.has(r.row[ID]))
  if (missing.length) {
    throw new HttpError(500, `فشل التحقق من استرجاع ${missing.length} صف — لم يتم حذف شيء من الأرشيف`, 'RESTORE_VERIFY_FAILED')
  }
  await archive.deleteRows(token, archiveTab.sheetId, rows.map(r => r.rowIndex))
  readCache.delete(tabName)
  return { restored: rows.length }
}

// ── Totals (before / after check) ─────────────────────────────────────

/** Per tab, per month: { count, sum } over main + archive (an ID in both counts once). */
export async function monthTotals(token) {
  const tabs = await mainSheet.getTabs(token, { fresh: true })
  const titles = [tabs[0]?.title, INVOICES_TAB, ...SIMPLE_TABS.map(r => r.title)].filter(Boolean)
  const result = {}
  for (const title of titles) {
    if (!tabs.some(t => t.title === title)) continue
    const mainValues = await mainSheet.readValues(token, title)
    const archiveValues = isArchiveConfigured() ? await readArchiveTab(token, title) : []
    const seen = new Set()
    const months = {}
    for (const values of [mainValues, archiveValues]) {
      const [header = [], ...rows] = values
      const cols = tabColumns(title, header, tabs[0]?.title)
      for (const row of rows) {
        if (!hasData(row)) continue
        if (row[ID]) { if (seen.has(row[ID])) continue; seen.add(row[ID]) }
        const date = parseSheetDate(row[cols.date])
        const key = date ? monthKey(date) : 'unreadable'
        months[key] ??= { count: 0, sum: 0 }
        months[key].count++
        months[key].sum += cols.money >= 0 ? num(row[cols.money]) : 0
      }
    }
    result[title] = Object.fromEntries(Object.entries(months).sort())
  }
  return result
}
