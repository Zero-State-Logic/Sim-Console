/*
 * Battery model from momentum theory. A rotor making thrust T in hover draws ideal
 * induced power T^1.5 / sqrt(2ρA); dividing by the figure of merit and the
 * motor/ESC efficiency gives electrical power. 3S 850 mAh pack (≈ 9.4 Wh), which
 * puts a 250-class quad at roughly 6 minutes of hover, like the real thing.
 */

export interface BatteryParams {
  /** Usable pack energy, J. */
  capacityJ: number
  /** Air density, kg/m³. */
  rho: number
  /** Prop disk radius, m. */
  propRadius: number
  /** Rotor figure of merit (0..1). */
  figureOfMerit: number
  /** Motor + ESC efficiency (0..1). */
  driveEfficiency: number
  /** Flight controller, radio, LEDs, W (drawn only while armed). */
  avionicsW: number
}

export const PACK_3S_850: Readonly<BatteryParams> = {
  capacityJ: 11.1 * 0.85 * 3600,
  rho: 1.225,
  propRadius: 0.0635,
  figureOfMerit: 0.55,
  driveEfficiency: 0.8,
  avionicsW: 2.5,
}

/** Electrical power (W) for the given rotor thrusts (N). */
export function rotorPower(thrusts: ArrayLike<number>, b: BatteryParams): number {
  const area = Math.PI * b.propRadius * b.propRadius
  const k = 1 / (Math.sqrt(2 * b.rho * area) * b.figureOfMerit * b.driveEfficiency)
  let pw = 0
  for (let i = 0; i < thrusts.length; i++) {
    const t = thrusts[i] > 0 ? thrusts[i] : 0
    pw += k * t * Math.sqrt(t)
  }
  return pw
}

export class Battery {
  /** State of charge, 0..1. */
  soc = 1
  /** Last electrical power, W. */
  power = 0

  constructor(readonly params: Readonly<BatteryParams> = PACK_3S_850) {}

  /** Drain for h seconds at the given rotor thrusts. Never increases the charge. */
  drain(h: number, thrusts: ArrayLike<number>, armed: boolean): void {
    if (!armed || h <= 0) {
      this.power = 0
      return
    }
    this.power = rotorPower(thrusts, this.params) + this.params.avionicsW
    this.soc = Math.max(0, this.soc - (this.power * h) / this.params.capacityJ)
  }

  get percent(): number {
    return this.soc * 100
  }

  /** Pack voltage estimate (3S LiPo, linear 12.6 V full -> 10.5 V empty, minus sag). */
  voltage(): number {
    const sag = this.power / 11.1 * 0.02
    return 10.5 + 2.1 * this.soc - sag
  }

  reset(soc = 1): void {
    this.soc = Math.min(Math.max(soc, 0), 1)
    this.power = 0
  }
}
