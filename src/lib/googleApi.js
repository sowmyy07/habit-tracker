// Google Identity Services (GIS) auth + authenticated fetch helpers.
//
// Persistent sign-in via the OAuth *authorization-code* flow:
//   1. The user clicks "Continue with Google" -> GIS popup returns a one-time
//      authorization code (initCodeClient, ux_mode 'popup').
//   2. We POST that code to our Cloudflare Worker, which exchanges it (with the
//      client secret) for an access token AND a long-lived refresh token. The
//      Worker keeps the refresh token and hands us back an opaque session id.
//   3. We persist only the session id (localStorage). On every later launch we
//      trade the session id for a fresh access token from the Worker — no popup,
//      no Google prompt. The session survives app restarts on web and mobile PWA.
//
// The refresh token never touches the browser; the session id only lets the
// Worker mint short-lived access tokens for this app's own Drive files.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID
const AUTH_API = import.meta.env.VITE_PUSH_API || '' // the Worker is our token broker too
const SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/drive.file', // per-file: only files this app creates
].join(' ')

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const SESSION_KEY = 'habitracker-session'

let codeClient = null
let accessToken = null
let tokenExpiry = 0 // epoch ms
let sessionId = loadSession()

if (!CLIENT_ID) {
  console.warn(
    '[google] Missing VITE_GOOGLE_CLIENT_ID. Copy .env.local.example to .env.local and set it.'
  )
}
if (!AUTH_API) {
  console.warn(
    '[google] Missing VITE_PUSH_API. Persistent sign-in needs the token-broker Worker URL.'
  )
}

// ---- Session id persistence ----------------------------------------------

function loadSession() {
  try {
    return localStorage.getItem(SESSION_KEY) || null
  } catch {
    return null
  }
}
function saveSession(id) {
  sessionId = id
  try {
    localStorage.setItem(SESSION_KEY, id)
  } catch {}
}
function clearSession() {
  sessionId = null
  try {
    localStorage.removeItem(SESSION_KEY)
  } catch {}
}

// True if this browser holds a persisted session we can silently restore.
export function wasAuthed() {
  return !!sessionId
}

// ---- GIS bootstrap --------------------------------------------------------

// Wait for the GIS script (loaded in index.html) to be ready.
function waitForGis() {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = () => {
      if (window.google?.accounts?.oauth2) return resolve()
      if (Date.now() - start > 10000) return reject(new Error('Google script failed to load'))
      setTimeout(tick, 50)
    }
    tick()
  })
}

// Per-request handlers, wired once into the code client.
let onCode = null
let onCodeError = null

export async function initAuth() {
  await waitForGis()
  codeClient = window.google.accounts.oauth2.initCodeClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    ux_mode: 'popup',
    callback: (resp) => onCode && onCode(resp),
    error_callback: (err) => onCodeError && onCodeError(err),
  })
}

// Open the consent popup and resolve with the CodeResponse ({ code, scope }).
function requestCode() {
  return new Promise((resolve, reject) => {
    if (!codeClient) return reject(new Error('Auth not initialized'))
    let done = false
    onCode = (resp) => {
      if (done) return
      done = true
      if (resp.error) return reject(resp)
      resolve(resp)
    }
    onCodeError = (err) => {
      if (done) return
      done = true
      reject(err || new Error('code request failed'))
    }
    codeClient.requestCode()
  })
}

// ---- Sign-in / restore / sign-out ----------------------------------------

// Interactive sign-in. Shows the consent popup, exchanges the code on the
// Worker for a persistent session, then returns the user's profile.
export async function signIn() {
  if (!codeClient) await initAuth()
  if (!AUTH_API) throw new Error('Sign-in is not configured (missing token-broker URL).')

  const resp = await requestCode()
  const granted = (resp.scope || '').split(' ')
  if (!granted.includes(DRIVE_SCOPE)) {
    throw new Error(
      'DRIVE_SCOPE_NOT_GRANTED: Please allow the Google Drive permission ' +
        '("see, edit, create, and delete only the specific Drive files you use with this app") when signing in.'
    )
  }

  const ex = await fetch(`${AUTH_API}/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: resp.code, redirect_uri: window.location.origin }),
  })
  if (!ex.ok) throw new Error('Sign-in failed while exchanging the authorization code.')
  const data = await ex.json()

  accessToken = data.access_token
  tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000
  if (data.persisted && data.session_id) {
    saveSession(data.session_id)
  } else {
    // Google didn't return a refresh token, so this session can't be persisted
    // server-side. The user stays signed in for this session only.
    console.warn('[google] No refresh token issued — session will not persist. Check offline access / consent.')
    clearSession()
  }

  return fetchUserInfo()
}

// Restore a persisted session on load (no popup): trade the session id for a
// fresh access token via the Worker.
export async function trySilentSignIn() {
  if (!sessionId || !AUTH_API) return null
  try {
    await getAccessToken() // refreshes via the Worker
    return await fetchUserInfo()
  } catch {
    return null
  }
}

// Sign out: forget the local session and revoke the refresh token on the Worker.
export async function signOut() {
  const sid = sessionId
  accessToken = null
  tokenExpiry = 0
  clearSession()
  if (sid && AUTH_API) {
    try {
      await fetch(`${AUTH_API}/auth/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sid }),
      })
    } catch {}
  }
}

// ---- Access tokens --------------------------------------------------------

// Return a valid access token, refreshing through the Worker when needed.
async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken
  if (!sessionId) throw new Error('NO_SESSION')
  if (!AUTH_API) throw new Error('NO_AUTH_API')

  const res = await fetch(`${AUTH_API}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  })
  if (res.status === 401) {
    // Refresh token was revoked or expired — force a fresh sign-in.
    clearSession()
    accessToken = null
    throw new Error('SESSION_EXPIRED')
  }
  if (!res.ok) throw new Error('Could not refresh your session')
  const data = await res.json()
  accessToken = data.access_token
  tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000
  return accessToken
}

async function fetchUserInfo() {
  const token = await getAccessToken()
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error('Failed to fetch user info')
  const u = await res.json()
  return { uid: u.sub, displayName: u.name, email: u.email, photoURL: u.picture }
}

// Authenticated JSON fetch against Google APIs. Retries once on 401 (expired token).
export async function apiFetch(url, { method = 'GET', body, _retried } = {}) {
  const token = await getAccessToken()
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && !_retried) {
    accessToken = null // force refresh via the Worker
    return apiFetch(url, { method, body, _retried: true })
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Google API ${res.status}: ${text}`)
  }
  return res.status === 204 ? null : res.json()
}
