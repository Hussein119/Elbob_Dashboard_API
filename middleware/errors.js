// middleware/errors.js
//
// HttpError carries a status + optional machine-readable code to the central
// error handler. Route handlers wrapped in asyncHandler can simply `throw`.

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code   = code
  }
}

export const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next)

export function notFound(req, res) {
  res.status(404).json({ success: false, message: `Route ${req.method} ${req.path} not found` })
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ success: false, message: err.message })
  }

  const status = Number.isInteger(err.status) ? err.status : 500
  if (status >= 500) console.error('[server] Unhandled error:', err)

  // Only our own HttpErrors and body-parser 4xx errors are safe to show as-is
  const exposeMessage = err instanceof HttpError || status < 500
  res.status(status).json({
    success: false,
    message: exposeMessage ? err.message : 'Internal server error',
    ...(err.code && { code: err.code }),
  })
}
