// scripts/archive.js — run the archive from a computer (no Vercel time limit).
//
//   node --env-file=.env scripts/archive.js --dry-run            what would move (writes nothing)
//   node --env-file=.env scripts/archive.js --run                move everything due, no row limit
//   node --env-file=.env scripts/archive.js --totals > before.json   per-month counts / sums (main + archive)
//   node --env-file=.env scripts/archive.js --restore --tab "المصروفات" [--ids id1,id2]
//
// Needs GOOGLE_SERVICE_ACCOUNT_KEY, SHEET_ID and ARCHIVE_SHEET_ID in the env.

import { getServiceToken } from '../config/serviceAccount.js'
import { runArchive, monthTotals, restoreRows } from '../services/archive.js'

const args = process.argv.slice(2)
const flag = name => args.includes(name)
const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }

async function main() {
  const token = await getServiceToken()
  if (!token) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is required to run the archive script')

  if (flag('--dry-run') || flag('--run')) {
    const report = await runArchive(token, {
      dryRun:       flag('--dry-run'),
      maxRows:      Number(value('--max-rows')) || Infinity,
      timeBudgetMs: Infinity,
    })
    console.table(report.tabs.map(({ byYear, ...rest }) => ({ ...rest, byYear: JSON.stringify(byYear || {}) })))
    console.log(JSON.stringify(report, null, 2))
    return
  }

  if (flag('--totals')) {
    console.log(JSON.stringify(await monthTotals(token), null, 2))
    return
  }

  if (flag('--restore')) {
    const tab = value('--tab')
    if (!tab) throw new Error('--restore needs --tab "<tab name>"')
    const ids = (value('--ids') || '').split(',').map(s => s.trim()).filter(Boolean)
    console.log(await restoreRows(token, tab, ids))
    return
  }

  console.log('Usage: --dry-run | --run [--max-rows N] | --totals | --restore --tab "<name>" [--ids a,b]')
}

main().catch(err => {
  console.error('❌', err.message)
  process.exit(1)
})
