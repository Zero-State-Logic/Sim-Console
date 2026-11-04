import { useRef } from 'react'
import { useConsole } from '../store'
import { runtime } from '../core/runtime'
import { recorder, useRecorder } from '../core/recorder'
import { ROBOT_KINDS } from '../robots'
import { openCodegenDialog } from '../codegen/ui'
import { resetSim, setQuality, switchRobot, togglePlay, toggleRecording } from './actions'
import { WithTip } from './controls/Hint'
import { SPEED_STEPS, formatClock, formatSpeed } from './layoutMath'
import { importRecording } from './recording/Timeline'
import { useRaf } from './useRaf'
import { useUi } from './uiStore'

/*
 * Top bar: brand, robot switcher, profiles, REC, sim speed, clock, transport, firmware,
 * quality and help. The clock is written to the DOM on rAF (never 60 Hz React state).
 * Text labels sit in .lbl spans so narrow layouts can drop them to icons (shell.css).
 */

function BrandMark() {
  return (
    <svg className="mark" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M2 7V2h5M17 2h5v5M22 17v5h-5M7 22H2v-5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 3.5v5M12 15.5v5M3.5 12h5M15.5 12h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="12" r="3.2" className="mark-dot" />
    </svg>
  )
}

function Clock() {
  const el = useRef<HTMLSpanElement>(null)
  const last = useRef('')
  useRaf(() => {
    const t = recorder.isReplaying() ? recorder.cursor() : runtime.t
    const text = formatClock(t)
    if (text === last.current || !el.current) return
    last.current = text
    el.current.textContent = text
  }, 20)
  return (
    <span className="clock" aria-label="Sim time">
      <span className="ck-k" aria-hidden="true">T+</span>
      <span ref={el}>00:00.0</span>
    </span>
  )
}

function RobotSwitcher() {
  const robot = useConsole((s) => s.robot)
  return (
    <nav className="robotsel" aria-label="Robot">
      {ROBOT_KINDS.map((r, i) => (
        <button
          key={r.kind}
          type="button"
          className={robot === r.kind ? 'on' : ''}
          aria-pressed={robot === r.kind}
          onClick={() => switchRobot(r.kind)}
          title={`${r.label} (${i + 1})`}
        >
          <span className="rk" aria-hidden="true">{i + 1}</span>
          {r.label}
        </button>
      ))}
    </nav>
  )
}

function SpeedControl() {
  const speed = useConsole((s) => s.timeScale)
  const setTimeScale = useConsole((s) => s.setTimeScale)
  return (
    <div className="speedsel" role="group" aria-label="Sim speed">
      {SPEED_STEPS.map((s) => (
        <button
          key={s}
          type="button"
          className={speed === s ? 'on' : ''}
          aria-pressed={speed === s}
          aria-label={`Sim speed ${s}×`}
          onClick={() => setTimeScale(s)}
        >
          {formatSpeed(s)}
        </button>
      ))}
    </div>
  )
}

function RecButton() {
  const recording = useRecorder((s) => s.recording)
  const replaying = useRecorder((s) => s.replaying)
  return (
    <div className="recgrp">
      <WithTip tip={recording ? 'Stop recording' : 'Record 30 Hz snapshots + telemetry (120 s buffer)'}>
        <button
          type="button"
          className={`tbtn rec${recording ? ' on' : ''}`}
          aria-pressed={recording}
          aria-label={recording ? 'Stop recording' : 'Start recording'}
          onClick={toggleRecording}
          disabled={replaying}
        >
          <span className="rd" aria-hidden="true" />
          {recording ? 'STOP' : 'REC'}
        </button>
      </WithTip>
      <WithTip tip="Open a recording (.json)">
        <button type="button" className="tbtn icon" onClick={() => void importRecording()} aria-label="Open a recording">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v3h11v-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
      </WithTip>
    </div>
  )
}

function Transport() {
  const playing = useConsole((s) => s.playing)
  const replaying = useRecorder((s) => s.replaying)
  const replayPlaying = useRecorder((s) => s.replayPlaying)
  const isRunning = replaying ? replayPlaying : playing
  return (
    <div className="transport">
      <button
        type="button"
        className={`tbtn play${isRunning ? ' on' : ''}`}
        onClick={togglePlay}
        aria-label={isRunning ? 'Pause (Space)' : 'Play (Space)'}
        title={isRunning ? 'Pause (Space)' : 'Play (Space)'}
      >
        <span className="pi" aria-hidden="true">{isRunning ? '❚❚' : '▶'}</span>
        <span className="lbl">{isRunning ? 'PAUSE' : 'PLAY'}</span>
      </button>
      <button type="button" className="tbtn" onClick={resetSim} aria-label="Reset (R)" title="Reset (R)">
        <span className="pi" aria-hidden="true">↺</span>
        <span className="lbl">RESET</span>
      </button>
    </div>
  )
}

function QualityToggle() {
  const quality = useConsole((s) => s.quality)
  const tip = quality === 'high' ? 'HIGH: ambient occlusion, bloom, SMAA. Click for LOW.' : 'LOW: plain rendering for weak GPUs. Click for HIGH.'
  return (
    <WithTip tip={tip}>
      <button
        type="button"
        className={`tbtn qual ${quality}`}
        onClick={() => setQuality(quality === 'high' ? 'low' : 'high')}
        aria-label={`Render quality ${quality === 'high' ? 'HIGH' : 'LOW'}, click to switch`}
      >
        <span className="qbars" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        {quality === 'high' ? 'HQ' : 'LQ'}
      </button>
    </WithTip>
  )
}

function RailToggle({ side }: { side: 'left' | 'right' }) {
  const open = useUi((s) => s.railOpen === side)
  const toggle = useUi((s) => s.toggleRail)
  return (
    <button
      type="button"
      className={`tbtn railtog ${side}${open ? ' on' : ''}`}
      aria-pressed={open}
      aria-controls={side === 'left' ? 'rail-instruments' : 'rail-controls'}
      aria-label={side === 'left' ? 'Show instruments panel' : 'Show controls panel'}
      onClick={() => toggle(side)}
    >
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
        <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <rect x={side === 'left' ? 3 : 9} y="4" width="4" height="8" rx="0.5" fill="currentColor" />
      </svg>
      <span className="lbl">{side === 'left' ? 'INSTR' : 'CTRL'}</span>
    </button>
  )
}

export default function TopBar() {
  const setProfilesOpen = useUi((s) => s.setProfilesOpen)
  const setHelpOpen = useUi((s) => s.setHelpOpen)

  return (
    <header className="topbar">
      <div className="tb-left">
        <RailToggle side="left" />
        <div className="brand" aria-label="SIM CONSOLE">
          <BrandMark />
          <span className="brand-name">
            SIM<span className="brand-gap"> </span>CONSOLE<span className="dot">.</span>
          </span>
        </div>
        <RobotSwitcher />
        <button type="button" className="tbtn ghost profiles" onClick={() => setProfilesOpen(true)} aria-label="Profiles">
          <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
            <path d="M2.5 3.5h11M2.5 8h11M2.5 12.5h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <span className="lbl">PROFILES</span>
        </button>
      </div>
      <div className="tb-right">
        <RecButton />
        <span className="tb-sep" aria-hidden="true" />
        <SpeedControl />
        <Clock />
        <Transport />
        <span className="tb-sep" aria-hidden="true" />
        <button type="button" className="tbtn fw" onClick={openCodegenDialog} aria-label="Firmware generator" title="Generate firmware for your board">
          <span className="pi" aria-hidden="true">{'</>'}</span>
          <span className="lbl">FIRMWARE</span>
        </button>
        <QualityToggle />
        <WithTip tip="Help and shortcuts (?)">
          <button type="button" className="tbtn icon" onClick={() => setHelpOpen(true)} aria-label="Help and keyboard shortcuts">
            ?
          </button>
        </WithTip>
        <RailToggle side="right" />
      </div>
    </header>
  )
}
