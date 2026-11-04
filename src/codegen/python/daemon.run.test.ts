import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { generateFirmware } from '../index'
import { hwFor, request, sweeperSpec, walkerSpec } from '../testing/fixtures'

/*
 * Runs the generated Pi daemon for real (python --stdio --dry-run) when a Python 3
 * is on PATH; skipped otherwise. The session is event-driven (it waits for each
 * reply), so a slow machine only makes it slower, not flaky.
 */

function findPython(): string | null {
  for (const exe of ['python3', 'python']) {
    const r = spawnSync(exe, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim() === '3') return exe
  }
  return null
}

const PYTHON = findPython()
const dir = mkdtempSync(join(tmpdir(), 'kiyo-daemon-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

type Msg = Record<string, unknown> & { t: string }

function daemonFile(name: string, r: ReturnType<typeof generateFirmware>): string {
  const py = r.files.find((f) => f.path.endsWith('kiyobridge.py'))?.content ?? ''
  const path = join(dir, `${name}.py`)
  writeFileSync(path, py)
  return path
}

/** hello? + ping + home, then a second of commands once homed, then estop. */
function session(python: string, path: string, cmd: Record<string, unknown>): Promise<{ msgs: Msg[]; code: number | null }> {
  return new Promise((resolve, reject) => {
    const p = spawn(python, ['-I', path, '--stdio', '--dry-run'])
    const msgs: Msg[] = []
    let buf = ''
    let started = false
    const send = (o: object) => p.stdin.write(`${JSON.stringify(o)}\n`)
    // generous: the whole suite runs ~150 files in parallel and Python start-up slows under load
    const killer = setTimeout(() => p.kill(), 45000)
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        const m = JSON.parse(buf.slice(0, nl)) as Msg
        buf = buf.slice(nl + 1)
        msgs.push(m)
        if (m.t === 'hello' && msgs.filter((x) => x.t === 'hello').length === 1) {
          send({ t: 'cmd', ...cmd })   // before home: must be ignored
          send({ t: 'hello?' })
          send({ t: 'ping', id: 7 })
          send({ t: 'home' })
        }
        if (m.t === 'ack' && m.of === 'home' && !started) {
          started = true
          const timer = setInterval(() => send({ t: 'cmd', ...cmd }), 20)
          setTimeout(() => {
            clearInterval(timer)
            send({ t: 'estop' })
          }, 1500)
        }
        if (m.t === 'ack' && m.of === 'estop') p.stdin.end()
        nl = buf.indexOf('\n')
      }
    })
    p.on('error', reject)
    p.on('close', (code) => {
      clearTimeout(killer)
      resolve({ msgs, code })
    })
  })
}

describe.skipIf(PYTHON === null)('generated Pi daemon, run under Python', { timeout: 60_000 }, () => {
  const python = PYTHON ?? 'python'
  const walker = daemonFile('walker4', generateFirmware(request(walkerSpec(4), hwFor('pizero2w', 'ws', 'pca9685', 12), 'high')))
  const sweeper = daemonFile('sweeper', generateFirmware(request(sweeperSpec(), hwFor('pizero2w', 'serial', 'pca9685', 4), 'joint')))

  it('byte-compiles', () => {
    for (const f of [walker, sweeper]) expect(spawnSync(python, ['-I', '-m', 'py_compile', f], { encoding: 'utf8' }).status).toBe(0)
  })

  it('speaks the protocol and walks the 4-leg crawl on its own gait', async () => {
    const { msgs, code } = await session(python, walker, { v: [-0.04, 0, 0], mode: 'crawl', h: 0.08 })
    const of = (t: string) => msgs.filter((m) => m.t === t)
    expect(code).toBe(0)
    expect(of('hello').length).toBeGreaterThanOrEqual(2)
    expect(of('hello')[0]).toMatchObject({ proto: 1, board: 'pizero2w', robot: 'walker', joints: 12, legs: 4, fw: 'kiyobridge-1.0' })
    expect(of('pong')).toEqual([{ t: 'pong', id: 7 }])
    expect(of('ack').map((m) => m.of)).toEqual(['home', 'estop'])
    expect(of('log').map((m) => m.msg)).toContain('1 cmd ignored: send home first')
    const ang = of('tel').map((m) => m.ang as number[])
    const swing = Math.max(...ang[0].map((_, j) => Math.max(...ang.map((a) => a[j])) - Math.min(...ang.map((a) => a[j]))))
    expect(swing).toBeGreaterThan(10)
  }, 20000)

  it('drives the sweeper wheels from cmd w and reports odometry', async () => {
    const { msgs, code } = await session(python, sweeper, { w: [5, 5, 5, 5] })
    expect(code).toBe(0)
    const tel = msgs.filter((m) => m.t === 'tel')
    const last = tel.filter((m) => Array.isArray(m.enc) && (m.enc as number[])[0] > 1).pop()
    expect(last?.enc).toEqual([5, 5, 5, 5])
    expect((last?.pose as number[])[0]).toBeGreaterThan(0)
  }, 20000)
})
