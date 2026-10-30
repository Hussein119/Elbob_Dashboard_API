// config/tabs.js
//
// The only sheet tabs the generic /api/sheets routes may read or write, and
// the role each one requires. The spreadsheet's first tab (main dashboard)
// is always allowed for every signed-in user. The users tab is never exposed
// here — it is managed only through /api/auth/users (admin only).

import { HttpError } from '../middleware/errors.js'

export const USERS_TAB = 'المستخدمون'
export const SALES_TAB = 'المبيعات'

// Old tab names still sent by browsers with cached data → current name
export const TAB_ALIASES = {
  'Elbob Dashboard': SALES_TAB,
}

export const TAB_ACCESS = {
  [SALES_TAB]:        'user',
  'فواتير الجملة':    'user',
  'عروض الأسعار':     'user',
  'مشتريات بضاعة':    'admin',
  'المصروفات':        'admin',
  'الرواتب والتوزيع': 'admin',
  'حسابات الدائنين':  'admin',
}

/**
 * The spreadsheet tab a requested name refers to: exact title, then an old
 * alias, then — for the sales tab before it has been renamed — the first tab.
 */
export function findConfiguredTab(tabs, title) {
  const byTitle = name => tabs.find(t => t.title === name)
  return byTitle(title)
    || (TAB_ALIASES[title] && byTitle(TAB_ALIASES[title]))
    || (title === SALES_TAB && Object.keys(TAB_ALIASES).map(byTitle).find(Boolean))
    || (title === SALES_TAB ? tabs[0] : null)
    || null
}

/** Throws 403 unless `user` may access the tab titled `title`. `tabs` = spreadsheet tabs in order. */
export function assertTabAccess(user, title, tabs) {
  const level = title === USERS_TAB
    ? null
    : TAB_ACCESS[title] ?? (title === tabs[0]?.title ? 'user' : null)

  if (!level) {
    throw new HttpError(403, `غير مسموح بالوصول إلى التبويب "${title}"`, 'TAB_FORBIDDEN')
  }
  if (level === 'admin' && user?.role !== 'admin') {
    throw new HttpError(403, 'هذه البيانات متاحة للمدير فقط', 'ADMIN_ONLY')
  }
}

/** Only listed tabs may be created on demand (never arbitrary names from the client). */
export function canCreateTab(title) {
  return Object.hasOwn(TAB_ACCESS, title)
}
