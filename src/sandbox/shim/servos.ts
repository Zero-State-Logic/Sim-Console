import type { HardwareConfig } from '../../core/hardware'
import type { HwMap } from '../protocol'
import {
  PCA_ADDR_BASE,
  gpioJoint,
  hwConfig,
  pcaJoint,
  pcaTicksToUs,
  pinLabel,
  servoWriteToUs,
  usToJointDeg,
  usToServoWrite,
  type JointRoute,
} from './servoMap'

/* ============================================================
   Servo (Servo.h / ESP32Servo.h) and Adafruit_PWMServoDriver
   objects. Every pulse becomes a joint command through the
   hardware profile: pulse -> servo degrees -> joint degrees.
   ============================================================ */

/** Sink for joint commands and one-time notes (implemented by the shim). */
export interface ServoSink {
  setJoint(joint: number, deg: number): void
  warnOnce(key: string, text: string): void
}

interface ServoObj {
  kind: 'servo'
  pin: number
  route: JointRoute | null
  minUs: number
  maxUs: number
  us: number
  attached: boolean
}

interface PcaObj {
  kind: 'pca'
  addr: number
  freq: number
}

const DEFAULT_PCA_FREQ = 50
const PCA_MIN_FREQ = 24
const PCA_MAX_FREQ = 1526

export class ServoBank {
  private objs = new Map<number, ServoObj | PcaObj>()
  private nextHandle = 1
  private readonly cfg: HardwareConfig

  constructor(private readonly hw: HwMap, private readonly sink: ServoSink) {
    this.cfg = hwConfig(hw)
  }

  /* ---------------- Servo ---------------- */

  createServo(): number {
    const h = this.nextHandle++
    const mid = (this.hw.servoMinUs + this.hw.servoMaxUs) / 2
    // attach(pin) without limits uses the profile's pulse range, so write(90) is neutral
    this.objs.set(h, { kind: 'servo', pin: -1, route: null, minUs: this.hw.servoMinUs, maxUs: this.hw.servoMaxUs, us: mid, attached: false })
    return h
  }

  private servo(h: number | null): ServoObj | null {
    const o = h === null ? undefined : this.objs.get(h)
    return o && o.kind === 'servo' ? o : null
  }

  /** Returns the servo channel index (handle - 1), or 255 (INVALID_SERVO) on bad limits. */
  attach(h: number | null, pin: number, minUs?: number, maxUs?: number): number {
    const s = this.servo(h)
    if (!s) return 255
    const lo = minUs ?? this.hw.servoMinUs
    const hi = maxUs ?? this.hw.servoMaxUs
    if (!(hi > lo)) {
      this.sink.warnOnce(`servo-range-${pin}`, `Servo.attach(${pin}, ${lo}, ${hi}): max must be above min; servo not attached.`)
      return 255
    }
    s.pin = Math.trunc(pin)
    s.minUs = lo
    s.maxUs = hi
    s.attached = true
    s.route = gpioJoint(this.hw, s.pin)
    if (!s.route || s.route.fallback) this.noteRoute(s.route, 'gpio', s.pin, `Servo.attach(${pinLabel(this.hw, 'gpio', s.pin)})`)
    return (h ?? 1) - 1
  }

  write(h: number | null, value: number): void {
    const s = this.servo(h)
    if (!s) return
    this.pulse(s, servoWriteToUs(value, s.minUs, s.maxUs))
  }

  writeMicroseconds(h: number | null, us: number): void {
    const s = this.servo(h)
    if (!s) return
    this.pulse(s, Math.min(Math.max(us, s.minUs), s.maxUs))
  }

  read(h: number | null): number {
    const s = this.servo(h)
    return s ? usToServoWrite(s.us, s.minUs, s.maxUs) : 0
  }

  readMicroseconds(h: number | null): number {
    const s = this.servo(h)
    return s ? Math.round(s.us) : 0
  }

  attached(h: number | null): boolean {
    return this.servo(h)?.attached ?? false
  }

  detach(h: number | null): void {
    const s = this.servo(h)
    if (s) s.attached = false
  }

  private pulse(s: ServoObj, us: number): void {
    s.us = us
    if (!s.attached) return
    if (s.route) this.sink.setJoint(s.route.joint, usToJointDeg(this.cfg, s.route.joint, us))
  }

  /* ---------------- PCA9685 ---------------- */

  createPca(addr?: number): number {
    const h = this.nextHandle++
    const a = typeof addr === 'number' && Number.isInteger(addr) && addr >= PCA_ADDR_BASE && addr < PCA_ADDR_BASE + 64 ? addr : PCA_ADDR_BASE
    this.objs.set(h, { kind: 'pca', addr: a, freq: DEFAULT_PCA_FREQ })
    return h
  }

  private pca(h: number | null): PcaObj | null {
    const o = h === null ? undefined : this.objs.get(h)
    return o && o.kind === 'pca' ? o : null
  }

  setPWMFreq(h: number | null, freq: number): void {
    const p = this.pca(h)
    if (p) p.freq = Math.min(Math.max(freq, PCA_MIN_FREQ), PCA_MAX_FREQ)
  }

  setPWM(h: number | null, ch: number, on: number, off: number): void {
    const p = this.pca(h)
    if (!p) return
    const us = pcaTicksToUs(Math.trunc(on), Math.trunc(off), p.freq)
    if (us !== null) this.pcaPulse(p, Math.trunc(ch), us)
  }

  /** setPin(ch, value, invert): duty in ticks with the pulse starting at 0. */
  setPin(h: number | null, ch: number, value: number, invert = false): void {
    const v = Math.min(Math.max(Math.trunc(value), 0), 4095)
    this.setPWM(h, ch, 0, invert ? 4095 - v : v)
  }

  pcaWriteMicroseconds(h: number | null, ch: number, us: number): void {
    const p = this.pca(h)
    if (p) this.pcaPulse(p, Math.trunc(ch), us)
  }

  /** True if any PCA9685 object answers at this I2C address. */
  hasPcaAt(addr: number): boolean {
    for (const o of this.objs.values()) if (o.kind === 'pca' && o.addr === addr) return true
    return false
  }

  private pcaPulse(p: PcaObj, ch: number, us: number): void {
    const route = pcaJoint(this.hw, p.addr, ch)
    if (!route || route.fallback) this.noteRoute(route, 'pca9685', ch, `PCA9685 0x${p.addr.toString(16)} channel ${ch}`)
    if (!route) return
    // the servo only sees pulses inside its calibrated range
    const clamped = Math.min(Math.max(us, this.hw.servoMinUs), this.hw.servoMaxUs)
    this.sink.setJoint(route.joint, usToJointDeg(this.cfg, route.joint, clamped))
  }

  private noteRoute(route: JointRoute | null, driver: 'gpio' | 'pca9685', pin: number, what: string): void {
    if (!route) {
      this.sink.warnOnce(`unmapped-${driver}-${pin}`, `${what} is not in the hardware profile's servo map, so it drives no joint. Check HARDWARE > pin map.`)
      return
    }
    if (route.fallback) {
      const msg = driver === 'gpio'
        ? 'The hardware profile drives servos through a PCA9685, so Servo pins are matched against the board\'s default GPIO order.'
        : 'The hardware profile drives servos from GPIO, so PCA9685 channel n is mapped to joint n.'
      this.sink.warnOnce(`fallback-${driver}`, msg)
    }
  }

  reset(): void {
    this.objs.clear()
    this.nextHandle = 1
  }
}
