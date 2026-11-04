import { describe, expect, it } from 'vitest'
import { generateFirmware } from '../index'
import { hwFor, request, sweeperSpec, walkerSpec } from '../testing/fixtures'
import { delimiterProblems, pythonIndentProblems } from '../testing/structure'
import type { FirmwareResult } from '../types'

function text(r: FirmwareResult, name: string): string {
  return r.files.find((f) => f.path.endsWith(name))?.content ?? ''
}

describe('Pi Zero 2 W daemon', () => {
  const walkerWs = generateFirmware(request(walkerSpec(6), hwFor('pizero2w', 'ws', 'pca9685', 18), 'high'))
  const walkerSerial = generateFirmware(request(walkerSpec(6), hwFor('pizero2w', 'serial', 'pca9685', 18), 'joint'))
  const sweeper = generateFirmware(request(sweeperSpec(), hwFor('pizero2w', 'ws', 'pca9685', 4), 'high'))

  it('ships the daemon, requirements, systemd unit and README in one folder', () => {
    expect(walkerWs.errors).toEqual([])
    expect(walkerWs.files.map((f) => f.path)).toEqual([
      'kiyobridge_pi/kiyobridge.py',
      'kiyobridge_pi/requirements.txt',
      'kiyobridge_pi/kiyobridge.service',
      'kiyobridge_pi/README_FIRMWARE.md',
    ])
    expect(walkerWs.files[0].language).toBe('python')
  })

  it('handles every protocol message with the same rules as the firmware', () => {
    const py = text(walkerWs, 'kiyobridge.py')
    for (const t of ['"cmd"', '"home"', '"estop"', '"ping"', '"hello?"']) expect(py).toContain(`t == ${t}`)
    expect(py).toContain('self.ack("home", True)')
    expect(py).toContain('self.ack("estop", True)')
    expect(py).toContain('{"t": "pong"')
    expect(py).toContain('watchdog: no cmd for %d ms')
    expect(py).toContain('" clamped"')
    expect(py).toContain('HELLO = {"t":"hello","proto":1,"board":"pizero2w","robot":"walker","joints":18,"legs":6,"fw":"kiyobridge-1.0"}')
  })

  it('is valid-looking Python: balanced brackets and 4-space blocks', () => {
    for (const r of [walkerWs, walkerSerial, sweeper]) {
      const py = text(r, 'kiyobridge.py')
      expect(delimiterProblems(py, 'python')).toEqual([])
      expect(pythonIndentProblems(py)).toEqual([])
      expect(py.startsWith('#!/usr/bin/env python3\n')).toBe(true)
    }
  })

  it('drives servos through ServoKit and the sweeper motors through the PCA9685 driver', () => {
    expect(text(walkerWs, 'kiyobridge.py')).toContain('from adafruit_servokit import ServoKit')
    expect(text(walkerWs, 'kiyobridge.py')).toContain('def leg_ik(leg, px, py, pz):')
    expect(text(walkerSerial, 'kiyobridge.py')).not.toContain('def leg_ik(')
    expect(text(sweeper, 'kiyobridge.py')).toContain('from adafruit_pca9685 import PCA9685')
    expect(text(sweeper, 'kiyobridge.py')).toContain('class Ld06:')
  })

  it('writes serial lines from a thread, so a host that stops reading never stalls the control loop', () => {
    const py = text(walkerSerial, 'kiyobridge.py')
    const send = py.slice(py.indexOf('class SerialLink'), py.indexOf('class WsLink'))
    expect(send).toContain('self.tx = ThreadQueue(maxsize=64)')
    expect(send).toContain('threading.Thread(target=self.writer, daemon=True).start()')
    expect(send).toMatch(/def send\(self, text\):\n {8}try:\n {12}self\.tx\.put_nowait\(text\)\n {8}except QueueFull:/)
    expect(py).toContain('from queue import Full as QueueFull, Queue as ThreadQueue')
  })

  it('lists the link package in requirements.txt', () => {
    expect(text(walkerWs, 'requirements.txt')).toMatch(/^websockets>=12$/m)
    expect(text(walkerSerial, 'requirements.txt')).toMatch(/^pyserial>=3\.5$/m)
    expect(text(walkerSerial, 'requirements.txt')).not.toContain('websockets')
    expect(text(sweeper, 'requirements.txt')).toContain('pyserial>=3.5')
  })

  it('lets the WebSocket service bind port 81 and the serial one wait for the gadget', () => {
    const ws = text(walkerWs, 'kiyobridge.service')
    const serial = text(walkerSerial, 'kiyobridge.service')
    expect(ws).toContain('AmbientCapabilities=CAP_NET_BIND_SERVICE')
    expect(ws).toContain('After=network-online.target')
    expect(ws).toContain('kiyobridge.py --link ws')
    expect(serial).toContain('After=dev-ttyGS0.device')
    expect(serial).not.toContain('CAP_NET_BIND_SERVICE')
    expect(ws).toContain('WantedBy=multi-user.target')
  })

  it('tells the user how to enable I2C, install and start the service', () => {
    const steps = walkerWs.steps.join('\n')
    expect(steps).toMatch(/do_i2c 0/)
    expect(steps).toMatch(/pip install -r requirements.txt/)
    expect(steps).toMatch(/systemctl enable --now kiyobridge/)
    expect(walkerSerial.steps.join('\n')).toMatch(/g_serial/)
  })
})
