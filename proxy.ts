import { NextResponse, type NextRequest } from 'next/server'

// ── Per-instance sliding-window rate limiter ──────────────────────────────
//
// State is per-serverless-instance. This stops single-instance floods and
// casual abuse; for fully distributed limits, swap in @upstash/ratelimit.
//
const WINDOW_MS = 60_000 // 1-minute window

// Requests per IP per window
const SCAN_LIMIT = 20   // /api/products/scan/* — hits 2 external APIs each
const API_LIMIT  = 60   // all other /api/* routes

type RateLimitEntry = { count: number; resetAt: number }
const store = new Map<string, RateLimitEntry>()

let lastPruned = Date.now()
function pruneExpired() {
  const now = Date.now()
  if (now - lastPruned < 300_000) return // at most every 5 min
  lastPruned = now
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key)
  }
}

function checkRateLimit(ip: string, pathname: string): boolean {
  const isScan = pathname.startsWith('/api/products/scan/')
  const limit  = isScan ? SCAN_LIMIT : API_LIMIT
  const key    = `${ip}:${isScan ? 'scan' : 'api'}`
  const now    = Date.now()

  const entry = store.get(key)
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (entry.count >= limit) return false
  entry.count++
  return true
}
// ─────────────────────────────────────────────────────────────────────────

const CORS_HEADERS = 'Content-Type, Authorization'
const CORS_METHODS = 'GET, POST, PUT, OPTIONS'

export function proxy(request: NextRequest) {
  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': CORS_METHODS,
        'Access-Control-Allow-Headers': CORS_HEADERS,
        'Access-Control-Max-Age': '86400',
      },
    })
  }

  // Rate limiting — health check is exempt
  if (request.nextUrl.pathname !== '/api/health') {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    pruneExpired()
    if (!checkRateLimit(ip, request.nextUrl.pathname)) {
      return NextResponse.json(
        { error: 'rate_limit_exceeded', message: 'Too many requests.' },
        {
          status: 429,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Retry-After': '60',
          },
        },
      )
    }
  }

  const response = NextResponse.next()
  response.headers.set('Access-Control-Allow-Origin', '*')
  response.headers.set('Access-Control-Allow-Methods', CORS_METHODS)
  response.headers.set('Access-Control-Allow-Headers', CORS_HEADERS)
  return response
}

export const proxyConfig = {
  matcher: '/api/:path*',
}
