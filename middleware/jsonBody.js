// middleware/jsonBody.js
//
// On Vercel serverless, express.json() sometimes doesn't run for PUT/DELETE,
// leaving req.body empty while the raw stream is still unread. Read it here.

import { HttpError } from './errors.js'

export async function ensureJsonBody(req, _res, next) {
  // Already parsed by express.json(), or the stream was consumed elsewhere
  if (req.method === 'GET' || req._body || req.readableEnded) return next()

  try {
    const raw = await new Promise((resolve, reject) => {
      let data = ''
      req.on('data', chunk => { data += chunk })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })
    req.body = raw ? JSON.parse(raw) : {}
    next()
  } catch {
    next(new HttpError(400, 'Invalid JSON body', 'INVALID_JSON'))
  }
}
