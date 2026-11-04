import { HIGH, INPUT, INPUT_PULLUP, LOW, OUTPUT } from './boards'

/* ============================================================
   VIRTUAL GPIO — pin modes, digital levels, PWM duty and an ADC
   that returns deterministic pseudo-noise (the same sketch reads
   the same values at the same virtual time, every run).
   ============================================================ */

interface PinState {
  mode: number
  level: number
  /** PWM duty 0..1 from analogWrite. */
  duty: number
}

/** 32-bit integer hash (lowbias32 by Chris Wellons), deterministic and well mixed. */
export function hash32(a: number, b = 0): number {
  let x = (Math.imul(a | 0, 0x9e3779b1) ^ (b | 0)) >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/** Unit-range [0, 1) value from a hash. */
function unit(h: number): number {
  return h / 4294967296
}

/**
 * ADC reading in 0..1: each pin sits at its own level, drifts slowly and has about
 * +-2 LSB of noise at 10 bits. Pure function of (pin, virtual ms).
 */
export function analogLevel(pin: number, nowMs: number): number {
  const h = hash32(pin, 0x51ed)
  const base = 0.25 + 0.5 * unit(h)
  const freq = 0.05 + 0.25 * unit(hash32(h, 7))
  const drift = 0.06 * Math.sin(2 * Math.PI * freq * (nowMs / 1000) + 6.2832 * unit(hash32(h, 3)))
  const noise = (unit(hash32(h, Math.floor(nowMs))) - 0.5) * (4 / 1023)
  return Math.min(Math.max(base + drift + noise, 0), 1)
}

export class Pins {
  private pins = new Map<number, PinState>()
  private adcBits: number
  private pwmBits = 8

  constructor(readonly ledPin: number, private readonly defaultAdcBits: number) {
    this.adcBits = defaultAdcBits
  }

  private get(pin: number): PinState {
    let p = this.pins.get(pin)
    if (!p) {
      p = { mode: INPUT, level: LOW, duty: 0 }
      this.pins.set(pin, p)
    }
    return p
  }

  pinMode(pin: number, mode: number): void {
    const p = this.get(pin)
    p.mode = mode
    if (mode === INPUT_PULLUP) p.level = HIGH
  }

  digitalWrite(pin: number, value: number): void {
    const p = this.get(pin)
    p.level = value !== 0 ? HIGH : LOW
    p.duty = p.level
  }

  /** OUTPUT pins read back their level, pull-ups read HIGH, floating inputs read LOW. */
  digitalRead(pin: number): number {
    const p = this.pins.get(pin)
    if (!p) return LOW
    if (p.mode === OUTPUT) return p.level
    return p.mode === INPUT_PULLUP ? HIGH : LOW
  }

  analogWrite(pin: number, value: number): void {
    const max = 2 ** this.pwmBits - 1
    const p = this.get(pin)
    p.duty = Math.min(Math.max(value, 0), max) / max
    p.level = p.duty >= 0.5 ? HIGH : LOW
  }

  analogRead(pin: number, nowMs: number): number {
    const max = 2 ** this.adcBits - 1
    return Math.round(analogLevel(pin, nowMs) * max)
  }

  analogReadResolution(bits: number): void {
    this.adcBits = Math.min(Math.max(Math.round(bits), 1), 16)
  }

  analogWriteResolution(bits: number): void {
    this.pwmBits = Math.min(Math.max(Math.round(bits), 1), 16)
  }

  /** LED_BUILTIN brightness 0..1. */
  get led(): number {
    return this.pins.get(this.ledPin)?.duty ?? 0
  }

  reset(): void {
    this.pins.clear()
    this.adcBits = this.defaultAdcBits
    this.pwmBits = 8
  }
}
