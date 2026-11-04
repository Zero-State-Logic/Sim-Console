import { useEffect, useMemo, useState } from 'react'
import { fitConfigToSpec, useHardware } from '../../core/hardware'
import type { HardwareConfig } from '../../core/hardware'
import type { BoardId } from '../../core/protocol'
import { runtime } from '../../core/runtime'
import type { CommandLevel, HardwareSpec } from '../../core/types'
import { useConsole } from '../../store'
import { generateFirmware } from '../index'
import ConfigPanel from './ConfigPanel'
import { buildRequest, defaultLevelFor, effectiveTransport } from './model'
import type { LinkTransport } from './model'
import OutputPanel from './OutputPanel'

/* ============================================================
   FIRMWARE DIALOG BODY (lazy-loaded with CodeMirror and fflate).
   Reads the active robot's HardwareSpec and the shared hardware
   profile, and regenerates the firmware on every change. The
   generator is pure and takes a few milliseconds.
   ============================================================ */

interface Target {
  spec: HardwareSpec
  label: string
}

function useTarget(): Target {
  const robot = useConsole((s) => s.robot)
  const layoutRev = useConsole((s) => s.layoutRev)
  return useMemo(() => {
    const m = runtime.module
    return { spec: m.getHardwareSpec(), label: m.label }
  }, [robot, layoutRev]) // the change signals for the module and its joint count
}

export default function CodegenPanel() {
  const { spec, label } = useTarget()
  const config = useHardware((s) => s.config)
  const setConfig = useHardware((s) => s.setConfig)
  const setBoard = useHardware((s) => s.setBoard)
  const hw = useMemo(() => fitConfigToSpec(config, spec), [config, spec])
  const [level, setLevel] = useState<CommandLevel>(() => defaultLevelFor(spec, effectiveTransport(hw)))

  // keep the stored profile's per-joint arrays the size of the robot (leg count changes)
  useEffect(() => {
    useHardware.getState().syncToSpec(spec)
  }, [spec])

  const result = useMemo(() => generateFirmware(buildRequest(spec, hw, label, spec.robot === 'swarm' ? 'high' : level)), [spec, hw, label, level])

  const onBoard = (b: BoardId) => {
    setBoard(b)
    setLevel(defaultLevelFor(spec, effectiveTransport({ board: b, transport: useHardware.getState().config.transport })))
  }
  const onTransport = (t: LinkTransport) => {
    setConfig({ transport: t })
    setLevel(defaultLevelFor(spec, t))
  }
  const onPatch = (patch: Partial<HardwareConfig>) => setConfig(patch)

  return (
    <div className="cg-body">
      <ConfigPanel spec={spec} hw={hw} level={level} onLevel={setLevel} onBoard={onBoard} onTransport={onTransport} onPatch={onPatch} />
      <OutputPanel result={result} />
    </div>
  )
}
