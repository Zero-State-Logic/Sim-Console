import { defaultHardwareConfig, defaultServoPins, servoToJointDeg, type HardwareConfig, type ServoDriver } from '../../core/hardware'
import type { HwMap } from '../protocol'

/* ============================================================
   SERVO OUTPUT -> JOINT MAPPING. Servo.attach(pin) and PCA9685
   channels go through the same hardware profile the firmware
   generator writes, so a real servo sketch drives the virtual
   robot unchanged when the pins match.
   ============================================================ */

/** Arduino Servo.h: write() values below this are degrees, the rest are microseconds. */
export const MIN_PULSE_WIDTH = 544
export const PCA_ADDR_BASE = 0x40
export const PCA_CHANNELS = 16
export const PCA_TICKS = 4096

export interface JointRoute {
  joint: number
  /** Set when the pin was matched through a fallback map (driver mismatch). */
  fallback: boolean
}

/** Full HardwareConfig view of the map, so the core conversion functions apply unchanged. */
export function hwConfig(hw: HwMap): HardwareConfig {
  return { ...defaultHardwareConfig(hw.board, hw.servoPins.length), ...hw }
}

function route(pins: readonly number[], pin: number, fallback: boolean): JointRoute | null {
  const joint = pins.indexOf(pin)
  return joint >= 0 ? { joint, fallback } : null
}

/**
 * Joint driven by a GPIO servo pin. With a PCA9685 profile there is no GPIO map, so the
 * board's default GPIO order (what the codegen would pick for direct drive) is used.
 */
export function gpioJoint(hw: HwMap, pin: number): JointRoute | null {
  if (!Number.isInteger(pin) || pin < 0) return null
  if (hw.servoDriver === 'gpio') return route(hw.servoPins, pin, false)
  return route(defaultServoPins(hw.board, 'gpio', hw.servoPins.length), pin, true)
}

/** Global PCA9685 channel: 0-15 on the board at 0x40, 16-31 at 0x41, ... */
export function pcaGlobalChannel(addr: number, ch: number): number {
  return (addr - PCA_ADDR_BASE) * PCA_CHANNELS + ch
}

/** Joint driven by a PCA9685 channel. A GPIO profile falls back to channel n = joint n. */
export function pcaJoint(hw: HwMap, addr: number, ch: number): JointRoute | null {
  if (!Number.isInteger(ch) || ch < 0 || ch >= PCA_CHANNELS) return null
  const global = pcaGlobalChannel(addr, ch)
  if (global < 0) return null
  if (hw.servoDriver === 'pca9685') return route(hw.servoPins, global, false)
  return route(defaultServoPins(hw.board, 'pca9685', hw.servoPins.length), global, true)
}

type PulseRange = Pick<HwMap, 'servoMinUs' | 'servoMaxUs' | 'servoRangeDeg'>

/** Physical servo angle for a pulse width, from the profile's calibrated pulse range. */
export function usToServoDeg(p: PulseRange, us: number): number {
  const f = (us - p.servoMinUs) / (p.servoMaxUs - p.servoMinUs)
  return Math.min(Math.max(f, 0), 1) * p.servoRangeDeg
}

/** Joint-space degrees for a servo pulse on a joint (inverse of the firmware's mapping). */
export function usToJointDeg(cfg: HardwareConfig, joint: number, us: number): number {
  return servoToJointDeg(cfg, joint, usToServoDeg(cfg, us))
}

/** Servo.write(deg): degrees 0..180 map linearly onto the attach() pulse range. */
export function servoWriteToUs(value: number, minUs: number, maxUs: number): number {
  if (value >= MIN_PULSE_WIDTH) return Math.min(Math.max(value, minUs), maxUs)
  const deg = Math.min(Math.max(value, 0), 180)
  return minUs + (deg / 180) * (maxUs - minUs)
}

/** Servo.read(): Arduino maps the pulse back to 0..180 degrees, rounded. */
export function usToServoWrite(us: number, minUs: number, maxUs: number): number {
  return Math.round(((us - minUs) / (maxUs - minUs)) * 180)
}

/** PCA9685 pulse width in microseconds for an on/off tick pair, or null for no pulse. */
export function pcaTicksToUs(on: number, off: number, freqHz: number): number | null {
  // bit 12 set = full ON / full OFF: a constant level, not a servo pulse
  if (on >= PCA_TICKS || off >= PCA_TICKS) return null
  const ticks = (((off - on) % PCA_TICKS) + PCA_TICKS) % PCA_TICKS
  if (ticks === 0) return null
  return (ticks * 1_000_000) / (freqHz * PCA_TICKS)
}

/** Label of a pin as the user wrote it (STM32 names for the STM32 board). */
export function pinLabel(hw: HwMap, driver: ServoDriver, pin: number): string {
  if (driver === 'pca9685') return `channel ${pin}`
  if (hw.board === 'stm32' && pin >= 0 && pin < 48) return `P${String.fromCharCode(65 + Math.floor(pin / 16))}${pin % 16}`
  return `pin ${pin}`
}
