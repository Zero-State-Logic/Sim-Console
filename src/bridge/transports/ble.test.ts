import { afterEach, describe, expect, it, vi } from 'vitest'
import { BleTransport } from './ble'
import { NUS_RX, NUS_SERVICE, NUS_TX } from './bleQueue'

/* Web Bluetooth (Nordic UART) against a fake GATT stack. */

interface RxOpts {
  withoutResponse: boolean
  hasWithResponse: boolean
}

class FakeChar extends EventTarget {
  value: DataView | null = null
  writes: { kind: string; text: string }[] = []
  notifying = false
  readonly properties: { writeWithoutResponse: boolean }
  writeValueWithResponse?: (c: BufferSource) => Promise<void>

  constructor(opts: RxOpts = { withoutResponse: true, hasWithResponse: true }) {
    super()
    this.properties = { writeWithoutResponse: opts.withoutResponse }
    if (opts.hasWithResponse) this.writeValueWithResponse = async (c) => this.record('with', c)
  }

  private record(kind: string, c: BufferSource): void {
    const bytes = c instanceof Uint8Array ? c : new Uint8Array(c as ArrayBuffer)
    this.writes.push({ kind, text: new TextDecoder().decode(bytes) })
  }

  async writeValueWithoutResponse(c: BufferSource): Promise<void> {
    this.record('without', c)
  }

  async writeValue(c: BufferSource): Promise<void> {
    this.record('legacy', c)
  }

  async startNotifications(): Promise<FakeChar> {
    this.notifying = true
    return this
  }

  async stopNotifications(): Promise<FakeChar> {
    this.notifying = false
    return this
  }

  notify(bytes: Uint8Array): void {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

class FakeDevice extends EventTarget {
  readonly rx: FakeChar
  readonly tx = new FakeChar()
  connected = false
  missingService = false
  readonly gatt = {
    connected: false,
    connect: async () => {
      this.gatt.connected = true
      return {
        getPrimaryService: async (uuid: string) => {
          if (this.missingService || uuid !== NUS_SERVICE) throw Object.assign(new Error('no service'), { name: 'NotFoundError' })
          return { getCharacteristic: async (c: string) => (c === NUS_RX ? this.rx : c === NUS_TX ? this.tx : null) }
        },
      }
    },
    disconnect: () => {
      this.gatt.connected = false
    },
  }

  constructor(rx?: RxOpts) {
    super()
    this.rx = new FakeChar(rx)
  }
}

function install(device: FakeDevice): { options: RequestDeviceOptions[] } {
  const seen: RequestDeviceOptions[] = []
  vi.stubGlobal('navigator', {
    bluetooth: {
      requestDevice: async (o: RequestDeviceOptions) => {
        seen.push(o)
        return device
      },
    },
  })
  return { options: seen }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('BleTransport: connect', () => {
  it('asks for devices by name prefix with the Nordic UART service, or any device when blank', async () => {
    // Arrange
    const dev = new FakeDevice()
    const seen = install(dev)
    // Act
    await new BleTransport(' KiyoBot ').connect()
    await new BleTransport('').connect()
    // Assert
    expect(seen.options[0]).toEqual({ filters: [{ namePrefix: 'KiyoBot' }], optionalServices: [NUS_SERVICE] })
    expect(seen.options[1]).toEqual({ acceptAllDevices: true, optionalServices: [NUS_SERVICE] })
    expect(dev.tx.notifying).toBe(true)
  })

  it('cleans up and rethrows when the device has no Nordic UART service', async () => {
    // Arrange
    const dev = new FakeDevice()
    dev.missingService = true
    install(dev)
    const t = new BleTransport('KiyoBot')
    // Act
    const err = await t.connect().catch((e: unknown) => e)
    // Assert
    expect((err as Error).message).toBe('no service')
    expect(dev.gatt.connected).toBe(false)
    expect(t.write('x')).toBe(false)
  })
})

describe('BleTransport: traffic', () => {
  it('reassembles notifications into lines, even with a UTF-8 character split across packets', async () => {
    // Arrange
    const dev = new FakeDevice()
    install(dev)
    const t = new BleTransport('KiyoBot')
    const lines: string[] = []
    t.onLine((l) => lines.push(l))
    await t.connect()
    const bytes = new TextEncoder().encode('{"t":"log","msg":"café"}\n')
    const cut = bytes.indexOf(0xc3) + 1
    // Act
    dev.tx.notify(bytes.subarray(0, cut))
    dev.tx.notify(bytes.subarray(cut))
    // Assert
    expect(lines).toEqual(['{"t":"log","msg":"café"}'])
  })

  it('writes 20-byte chunks without response when the characteristic allows it', async () => {
    // Arrange
    const dev = new FakeDevice()
    install(dev)
    const t = new BleTransport('KiyoBot')
    await t.connect()
    // Act
    t.write('{"t":"cmd","seq":1,"v":[0.1,0,0.2]}')
    await settle()
    // Assert
    expect(dev.rx.writes.every((w) => w.kind === 'without')).toBe(true)
    expect(dev.rx.writes.every((w) => new TextEncoder().encode(w.text).length <= 20)).toBe(true)
    expect(dev.rx.writes.map((w) => w.text).join('')).toBe('{"t":"cmd","seq":1,"v":[0.1,0,0.2]}\n')
  })

  it('falls back to writeValue on browsers without writeValueWithResponse', async () => {
    // Arrange
    const dev = new FakeDevice({ withoutResponse: false, hasWithResponse: false })
    install(dev)
    const t = new BleTransport('KiyoBot')
    await t.connect()
    // Act
    t.write('{"t":"home"}', true)
    await settle()
    // Assert
    expect(dev.rx.writes.map((w) => w.kind)).toEqual(['legacy'])
    expect(dev.rx.writes[0].text).toBe('{"t":"home"}\n')
  })

  it('reports a dropped GATT link once and stops notifications on disconnect', async () => {
    // Arrange
    const dev = new FakeDevice()
    install(dev)
    const t = new BleTransport('KiyoBot')
    const states: string[] = []
    t.onState((s, d) => states.push(`${s}:${d}`))
    await t.connect()
    // Act
    dev.dispatchEvent(new Event('gattserverdisconnected'))
    dev.dispatchEvent(new Event('gattserverdisconnected'))
    await settle()
    // Assert
    expect(states).toEqual(['closed:Bluetooth link dropped (out of range or board reset)'])
    expect(dev.tx.notifying).toBe(false)
  })
})
