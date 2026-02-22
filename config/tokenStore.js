// config/tokenStore.js
//
// Stores Google access tokens SERVER-SIDE only.
// Maps  userId (email)  →  { googleToken, expiresAt }
//
// In production with multiple server instances, swap this for Redis.

const store = new Map()

// Default Google token lifetime: 55 minutes (Google issues 60-min tokens,
// we refresh 5 minutes early to avoid mid-request expiry).
const GOOGLE_TOKEN_TTL_MS = 55 * 60 * 1000

export const tokenStore = {
  /**
   * Save a Google access token for a user.
   * @param {string} userId  — unique key (email)
   * @param {string} googleToken
   */
  set(userId, googleToken) {
    store.set(userId, {
      googleToken,
      expiresAt: Date.now() + GOOGLE_TOKEN_TTL_MS,
    })
  },

  /**
   * Retrieve the Google access token.
   * Returns null if missing or expired.
   */
  get(userId) {
    const entry = store.get(userId)
    if (!entry) return null
    if (Date.now() > entry.expiresAt) {
      store.delete(userId)
      return null
    }
    return entry.googleToken
  },

  /**
   * Check whether a valid (non-expired) token exists.
   */
  has(userId) {
    return this.get(userId) !== null
  },

  /**
   * Remove the token (on logout).
   */
  delete(userId) {
    store.delete(userId)
  },

  /**
   * Check if token is close to expiry (within 5 minutes).
   * Used to tell the frontend it should reauthenticate soon.
   */
  isExpiringSoon(userId) {
    const entry = store.get(userId)
    if (!entry) return true
    return (entry.expiresAt - Date.now()) < 5 * 60 * 1000
  },
}
