const { createHmac, timingSafeEqual } = require('node:crypto')

function createAccessToken(userId) {
  const secret = process.env.AUTH_SECRET
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set to a random value of at least 32 characters.')
  }

  const payload = Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 8 })).toString('base64url')
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function getUserIdFromToken(token) {
  const secret = process.env.AUTH_SECRET
  if (!secret || typeof token !== 'string') return null

  const [payload, signature] = token.split('.')
  if (!payload || !signature) return null

  const expected = createHmac('sha256', secret).update(payload).digest()
  const actual = Buffer.from(signature, 'base64url')
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString())
    return claims.exp > Math.floor(Date.now() / 1000) ? claims.sub : null
  } catch {
    return null
  }
}

function requireAuth(request, response, next) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  const userId = getUserIdFromToken(token)
  if (!userId) return response.status(401).json({ message: 'Please sign in again.' })
  request.userId = userId
  return next()
}

module.exports = { createAccessToken, getUserIdFromToken, requireAuth }
