// middleware/validate.js
//
// validate({ params, query, body }) — each a zod schema. Parsed values land on
// req.valid.{params,query,body}; handlers should read from there, not req.body.

import { HttpError } from './errors.js'

export const validate = schemas => (req, _res, next) => {
  req.valid = req.valid || {}
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue
    const result = schemas[part].safeParse(req[part] ?? {})
    if (!result.success) {
      const issue = result.error.issues[0]
      const where = [part, ...issue.path].join('.')
      return next(new HttpError(400, `${where}: ${issue.message}`, 'VALIDATION_ERROR'))
    }
    req.valid[part] = result.data
  }
  next()
}
