import { describe, expect, it } from 'vitest'
import { ArenaEditor } from './editor'
import type { Obstacle } from './geom2d'
import { Rng } from './rng'

const HALF = 3
const ROBOT = { x: -2.45, y: -2.45, th: 0 }

function editorWith(obstacles: Obstacle[]): ArenaEditor {
  const e = new ArenaEditor()
  e.setAll(obstacles)
  return e
}

const box = (id: number, x: number, y: number, w = 0.6, h = 0.4, a = 0): Obstacle => ({ kind: 'box', id, x, y, w, h, a, hgt: 0.5 })
const cyl = (id: number, x: number, y: number, r = 0.2): Obstacle => ({ kind: 'cyl', id, x, y, r, hgt: 0.5 })

describe('selection', () => {
  it('selects known ids, reports changes and ignores unknown ids', () => {
    const e = editorWith([box(1, 0, 0)])
    expect(e.select(1)).toBe(true)
    expect(e.select(1)).toBe(false)
    expect(e.select(99)).toBe(true)
    expect(e.selected).toBeNull()
  })
})

describe('dragging', () => {
  it('moves the grabbed obstacle by the pointer delta, keeping the grab offset', () => {
    // Arrange: grab 0.1 m right of the center
    const e = editorWith([box(1, 0, 0)])
    const before = e.obstacles
    e.beginDrag(1, 0.1, 0, 0.5, false)
    // Act
    const moved = e.dragTo(1.1, 0.5, HALF, ROBOT)
    // Assert
    expect(moved?.x).toBeCloseTo(1)
    expect(moved?.y).toBeCloseTo(0.5)
    expect(before[0].x).toBe(0)
    expect(e.obstacles).not.toBe(before)
  })

  it('slides up to another obstacle instead of overlapping it', () => {
    const e = editorWith([cyl(1, 0, 0, 0.2), cyl(2, 1, 0, 0.2)])
    e.beginDrag(1, 0, 0, 0.5, false)
    const moved = e.dragTo(1, 0, HALF, ROBOT)
    expect(moved).not.toBeNull()
    const gap = Math.hypot((moved as Obstacle).x - 1, (moved as Obstacle).y) - 0.4
    expect(gap).toBeGreaterThanOrEqual(0)
    expect(gap).toBeLessThan(0.01)
  })

  it('keeps the obstacle inside the room and off the robot', () => {
    const e = editorWith([cyl(1, 0, 0, 0.2)])
    e.beginDrag(1, 0, 0, 0.5, false)
    const out = e.dragTo(10, 0, HALF, ROBOT)
    expect((out as Obstacle).x).toBeCloseTo(HALF - 0.2)
    e.dragTo(ROBOT.x, ROBOT.y, HALF, ROBOT)
    expect(e.fits(e.obstacles[0], HALF, ROBOT)).toBe(true)
  })

  it('rotates a box about its center with Alt and leaves cylinders unrotated', () => {
    const e = editorWith([box(1, 0, 0, 1, 0.3), cyl(2, 2, 2)])
    e.beginDrag(1, 0.5, 0, 0.5, true)
    const turned = e.dragTo(0, 0.5, HALF, ROBOT)
    expect(turned?.kind === 'box' && turned.a).toBeCloseTo(Math.PI / 2)
    expect(turned?.x).toBe(0)
    e.endDrag()
    e.beginDrag(2, 2.2, 2, 0.5, true)
    expect(e.dragTo(2.3, 2, HALF, ROBOT)?.x).toBeCloseTo(2.1)
  })

  it('returns null when not dragging and reports whether a drag ended', () => {
    const e = editorWith([box(1, 0, 0)])
    expect(e.dragTo(1, 1, HALF, ROBOT)).toBeNull()
    expect(e.endDrag()).toBe(false)
    e.beginDrag(1, 0, 0, 0.25, false)
    expect(e.dragging).toBe(true)
    expect(e.dragPlaneY).toBe(0.25)
    expect(e.endDrag()).toBe(true)
  })
})

describe('arena actions', () => {
  it('adds a selected obstacle with a fresh id and removes the selection', () => {
    const e = editorWith([box(4, 0, 0)])
    const o = e.add('cyl', new Rng(3), 6, ROBOT)
    expect(o?.kind).toBe('cyl')
    expect(o?.id).toBe(5)
    expect(e.selected).toBe(5)
    expect(e.removeSelected()).toBe(true)
    expect(e.obstacles.map((x) => x.id)).toEqual([4])
    expect(e.removeSelected()).toBe(false)
  })

  it('randomizes a room that keeps the robot clear, and clears everything', () => {
    const e = new ArenaEditor()
    e.randomize(new Rng(11), 6, ROBOT)
    expect(e.obstacles.length).toBeGreaterThan(4)
    for (const o of e.obstacles) expect(e.fits(o, HALF, ROBOT)).toBe(true)
    e.clear()
    expect(e.obstacles).toHaveLength(0)
  })
})
