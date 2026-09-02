// HabiTracker push backend (Cloudflare Worker).
// - Stores each device's push subscription + reminder time + latest stats in KV.
// - A cron trigger fires the daily nudge at each user's local reminder time.
//
// The app's habit data lives in the user's private Google Sheet, which this
// server cannot read. The client uploads its current stats on each open, and
// the nudge is built from those last-known values.

import { sendPush } from './webpush.js'

const ALLOWED_ORIGINS = ['https://sowmyy.github.io', 'http://localhost:5173']

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  }
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  })
}

async function idFor(endpoint) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Opaque, unguessable session id (256-bit).
function newSessionId() {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

// POST form-encoded params to a Google OAuth endpoint and parse the JSON.
async function googleForm(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  })
  let data = {}
  try {
    data = await res.json()
  } catch {}
  return { ok: res.ok, status: res.status, data }
}

function vapidFrom(env) {
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:habitracker@example.com',
  }
}

// Build the notification content from the user's last-known stats.
function buildMessage(stats = {}) {
  const { streak = 0, doneToday = 0, totalToday = 0, dayNumber = 0, totalDays = 0 } = stats
  const left = Math.max(0, totalToday - doneToday)
  const daysLeft = Math.max(0, totalDays - dayNumber)

  if (totalToday > 0 && left === 0) {
    return {
      title: streak > 0 ? `🔥 ${streak}-day streak going strong!` : `🏆 Perfect day complete!`,
      body:
        daysLeft > 0
          ? `All habits done for today. ${daysLeft} days left to reach your goal — keep it up!`
          : `All habits done. Amazing consistency!`,
    }
  }
  if (left === 1) {
    return {
      title: `🏆 Perfect day incoming!`,
      body: `Just one more habit to complete today.${streak > 0 ? ` Keep your ${streak}-day streak alive!` : ''}`,
    }
  }
  if (streak >= 3) {
    return {
      title: `🔥 ${streak}-day streak!`,
      body:
        left > 0
          ? `You still have ${left} habits left today — don't break the momentum.`
          : `Show up today and keep it alive.`,
    }
  }
  return {
    title: `💪 Day ${dayNumber || 1} awaits`,
    body:
      left > 0
        ? `You have ${left} habit${left === 1 ? '' : 's'} left. Small actions today build big changes tomorrow.`
        : `Take 2 minutes to check in on HabiTracker.`,
  }
}

// Local {date, hour, minute} for a timezone.
function localParts(tz) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz || 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    const p = Object.fromEntries(fmt.formatToParts(new Date()).map((x) => [x.type, x.value]))
    return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24, minute: Number(p.minute) }
  } catch {
    return null
  }
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || ''
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) })

    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/') {
      return json({ ok: true, service: 'habitracker-push' }, 200, origin)
    }

    if (request.method !== 'POST') return json({ error: 'method' }, 405, origin)

    let body
    try {
      body = await request.json()
    } catch {
      return json({ error: 'bad json' }, 400, origin)
    }

    // ---- Auth broker (persistent sign-in) --------------------------------

    // Exchange a one-time authorization code for tokens. Keep the refresh token
    // server-side; return an opaque session id + the first access token.
    if (url.pathname === '/auth/exchange') {
      const { code, redirect_uri } = body
      if (!code || !redirect_uri) return json({ error: 'missing code/redirect_uri' }, 400, origin)
      if (!ALLOWED_ORIGINS.includes(redirect_uri)) return json({ error: 'bad redirect_uri' }, 400, origin)

      const { ok, status, data } = await googleForm(GOOGLE_TOKEN_URL, {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri,
      })
      if (!ok) return json({ error: 'exchange_failed', detail: data.error || status }, 400, origin)

      const { access_token, expires_in, refresh_token } = data
      if (!refresh_token) {
        // No offline grant this time — the client stays signed in for this
        // session only (can't be persisted without a refresh token).
        return json({ persisted: false, access_token, expires_in }, 200, origin)
      }
      const session_id = newSessionId()
      await env.SESSIONS.put(
        session_id,
        JSON.stringify({ refresh_token, createdAt: Date.now() })
      )
      return json({ persisted: true, session_id, access_token, expires_in }, 200, origin)
    }

    // Trade a session id for a fresh access token (using the stored refresh token).
    if (url.pathname === '/auth/token') {
      const { session_id } = body
      if (!session_id) return json({ error: 'no session_id' }, 400, origin)
      const raw = await env.SESSIONS.get(session_id)
      if (!raw) return json({ error: 'no_session' }, 401, origin)
      const rec = JSON.parse(raw)

      const { ok, status, data } = await googleForm(GOOGLE_TOKEN_URL, {
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: rec.refresh_token,
      })
      if (!ok) {
        // Refresh token revoked/expired -> drop the session, force re-sign-in.
        if (data.error === 'invalid_grant') {
          await env.SESSIONS.delete(session_id)
          return json({ error: 'reauth' }, 401, origin)
        }
        return json({ error: 'refresh_failed', detail: data.error || status }, 400, origin)
      }
      return json({ access_token: data.access_token, expires_in: data.expires_in }, 200, origin)
    }

    // Revoke and forget a session (sign out).
    if (url.pathname === '/auth/revoke') {
      const { session_id } = body
      if (session_id) {
        const raw = await env.SESSIONS.get(session_id)
        if (raw) {
          const rec = JSON.parse(raw)
          try {
            await googleForm(GOOGLE_REVOKE_URL, { token: rec.refresh_token })
          } catch {}
          await env.SESSIONS.delete(session_id)
        }
      }
      return json({ ok: true }, 200, origin)
    }

    if (url.pathname === '/subscribe') {
      const { subscription, tz, hour, minute, stats } = body
      if (!subscription?.endpoint) return json({ error: 'no subscription' }, 400, origin)
      const id = await idFor(subscription.endpoint)
      await env.SUBSCRIPTIONS.put(
        id,
        JSON.stringify({
          subscription,
          tz: tz || 'UTC',
          hour: Number(hour ?? 20),
          minute: Number(minute ?? 0),
          stats: stats || {},
          lastSent: '',
        })
      )
      return json({ ok: true, id }, 200, origin)
    }

    if (url.pathname === '/update') {
      const { endpoint, stats, tz, hour, minute } = body
      if (!endpoint) return json({ error: 'no endpoint' }, 400, origin)
      const id = await idFor(endpoint)
      const raw = await env.SUBSCRIPTIONS.get(id)
      if (!raw) return json({ error: 'not found' }, 404, origin)
      const rec = JSON.parse(raw)
      if (stats) rec.stats = stats
      if (tz) rec.tz = tz
      if (hour != null) rec.hour = Number(hour)
      if (minute != null) rec.minute = Number(minute)
      await env.SUBSCRIPTIONS.put(id, JSON.stringify(rec))
      return json({ ok: true }, 200, origin)
    }

    if (url.pathname === '/unsubscribe') {
      const { endpoint } = body
      if (!endpoint) return json({ error: 'no endpoint' }, 400, origin)
      await env.SUBSCRIPTIONS.delete(await idFor(endpoint))
      return json({ ok: true }, 200, origin)
    }

    // Send a push immediately (lets the user verify setup).
    if (url.pathname === '/test') {
      const { endpoint } = body
      if (!endpoint) return json({ error: 'no endpoint' }, 400, origin)
      const raw = await env.SUBSCRIPTIONS.get(await idFor(endpoint))
      if (!raw) return json({ error: 'not found' }, 404, origin)
      const rec = JSON.parse(raw)
      const msg = buildMessage(rec.stats)
      const res = await sendPush(rec.subscription, msg, vapidFrom(env))
      return json({ ok: res.ok, status: res.status }, 200, origin)
    }

    return json({ error: 'not found' }, 404, origin)
  },

  // Cron: iterate subscriptions and send the daily nudge at each local reminder time.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminders(env))
  },
}

async function runReminders(env) {
  const vapid = vapidFrom(env)
  let cursor
  do {
    const list = await env.SUBSCRIPTIONS.list({ cursor })
    cursor = list.list_complete ? undefined : list.cursor
    for (const key of list.keys) {
      const raw = await env.SUBSCRIPTIONS.get(key.name)
      if (!raw) continue
      const rec = JSON.parse(raw)
      const now = localParts(rec.tz)
      if (!now) continue
      const due = now.hour === rec.hour && now.minute >= rec.minute && now.minute < rec.minute + 15
      if (!due || rec.lastSent === now.date) continue

      const msg = buildMessage(rec.stats)
      try {
        const res = await sendPush(rec.subscription, msg, vapid)
        if (res.status === 404 || res.status === 410) {
          await env.SUBSCRIPTIONS.delete(key.name) // subscription expired
          continue
        }
      } catch (e) {
        // best-effort; try again next tick
        continue
      }
      rec.lastSent = now.date
      await env.SUBSCRIPTIONS.put(key.name, JSON.stringify(rec))
    }
  } while (cursor)
}
