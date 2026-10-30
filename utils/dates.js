// utils/dates.js
//
// Reads the date formats the app writes to the sheets (same rules as
// client/src/utils/dateHelpers.js): "DD/MM/YYYY hh:mm AM", Arabic-locale
// "DD/MM/YYYY، hh:mm م", "YYYY-MM-DDTHH:MM", "YYYY-MM-DD", "YYYY-MM".
// Anything else is "unreadable" — callers must not guess.

const DIRECTION_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const toLatinDigits = s => s.replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))

/** { year, month (1-12), day (1-31) | null } or null when the value isn't a date we write. */
export function parseSheetDate(raw) {
  const s = toLatinDigits(String(raw ?? '').replace(DIRECTION_MARKS, '').trim().replace(/^'+/, ''))
  if (!s) return null

  let m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?(?:[T\s].*)?$/)
  if (m) return build(m[1], m[2], m[3])

  m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s.*)?$/)
  if (m) return build(m[1], m[2], m[3])

  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[،,\s].*)?$/)
  if (m) return build(m[3], m[2], m[1])

  return null
}

function build(y, mo, d) {
  const year  = Number(y)
  const month = Number(mo)
  const day   = d === undefined ? null : Number(d)
  if (month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) return null
  return { year, month, day }
}

/** Months since year 0 — makes month comparisons simple integer comparisons. */
export const monthIndex = ({ year, month }) => year * 12 + (month - 1)

/** First month that stays in the main sheet when keeping `keepMonths` months. */
export function archiveCutoff(keepMonths, now = new Date()) {
  const index = now.getFullYear() * 12 + now.getMonth() - keepMonths
  return { year: Math.floor(index / 12), month: (index % 12) + 1 }
}

export const monthKey = ({ year, month }) => `${year}-${String(month).padStart(2, '0')}`
