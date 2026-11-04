import { LineFramer } from '../link/framing'
import type { Transport, TransportEventState } from '../types'
import { BleWriteQueue, NUS_RX, NUS_SERVICE, NUS_TX } from './bleQueue'
import { TransportEvents, errorText } from './emitter'

/* ============================================================
   WEB BLUETOOTH — Nordic UART Service (the kiyobridge BLE firmware
   advertises it). Chrome / Edge on desktop and Android. RX = app to
   bot (write), TX = bot to app (notify). Notifications are decoded
   with a streaming TextDecoder so a UTF-8 sequence split across two
   20-byte packets survives, then framed into lines.
   ============================================================ */

export class BleTransport implements Transport {
  readonly id = 'ble' as const
  private readonly ev = new TransportEvents()
  private readonly framer = new LineFramer({ onLine: (l) => this.ev.line(l), onOversize: (b) => this.ev.drop(b) })
  private decoder = new TextDecoder()
  private device: BluetoothDevice | null = null
  private notify: BluetoothRemoteGATTCharacteristic | null = null
  private queue: BleWriteQueue | null = null
  private closing = false

  constructor(private readonly namePrefix: string) {}

  isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator
  }

  async connect(): Promise<void> {
    const prefix = this.namePrefix.trim()
    const device = await navigator.bluetooth.requestDevice(
      prefix
        ? { filters: [{ namePrefix: prefix }], optionalServices: [NUS_SERVICE] }
        : { acceptAllDevices: true, optionalServices: [NUS_SERVICE] },
    )
    if (!device.gatt) throw new Error('this device has no GATT server')
    this.closing = false
    this.device = device
    device.addEventListener('gattserverdisconnected', this.onGattDisconnected)
    try {
      const server = await device.gatt.connect()
      const service = await server.getPrimaryService(NUS_SERVICE)
      const rx = await service.getCharacteristic(NUS_RX)
      const tx = await service.getCharacteristic(NUS_TX)
      this.decoder = new TextDecoder()
      this.framer.reset()
      tx.addEventListener('characteristicvaluechanged', this.onNotify)
      await tx.startNotifications()
      this.notify = tx
      const canWithout = rx.properties.writeWithoutResponse && typeof rx.writeValueWithoutResponse === 'function'
      this.queue = new BleWriteQueue({
        withoutResponse: canWithout ? (c) => rx.writeValueWithoutResponse(c) : undefined,
        // older Chromium has only the (deprecated) writeValue, which writes with response
        withResponse: (c) => (typeof rx.writeValueWithResponse === 'function' ? rx.writeValueWithResponse(c) : rx.writeValue(c)),
      })
      this.queue.onError = (e) => this.fail(`write failed: ${errorText(e)}`)
    } catch (e) {
      await this.disconnect()
      throw e
    }
  }

  async disconnect(): Promise<void> {
    this.closing = true
    this.queue?.close()
    this.queue = null
    const tx = this.notify
    this.notify = null
    if (tx) {
      tx.removeEventListener('characteristicvaluechanged', this.onNotify)
      try {
        await tx.stopNotifications()
      } catch {
        /* already disconnected */
      }
    }
    const d = this.device
    this.device = null
    if (d) {
      d.removeEventListener('gattserverdisconnected', this.onGattDisconnected)
      if (d.gatt?.connected) d.gatt.disconnect()
    }
  }

  write(line: string, critical = false): boolean {
    return this.queue ? this.queue.push(line, critical) : false
  }

  onLine(fn: (line: string) => void): () => void {
    return this.ev.onLine(fn)
  }

  onState(fn: (s: TransportEventState, detail?: string) => void): () => void {
    return this.ev.onState(fn)
  }

  onDrop(fn: (bytes: number) => void): () => void {
    return this.ev.onDrop(fn)
  }

  private readonly onNotify = (e: Event): void => {
    const value = (e.target as BluetoothRemoteGATTCharacteristic | null)?.value
    if (!value) return
    this.framer.push(this.decoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), { stream: true }))
  }

  private readonly onGattDisconnected = (): void => {
    this.fail('Bluetooth link dropped (out of range or board reset)')
  }

  private fail(detail: string): void {
    if (this.closing) return
    this.closing = true
    this.ev.state('closed', detail)
    void this.disconnect()
  }
}
