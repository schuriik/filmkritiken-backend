// Local dev stub for filmkritiken-backend.
//
// On managed Windows machines the endpoint protection blocks the execution of
// freshly built .exe files (and mongod.exe), so neither the Go backend nor a local
// MongoDB can run. This stub serves the same HTTP contract from memory instead, so
// the frontend stays usable. See docs/local-dev-windows-av.md.
//
//   node dev-stub/server.js        (run from the repository root)
//
// Endpoints mirror http/inbound/Server.go. Data is lost when the process exits.

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const PORT = Number(process.env.PORT || 8080)
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173'
const POSTER_DIR = path.join(__dirname, '..', 'cmd', 'seed', 'posters')
const SESSION_COOKIE = 'session_id'
const STUB_USER = {
  name: 'Local Dev',
  // every permission the real backend checks, see http/inbound/Server.go
  permissions: ['film.add', 'bewertung.add', 'bewertung.openclose'],
}

const newId = () => crypto.randomBytes(12).toString('hex')

// --- in-memory store, seeded from the Go seed data --------------------------

const filmkritiken = new Map()
const images = new Map()
const sessions = new Map()

for (const item of require('./films')) {
  const id = newId()
  const imageId = newId()

  let bytes = null
  try {
    bytes = fs.readFileSync(path.join(POSTER_DIR, item.poster))
  } catch (err) {
    console.warn(`could not load poster ${item.poster}: ${err.message}`)
  }
  if (bytes) {
    images.set(imageId, bytes)
  }

  filmkritiken.set(id, {
    id,
    details: { ...item.details },
    film: { ...item.film, image: { ...item.film.image, id: bytes ? imageId : '' } },
    bewertungen: item.bewertungen.map((b) => ({ ...b })),
  })
}

console.log(`seeded ${filmkritiken.size} filmkritiken, ${images.size} posters`)

// --- filtering / sorting, mirroring the mongo queries ----------------------

const besprochenAm = (item) => (item.details && item.details.besprochenam ? new Date(item.details.besprochenam) : null)
const besprochenAmOrZero = (item) => besprochenAm(item) || new Date(0)

function averageWertung(item) {
  if (!item.bewertungen || item.bewertungen.length === 0) {
    return null
  }
  const sum = item.bewertungen.reduce((acc, b) => acc + (b.wertung || 0), 0)
  return sum / item.bewertungen.length
}

function matchesFilter(item, filter) {
  if (filter.suche) {
    const needle = filter.suche.toLowerCase()
    const titel = (item.film.titel || '').toLowerCase()
    const originaltitel = (item.film.originaltitel || '').toLowerCase()
    if (!titel.includes(needle) && !originaltitel.includes(needle)) {
      return false
    }
  }

  if (filter.jahr > 0) {
    const date = besprochenAm(item)
    if (!date || date.getUTCFullYear() !== filter.jahr) {
      return false
    }
  }

  if (filter.beitragvon) {
    const beitragvon = (item.details.beitragvon || '').toLowerCase()
    if (beitragvon !== filter.beitragvon.toLowerCase()) {
      return false
    }
  }

  return true
}

function sortItems(items, sortierung) {
  if (sortierung === 'beste') {
    return items.sort((a, b) => {
      const avgA = averageWertung(a)
      const avgB = averageWertung(b)
      if ((avgA === null) !== (avgB === null)) {
        // like MongoDB, entries without a rating sort last on a descending sort
        return avgA === null ? 1 : -1
      }
      if (avgA !== null && avgA !== avgB) {
        return avgB - avgA
      }
      return besprochenAmOrZero(b) - besprochenAmOrZero(a)
    })
  }

  if (sortierung === 'aelteste') {
    return items.sort((a, b) => besprochenAmOrZero(a) - besprochenAmOrZero(b))
  }

  return items.sort((a, b) => besprochenAmOrZero(b) - besprochenAmOrZero(a))
}

// --- helpers ---------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function readCookie(req, name) {
  const header = req.headers.cookie || ''
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      return decodeURIComponent(rest.join('='))
    }
  }
  return null
}

function setCookie(res, name, value, maxAge) {
  res.setHeader('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`)
}

function currentSession(req) {
  const sessionId = readCookie(req, SESSION_COOKIE)
  if (!sessionId) {
    return null
  }
  const session = sessions.get(sessionId)
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId)
    return null
  }
  return session
}

function requirePermission(req, res, permission) {
  const session = currentSession(req)
  if (!session) {
    sendJson(res, 401, { error: 'Unauthenticated' })
    return null
  }
  if (!session.permissions.includes(permission)) {
    sendJson(res, 403, { error: 'Forbidden' })
    return null
  }
  return session
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// --- request handling ------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, Content-Length, Accept-Encoding, Authorization, origin, Cache-Control')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)
  const segments = url.pathname.split('/').filter(Boolean)

  try {
    await route(req, res, url, segments)
  } catch (err) {
    console.error(`${req.method} ${url.pathname} failed: ${err.stack}`)
    sendJson(res, 500, { error: 'stub server error' })
  }
})

async function route(req, res, url, segments) {
  const method = req.method

  // GET /
  if (method === 'GET' && segments.length === 0) {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  // GET /auth/login -> the real backend redirects to Entra; the stub just logs you in
  if (method === 'GET' && segments[0] === 'auth' && segments[1] === 'login') {
    const sessionId = newId()
    sessions.set(sessionId, { ...STUB_USER, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 })
    setCookie(res, SESSION_COOKIE, sessionId, 7 * 24 * 60 * 60)

    const redirect = url.searchParams.get('redirect') || url.searchParams.get('returnUrl') || ''
    const target = redirect.startsWith('/') && !redirect.startsWith('//') ? redirect : '/'
    res.writeHead(302, { Location: `${FRONTEND_URL}${target}` })
    res.end()
    return
  }

  // GET /auth/me
  if (method === 'GET' && segments[0] === 'auth' && segments[1] === 'me') {
    const session = currentSession(req)
    if (!session) {
      sendJson(res, 401, { error: 'Unauthenticated' })
      return
    }
    sendJson(res, 200, { name: session.name, permissions: session.permissions })
    return
  }

  // POST /auth/logout
  if (method === 'POST' && segments[0] === 'auth' && segments[1] === 'logout') {
    const sessionId = readCookie(req, SESSION_COOKIE)
    if (sessionId) {
      sessions.delete(sessionId)
    }
    setCookie(res, SESSION_COOKIE, '', 0)
    res.writeHead(204)
    res.end()
    return
  }

  if (segments[0] !== 'api') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  // GET /api/images/:imageId
  if (method === 'GET' && segments[1] === 'images' && segments[2]) {
    const bytes = images.get(decodeURIComponent(segments[2]))
    if (!bytes) {
      sendJson(res, 404, { error: 'Bild konnte nicht gefunden werden.' })
      return
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': bytes.length, 'Cache-Control': 'public, max-age=3600' })
    res.end(bytes)
    return
  }

  if (segments[1] !== 'filmkritiken' && segments[1] !== 'filme') {
    sendJson(res, 404, { error: 'not found' })
    return
  }

  // GET /api/filmkritiken/filter-options
  if (method === 'GET' && segments[1] === 'filmkritiken' && segments[2] === 'filter-options') {
    const jahre = new Set()
    const beitragende = new Set()
    for (const item of filmkritiken.values()) {
      const date = besprochenAm(item)
      if (date) {
        jahre.add(date.getUTCFullYear())
      }
      if (item.details.beitragvon) {
        beitragende.add(item.details.beitragvon)
      }
    }
    sendJson(res, 200, {
      jahre: [...jahre].sort((a, b) => b - a),
      beitragende: [...beitragende].sort(),
    })
    return
  }

  // GET /api/filmkritiken
  if (method === 'GET' && segments[1] === 'filmkritiken' && segments.length === 2) {
    const params = url.searchParams
    const filter = {
      suche: params.get('suche') || params.get('titel') || '',
      jahr: Number.parseInt(params.get('jahr') || '', 10) || 0,
      beitragvon: params.get('beitragvon') || '',
    }
    const limit = Number.parseInt(params.get('limit') || '', 10) || 10
    const offset = Number.parseInt(params.get('offset') || '', 10) || 0

    let matches = [...filmkritiken.values()].filter((item) => matchesFilter(item, filter))
    const totalCount = matches.length
    matches = sortItems(matches, params.get('sortierung') || '')

    sendJson(res, 200, { items: matches.slice(offset, offset + limit), totalCount })
    return
  }

  // GET /api/filmkritiken/:id
  if (method === 'GET' && segments[1] === 'filmkritiken' && segments.length === 3) {
    const item = filmkritiken.get(decodeURIComponent(segments[2]))
    if (!item) {
      sendJson(res, 404, { error: 'Filmkritiken konnten nicht gefunden werden.' })
      return
    }
    sendJson(res, 200, item)
    return
  }

  // PUT /api/filmkritiken/:id/bewertungen/:username
  if (method === 'PUT' && segments[1] === 'filmkritiken' && segments[3] === 'bewertungen' && segments[4]) {
    if (!requirePermission(req, res, 'bewertung.add')) {
      return
    }

    const item = filmkritiken.get(decodeURIComponent(segments[2]))
    if (!item) {
      sendJson(res, 404, { error: 'Filmkritiken konnten nicht gefunden werden.' })
      return
    }
    if (!item.details.bewertungoffen) {
      sendJson(res, 400, { message: `Die Bewertung von ${item.film.titel} ist nicht mehr möglich.` })
      return
    }

    const body = JSON.parse((await readBody(req)).toString() || '{}')
    const enthaltung = Boolean(body.enthaltung)
    const wertung = Number(body.wertung)
    if (!enthaltung && (!Number.isInteger(wertung) || wertung < 1 || wertung > 10)) {
      sendJson(res, 400, { message: 'Wertung muss zwischen 1 und 10 liegen.' })
      return
    }

    const von = decodeURIComponent(segments[4])
    const existing = item.bewertungen.find((b) => b.von === von)
    if (existing) {
      existing.wertung = enthaltung ? 0 : wertung
      existing.enthaltung = enthaltung
    } else {
      item.bewertungen.push({ von, wertung: enthaltung ? 0 : wertung, enthaltung })
    }

    res.writeHead(204)
    res.end()
    return
  }

  // PATCH /api/filmkritiken/:id/bewertungenoffen/:offen
  if (method === 'PATCH' && segments[1] === 'filmkritiken' && segments[3] === 'bewertungenoffen' && segments[4]) {
    if (!requirePermission(req, res, 'bewertung.openclose')) {
      return
    }

    const item = filmkritiken.get(decodeURIComponent(segments[2]))
    if (!item) {
      sendJson(res, 404, { error: 'Filmkritiken konnten nicht gefunden werden.' })
      return
    }

    item.details.bewertungoffen = segments[4] === 'true'
    res.writeHead(204)
    res.end()
    return
  }

  // PATCH /api/filmkritiken/:id/besprochenAm
  if (method === 'PATCH' && segments[1] === 'filmkritiken' && segments[3] === 'besprochenAm') {
    if (!requirePermission(req, res, 'film.add')) {
      return
    }

    const item = filmkritiken.get(decodeURIComponent(segments[2]))
    if (!item) {
      sendJson(res, 404, { error: 'Filmkritiken konnten nicht gefunden werden.' })
      return
    }

    let body
    try {
      body = JSON.parse((await readBody(req)).toString() || '{}')
    } catch {
      sendJson(res, 400, { error: 'invalid json' })
      return
    }

    // Go binds the missing field to the zero time and rejects anything that is
    // not RFC 3339, so mirror both cases here.
    let besprochenam = '0001-01-01T00:00:00Z'
    if (body.besprochenam !== undefined && body.besprochenam !== null) {
      const parsed = new Date(body.besprochenam)
      if (Number.isNaN(parsed.getTime())) {
        sendJson(res, 400, { error: 'besprochenam muss ein RFC-3339-Datum sein' })
        return
      }
      besprochenam = parsed.toISOString()
    }

    item.details.besprochenam = besprochenam
    res.writeHead(204)
    res.end()
    return
  }

  // POST /api/filme (multipart: json + image)
  if (method === 'POST' && segments[1] === 'filme') {
    if (!requirePermission(req, res, 'film.add')) {
      return
    }

    const body = await readBody(req)
    const parsed = parseMultipart(body, req.headers['content-type'] || '')
    if (!parsed.json) {
      sendJson(res, 400, { message: 'json-Part fehlt.' })
      return
    }

    const payload = JSON.parse(parsed.json)
    const id = newId()
    let imageId = ''
    if (parsed.image && parsed.image.length > 0) {
      imageId = newId()
      images.set(imageId, parsed.image)
    }

    const item = {
      id,
      details: {
        beitragvon: payload.von || '',
        besprochenam: payload.besprochenam || null,
        bewertungoffen: Boolean(payload.bewertungoffen),
      },
      film: { ...payload.film, image: { ...(payload.film.image || {}), id: imageId } },
      bewertungen: [],
    }
    filmkritiken.set(id, item)

    sendJson(res, 201, item)
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

// Minimal multipart/form-data parser, enough for the "json" + "image" parts.
function parseMultipart(body, contentType) {
  const result = { json: null, image: null }
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  if (!match) {
    return result
  }

  const boundary = Buffer.from(`--${match[1] || match[2]}`)
  let start = body.indexOf(boundary)
  while (start !== -1) {
    const partStart = start + boundary.length
    let end = body.indexOf(boundary, partStart)
    if (end === -1) {
      break
    }

    const part = body.subarray(partStart, end)
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString()
      // strip the trailing CRLF that belongs to the boundary delimiter
      const content = part.subarray(headerEnd + 4, part.length - 2)
      const nameMatch = /name="([^"]+)"/i.exec(headers)
      const name = nameMatch ? nameMatch[1] : ''
      if (name === 'json') {
        result.json = content.toString()
      } else if (name === 'image') {
        result.image = content
      }
    }

    start = end
  }

  return result
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev stub listening on http://localhost:${PORT} (CORS for ${FRONTEND_URL})`)
  console.log(`log in via ${FRONTEND_URL} -> Login, the stub grants: ${STUB_USER.permissions.join(', ')}`)
})
