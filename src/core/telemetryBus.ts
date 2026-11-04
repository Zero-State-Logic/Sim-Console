import type { TelemetryFrame } from './types'

export const EMPTY_FRAME: TelemetryFrame = { t: 0, gauges: {}, channels: {}, bars: [], readouts: {} }

// A mutable single-frame bus. The runtime writes it each frame; instruments read it
// on their own rAF and paint directly to canvas/DOM — no React re-render churn.
export const telemetryBus: { current: TelemetryFrame } = { current: EMPTY_FRAME }
