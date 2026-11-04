/*
 * First-run tour: the steps and the pure logic behind them (card placement, the saved
 * "seen it" flag). The overlay in Tour.tsx only renders what these functions decide.
 */

export interface TourStep {
  id: string
  /** CSS selector of the element to spotlight; null shows a centred card. */
  target: string | null
  title: string
  body: string
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'welcome',
    target: null,
    title: 'Welcome to SIM CONSOLE',
    body: 'One bench, three robots. Simulate them, link a real board, or drive them with your own code, and every instrument reads the same telemetry. This short tour shows you around.',
  },
  {
    id: 'robots',
    target: '.robotsel',
    title: 'Pick a robot',
    body: 'WALKER is a 4, 6 or 8-leg spider, SWEEPER a mecanum robot with a LiDAR, SWARM a fleet of quadrotors. The keys 1, 2 and 3 switch between them too.',
  },
  {
    id: 'world',
    target: '.viewport',
    title: 'The 3D world',
    body: 'Drag to orbit, right-drag to pan, scroll to zoom. On the sweeper you can drag obstacles around; on the swarm, click the ground to drop waypoints.',
  },
  {
    id: 'cameras',
    target: '.hud-cams',
    title: 'Camera views',
    body: 'Jump to ISO, FRONT, SIDE or TOP, or FOLLOW the robot (F). The C key cycles through the views.',
  },
  {
    id: 'controls',
    target: '#rail-controls',
    title: 'Drive the robot',
    body: 'Every robot keeps its controls here: legs, gait, speed, body pose, controller gains. Use the direction pad or W A S D to move, Q and E to turn.',
  },
  {
    id: 'source',
    target: '.dswitch',
    title: 'Choose who is in control',
    body: 'SIM runs the simulator. HARDWARE links your ESP32, Pico, STM32 or Pi over USB, Bluetooth or WiFi (try the Virtual Device, no board needed). CODE runs your own Arduino C++ or JavaScript.',
  },
  {
    id: 'instruments',
    target: '#rail-instruments',
    title: 'Read the instruments',
    body: 'Gauges, live charts, per-leg loads and readouts. They show the same telemetry whether the sim, a real board or your code is driving.',
  },
  {
    id: 'record',
    target: '.recgrp',
    title: 'Record and replay',
    body: 'REC captures up to two minutes of motion and telemetry. Scrub it back on the timeline or export it as CSV. Space pauses, R resets.',
  },
  {
    id: 'firmware',
    target: '.tbtn.fw',
    title: 'Firmware for your board',
    body: 'Generates the code for your board and wiring: paste one header, add two lines to your sketch, flash it, then connect from HARDWARE.',
  },
  {
    id: 'help',
    target: '[aria-label="Help and keyboard shortcuts"]',
    title: 'You are all set',
    body: 'Shortcuts, browser support and this tour live under Help whenever you need them. Have fun building.',
  },
]

/* ---------------- placement ---------------- */

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

export interface Placement {
  x: number
  y: number
  side: 'center' | 'bottom' | 'top' | 'right' | 'left' | 'inside'
}

const GAP = 14
const MARGIN = 12

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi))
}

/**
 * Where the card goes: beside the target if it fits (below, right, left, then above),
 * otherwise inside the target near its bottom (large areas such as the 3D view), and
 * centred when there is no visible target.
 */
export function placeCard(target: Box | null, card: { w: number; h: number }, view: { w: number; h: number }): Placement {
  const maxX = view.w - card.w - MARGIN
  const maxY = view.h - card.h - MARGIN
  if (!target) return { x: clamp((view.w - card.w) / 2, MARGIN, maxX), y: clamp((view.h - card.h) / 2, MARGIN, maxY), side: 'center' }
  const cx = target.x + target.w / 2
  const cy = target.y + target.h / 2
  const fitsX = (x: number): boolean => x >= MARGIN && x <= maxX
  const fitsY = (y: number): boolean => y >= MARGIN && y <= maxY

  const below = target.y + target.h + GAP
  if (fitsY(below)) return { x: clamp(cx - card.w / 2, MARGIN, maxX), y: below, side: 'bottom' }
  const right = target.x + target.w + GAP
  if (fitsX(right)) return { x: right, y: clamp(cy - card.h / 2, MARGIN, maxY), side: 'right' }
  const left = target.x - GAP - card.w
  if (fitsX(left)) return { x: left, y: clamp(cy - card.h / 2, MARGIN, maxY), side: 'left' }
  const above = target.y - GAP - card.h
  if (fitsY(above)) return { x: clamp(cx - card.w / 2, MARGIN, maxX), y: above, side: 'top' }
  return {
    x: clamp(cx - card.w / 2, MARGIN, maxX),
    y: clamp(target.y + target.h - card.h - GAP * 2, MARGIN, maxY),
    side: 'inside',
  }
}

/** A rect counts as a target only when it is on screen and not collapsed (hidden rails). */
export function visibleBox(r: { left: number; top: number; width: number; height: number } | null, view: { w: number; h: number }): Box | null {
  if (!r || r.width < 4 || r.height < 4) return null
  if (r.left >= view.w || r.top >= view.h || r.left + r.width <= 0 || r.top + r.height <= 0) return null
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

/* ---------------- "seen it" flag ---------------- */

export const TOUR_STORAGE_KEY = 'simconsole.tour.v1'
export type TourOutcome = 'done' | 'skipped'

/** Parse the stored flag (untrusted text): only the two known outcomes count. */
export function parseTourFlag(raw: string | null): TourOutcome | null {
  return raw === 'done' || raw === 'skipped' ? raw : null
}

/** Show the tour on first launch, or when the URL asks for it with ?tour. */
export function shouldAutoStart(stored: TourOutcome | null, search: string): boolean {
  const params = new URLSearchParams(search)
  if (params.has('tour')) return params.get('tour') !== '0'
  return stored === null
}
