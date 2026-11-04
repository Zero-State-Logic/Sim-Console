'use strict'

/* ============================================================
   LOCAL STATIC SERVER for the desktop shell: serves dist/ on
   http://127.0.0.1:<port>/. That origin is a secure context
   (Web Serial and Web Bluetooth work) and is not https, so the
   ws://<board-ip>:81 WiFi link is not blocked as mixed content.

   GET and HEAD only, loopback Host headers only, files strictly
   inside the root. A fixed preferred port keeps the origin, and
   with it localStorage (profiles, code, preferences), the same
   from one launch to the next; if it is taken, any free port.
   ============================================================ */

const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { pipeline } = require('node:stream')
const { isLoopbackHostHeader, mimeTypeFor, resolveSafePath } = require('./lib.cjs')

const HOST = '127.0.0.1'
const PREFERRED_PORT = 42613

const BASE_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-cache',
})

function sendStatus(res, status, extra = {}) {
  const body = `${status} ${http.STATUS_CODES[status] ?? ''}\n`
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra })
  res.end(res.req.method === 'HEAD' ? undefined : body)
}

/** A request handler that serves files from root. */
function createStaticHandler(root) {
  const base = path.resolve(root)
  return (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendStatus(res, 405, { Allow: 'GET, HEAD' })
    if (!isLoopbackHostHeader(req.headers.host)) return sendStatus(res, 403)
    const file = resolveSafePath(base, req.url ?? '/')
    if (file === null) return sendStatus(res, 403)
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return sendStatus(res, 404)
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': mimeTypeFor(file), 'Content-Length': stat.size })
      if (req.method === 'HEAD') return res.end()
      // pipeline closes the file when the page aborts a request (no locked or leaked handles)
      pipeline(fs.createReadStream(file), res, () => undefined)
    })
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.off('listening', onListening)
      reject(err)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

/**
 * Start serving root. Tries `port` first, then lets the OS pick one.
 * Resolves to { server, url, port, close() }; url ends with '/'.
 */
async function startStaticServer({ root, port = PREFERRED_PORT, host = HOST }) {
  const server = http.createServer(createStaticHandler(root))
  try {
    await listen(server, port, host)
  } catch (err) {
    if (port === 0 || (err.code !== 'EADDRINUSE' && err.code !== 'EACCES')) throw err
    await listen(server, 0, host)
  }
  // a late socket error must not become an uncaught exception in the main process
  server.on('error', (err) => process.stderr.write(`local server error: ${err.message}\n`))
  const actual = server.address().port
  const close = () =>
    new Promise((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  return { server, port: actual, url: `http://${host}:${actual}/`, close }
}

module.exports = { HOST, PREFERRED_PORT, createStaticHandler, startStaticServer }
