import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startStaticServer, type StaticServer } from './server.cjs'

interface Reply {
  status: number
  type: string | undefined
  body: string
}

/** Raw request, so the path reaches the server exactly as written (no URL normalisation). */
function send(port: number, path: string, method = 'GET', host = `127.0.0.1:${port}`): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('startStaticServer', () => {
  let dir: string
  let root: string
  let served: StaticServer

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'simconsole-server-'))
    root = join(dir, 'dist')
    mkdirSync(join(root, 'assets'), { recursive: true })
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>SIM CONSOLE</title>')
    writeFileSync(join(root, 'assets', 'app.js'), 'export const ok = 1')
    writeFileSync(join(root, 'assets', 'physics.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    writeFileSync(join(root, 'manifest.webmanifest'), '{}')
    writeFileSync(join(dir, 'secret.txt'), 'outside the root')
    served = await startStaticServer({ root, port: 0 })
  })

  afterAll(async () => {
    await served.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('listens on loopback and reports its URL', () => {
    expect(served.url).toBe(`http://127.0.0.1:${served.port}/`)
    expect(served.port).toBeGreaterThan(0)
  })

  it('serves index.html for /', async () => {
    const r = await send(served.port, '/')
    expect(r.status).toBe(200)
    expect(r.type).toBe('text/html; charset=utf-8')
    expect(r.body).toContain('SIM CONSOLE')
  })

  it('serves scripts, wasm and the manifest with their MIME types', async () => {
    expect((await send(served.port, '/assets/app.js?v=2')).type).toBe('text/javascript; charset=utf-8')
    expect((await send(served.port, '/assets/physics.wasm')).type).toBe('application/wasm')
    expect((await send(served.port, '/manifest.webmanifest')).type).toBe('application/manifest+json; charset=utf-8')
  })

  it('answers HEAD without a body', async () => {
    const r = await send(served.port, '/index.html', 'HEAD')
    expect(r.status).toBe(200)
    expect(r.type).toBe('text/html; charset=utf-8')
    expect(r.body).toBe('')
  })

  it('returns 404 for unknown paths and directories', async () => {
    expect((await send(served.port, '/nope.js')).status).toBe(404)
    expect((await send(served.port, '/assets')).status).toBe(404)
  })

  it('refuses methods other than GET and HEAD', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      expect((await send(served.port, '/index.html', method)).status).toBe(405)
    }
  })

  it('never serves files outside the root', async () => {
    for (const path of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/..%5csecret.txt', '/assets/../../secret.txt']) {
      const r = await send(served.port, path)
      expect(r.status).toBe(403)
      expect(r.body).not.toContain('outside the root')
    }
  })

  it('refuses requests for other host names', async () => {
    expect((await send(served.port, '/', 'GET', 'evil.example')).status).toBe(403)
    expect((await send(served.port, '/', 'GET', `localhost:${served.port}`)).status).toBe(200)
  })
})

describe('port selection', () => {
  it('falls back to a free port when the preferred one is taken', async () => {
    const blocker: Server = createServer()
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()))
    const taken = (blocker.address() as AddressInfo).port
    const dir = mkdtempSync(join(tmpdir(), 'simconsole-port-'))
    try {
      const served = await startStaticServer({ root: dir, port: taken })
      expect(served.port).not.toBe(taken)
      await served.close()
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('uses the preferred port when it is free', async () => {
    const probe: Server = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
    const free = (probe.address() as AddressInfo).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const dir = mkdtempSync(join(tmpdir(), 'simconsole-port-'))
    try {
      const served = await startStaticServer({ root: dir, port: free })
      expect(served.port).toBe(free)
      await served.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
