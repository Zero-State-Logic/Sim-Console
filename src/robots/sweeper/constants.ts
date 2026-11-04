/*
 * SWEEPER constants: geometry of the romi_nav twin and its LD06 LiDAR.
 * Units: meters, seconds, radians. The 2D plan frame is REP-103 (x forward/east,
 * y left/north, heading CCW from +x). three.js maps plan (x, y) to (x, ·, -y).
 */

/** Mecanum wheel radius. */
export const WHEEL_RADIUS = 0.04
/** Wheel contact x offset from the body center (half wheelbase). */
export const HALF_LENGTH = 0.095
/** Wheel contact y offset from the body center (half track). */
export const HALF_WIDTH = 0.105
/** Collision footprint half extents (chassis + wheels + bumpers): 0.30 x 0.25 m. */
export const FOOT_HX = 0.15
export const FOOT_HY = 0.125
/** Circumscribed footprint radius, what the planner inflates by. */
export const ROBOT_RADIUS = Math.hypot(FOOT_HX, FOOT_HY)

/**
 * Motor limits. 15 rad/s = 143 rpm, 0.6 m/s at the rim: the no-load speed of a Romi-class
 * 120:1 gearmotor (about 150 rpm), kept a little under so the speed loop has headroom.
 * 40 rad/s^2 = 1.6 m/s^2 (0.16 g) straight ahead, 1.13 m/s^2 diagonally, under what rubber
 * mecanum rollers grip on a hard floor, so the wheels do not spin out. The generated
 * firmware ramps its wheel setpoints with the same limit (KIYO_WHEEL_ACCEL).
 */
export const MAX_WHEEL_SPEED = 15
export const MAX_WHEEL_ACCEL = 40

/**
 * LD06 model, from the LDROBOT datasheet: 4500 samples/s at a 10 Hz turn (450 per turn,
 * 0.8 deg apart), 0.02-12 m. The 1-sigma range noise is max(10 mm, 1 % of range), the
 * accuracy class of this kind of triangulation-free (DTOF) sensor.
 */
export const LIDAR_OFFSET_X = 0.02
export const LIDAR_HEIGHT = 0.142
export const LIDAR_RATE_HZ = 10
export const LIDAR_SAMPLES = 450
export const LIDAR_MIN_RANGE = 0.02
export const LIDAR_MAX_RANGE = 12
/** 1-sigma range noise: max(10 mm, 1 % of range), times the LIDAR NOISE control. */
export const LIDAR_SIGMA_ABS = 0.01
export const LIDAR_SIGMA_REL = 0.01

/** Occupancy / coverage cell size and the margin of grid kept outside the walls. */
export const CELL_SIZE = 0.05
export const GRID_MARGIN = 0.15

/** Physics substep. Everything runs at 120 Hz regardless of the frame rate. */
export const SUBSTEP = 1 / 120

/** Arena (visual walls sit outside the free interior). */
export const ARENA_MIN = 3
export const ARENA_MAX = 10
export const ARENA_DEFAULT = 6
export const WALL_THICKNESS = 0.06
export const WALL_HEIGHT = 0.3
export const MAX_OBSTACLES = 48

/** Brush deck depth along the heading (the width is a control). */
export const BRUSH_DEPTH = 0.08

/** Planner rates. */
export const REPLAN_PERIOD = 0.5
export const GOAL_TOLERANCE = 0.05

export const DEG = Math.PI / 180

export const MODES = ['coverage', 'goto', 'teleop', 'wander'] as const
export type NavMode = (typeof MODES)[number]

export const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'] as const
