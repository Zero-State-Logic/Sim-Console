import { MAX_LINE_BYTES } from '../../core/protocol'
import { FW_ID, LINK_TITLE, WS_PORT } from '../context'
import type { GenContext, SweeperCtx, WalkerCtx } from '../context'
import { helloObject, PCA_OSC_HZ, MOTOR_PWM_HZ } from '../cpp/header'
import { hasCreep } from '../cpp/walker'
import { CREEP } from '../creep'
import { SCAN_BINS, WHEEL_TUNING } from '../cpp/sweeper'
import { block, commentSafe, pyFloat, pyFloatList, pyList, pyString } from '../format'
import type { LibInfo } from '../libraries'
import { hex2 } from '../servoMap'
import type { GeneratedFile } from '../types'
import { pyBridge, pyHeader, pyHelpers, pyLinks, pyMain } from './core'
import { pySweeper } from './sweeper'
import { pyWalker } from './walker'

/* ============================================================
   PI ZERO 2 W DAEMON — kiyobridge.py (asyncio), requirements.txt
   and kiyobridge.service. The generated configuration block holds
   every number the robot needs; the code below it is shared.
   ============================================================ */

/** Motion update rate on the Pi; servo pulses are 50 Hz anyway. */
export const PI_CONTROL_HZ = 50
export const PI_FOLDER = 'kiyobridge_pi'
export const PI_SERIAL_PORT = '/dev/ttyGS0'
export const PI_LD06_PORT = '/dev/serial0'
const DEG = Math.PI / 180

const pyBool = (b: boolean): string => (b ? 'True' : 'False')
const pyInts = (v: number[], perLine = 16): string => pyList(v.map((n) => String(Math.round(n))), perLine)

function timing(ctx: GenContext): string {
  const hw = ctx.hw
  return block(String.raw`
# ===================== configuration (generated) =====================
FW = ${pyString(FW_ID)}
WS_HOST = "0.0.0.0"
WS_PORT = ${WS_PORT}
SERIAL_PORT = ${pyString(PI_SERIAL_PORT)}
BAUD = ${hw.baud}  # the USB serial gadget ignores it
TEL_HZ = ${hw.telemetryHz}
CONTROL_HZ = ${PI_CONTROL_HZ}
WATCHDOG_MS = ${hw.watchdogMs}  # no cmd for this long trips the watchdog
WATCHDOG_RELAX = ${pyBool(hw.watchdogAction === 'relax')}  # False = hold the last pose, True = outputs off (send home again)
HOME_SETTLE_MS = 600  # first home after power-up: servos jump, wait for them
HOME_RAMP_MS = 800  # later homes: smooth move from the current pose
MAX_LINE = ${MAX_LINE_BYTES}  # longest accepted command line, bytes
LOG_PERIOD_S = 1.0  # diagnostics are rate-limited to one line per kind per second

HELLO = ${JSON.stringify(helloObject(ctx))}
CAPS = ${JSON.stringify(ctx.caps)}`)
}

function outputs(ctx: GenContext): string {
  const addrs = ctx.pcaBoards > 1 ? [0x40, 0x41] : [0x40]
  const freq = ctx.robot === 'sweeper' ? MOTOR_PWM_HZ : 50
  const lines = [
    `JOINTS = ${ctx.joints}`,
    ctx.robot === 'walker' ? `LEGS = ${ctx.legs}` : `WHEELS = ${ctx.wheels}`,
    `JOINT_NAME = ${pyList(ctx.names.map((n) => pyString(n)), 6)}`,
    `# PCA9685 channel per ${ctx.robot === 'walker' ? 'joint' : 'wheel (motor PWM)'}: 0-15 on board 0x40, 16-31 on board 0x41`,
    `CHANNEL = ${pyInts(ctx.hw.servoPins.slice(0, ctx.joints))}`,
    `PCA_ADDRESSES = [${addrs.map(hex2).join(', ')}]`,
    `PCA_OSC_HZ = ${PCA_OSC_HZ}  # calibrate with a scope if pulses are off`,
    `PCA_FREQ_HZ = ${freq}`,
  ]
  return lines.join('\n')
}

function servoTables(ctx: GenContext): string {
  return block(String.raw`
LIM_LO = ${pyFloatList(ctx.limits.map((l) => l[0]), 2)}
LIM_HI = ${pyFloatList(ctx.limits.map((l) => l[1]), 2)}
HOME = ${pyFloatList(ctx.home, 2)}
# servo mapping, identical to the app: servo_deg = center + gain * joint_deg
SERVO_CENTER = ${pyFloatList(ctx.servo.center, 4)}
SERVO_GAIN = ${pyFloatList(ctx.servo.gain, 4)}
SERVO_RANGE_DEG = ${pyFloat(ctx.servo.rangeDeg, 3)}
SERVO_MIN_US = ${ctx.servo.minUs}
SERVO_MAX_US = ${ctx.servo.maxUs}`)
}

function gaitConfig(w: WalkerCtx): string {
  const g = w.geom
  const t = w.tuning
  const keys: Record<string, number> = {}
  w.gaits.forEach((gd, i) => {
    for (const k of [gd.name, ...gd.aliases]) if (!(k in keys)) keys[k] = i
  })
  return block(String.raw`
# ---------- on-board gait + IK (REP-103 body frame: x forward, y left, z up; meters) ----------
COXA = ${pyFloat(g.coxa)}
FEMUR = ${pyFloat(g.femur)}
TIBIA = ${pyFloat(g.tibia)}
STAND_H = ${pyFloat(g.standHeight)}  # default body height (cmd h overrides)
FOOT_REACH = ${pyFloat(g.footReach)}  # coxa axis to neutral foot, horizontal
H_MIN = ${pyFloat(t.heightMin)}
H_MAX = ${pyFloat(t.heightMax)}
# tuning: edit freely
STEP_H = ${pyFloat(t.stepHeight)}  # swing foot lift
MAX_STRIDE = ${pyFloat(t.maxStride)}  # longest foot travel per stance
CYCLE_MIN_S = ${pyFloat(t.cycleMinS)}
CYCLE_MAX_S = ${pyFloat(t.cycleMaxS)}
SWING_MIN_S = ${pyFloat(t.swingMinS)}  # shortest swing the servos can follow (slow gaits get a longer cycle)
CMD_TAU_S = ${pyFloat(t.cmdTauS)}  # command smoothing time constant
MOUNT_X = ${pyFloatList(g.mountX)}
MOUNT_Y = ${pyFloatList(g.mountY)}
MOUNT_COS = ${pyFloatList(g.mountYawDeg.map((d) => Math.cos(d * DEG)))}
MOUNT_SIN = ${pyFloatList(g.mountYawDeg.map((d) => Math.sin(d * DEG)))}
FOOT_X = ${pyFloatList(w.neutralX)}
FOOT_Y = ${pyFloatList(w.neutralY)}
# gait = duty factor + per-leg phase offset; names the app may send in cmd.mode
GAIT_NAME = ${pyList(w.gaits.map((gd) => pyString(gd.name)))}
GAIT_DUTY = ${pyFloatList(w.gaits.map((gd) => gd.duty), 4)}
GAIT_OFFSET = ${pyList(w.gaits.map((gd) => pyFloatList(gd.offsets, 4, 8)), 1)}
GAIT_KEY = ${JSON.stringify(keys)}${hasCreep(w) ? creepConfig(w) : ''}`)
}

function creepConfig(w: WalkerCtx): string {
  return String.raw`
# quadruped creep (crawl): the body shifts over the three planted feet before a foot lifts
CREEP_MARGIN = ${pyFloat(CREEP.margin)}  # the body aims this far inside the support triangle
CREEP_GATE = ${pyFloat(CREEP.gate)}  # a foot lifts only once the body is this far inside
CREEP_MIN_LIFT = ${pyFloat(CREEP.minLift)}  # no gate while the step height is faded out
SWAY_TAU_S = ${pyFloat(CREEP.tauS)}  # body sway smoothing
SWAY_MAX_SPEED = ${pyFloat(CREEP.maxSpeed)}  # m/s, keeps the shift within servo speed
SWAY_ARRIVE = ${pyFloat(CREEP.arrive)}  # reach the next triangle after this much of the four-feet phase
GAIT_CREEP = ${pyList(w.gaits.map((gd) => pyBool(gd.creep)))}`
}

function sweeperConfig(ctx: GenContext): string {
  const s = ctx.sweeper as SweeperCtx
  const dir = ctx.hw.jointInvert.slice(0, 4).map((inv, i) => (inv ? -1 : 1) * (ctx.hw.jointScale[i] ?? 1))
  return block(String.raw`
# ---------- mecanum base (REP-103: x forward, y left; wheel order ${commentSafe(s.wheels.map((w) => w.name).join(', '))}) ----------
WHEEL_RADIUS = ${pyFloat(s.geom.wheelRadius)}
MAX_WHEEL_SPEED = ${pyFloat(s.geom.maxWheelSpeed)}  # rad/s at full PWM
WHEEL_ACCEL = ${pyFloat(WHEEL_TUNING.accel)}  # rad/s^2, keeps the wheels from slipping
# speed loop, used only when read_wheel_speed() returns numbers
WHEEL_KP = ${pyFloat(WHEEL_TUNING.kp)}
WHEEL_KI = ${pyFloat(WHEEL_TUNING.ki)}
WHEEL_I_MAX = ${pyFloat(WHEEL_TUNING.iMax)}
# w_i * r = vx - wz * y_i + k_i * (vy + wz * x_i)
WHEEL_X = ${pyFloatList(s.wheels.map((w) => w.x))}
WHEEL_Y = ${pyFloatList(s.wheels.map((w) => w.y))}
WHEEL_K = ${pyFloatList(s.wheels.map((w) => w.k))}
# least-squares forward kinematics: [vx, vy, wz] = FK * w
FK = ${pyList(s.forward.map((row) => pyFloatList(row, 6)), 1)}
WHEEL_DIR = ${pyFloatList(dir, 4)}  # motor polarity x scale (jointInvert / jointScale in the app)
# motor driver lines (TB6612FNG-style), all PCA9685 channels
IN1 = ${pyInts(s.motors.in1)}
IN2 = ${pyInts(s.motors.in2)}
STBY = ${s.motors.stby}
# optional LD06 LiDAR on the Pi UART (enable it: sudo raspi-config nonint do_serial_hw 0)
LD06 = False  # True = read an LD06 and send its scan in telemetry
LD06_PORT = ${pyString(PI_LD06_PORT)}
LD06_YAW_DEG = 0.0  # LiDAR mounting yaw: its 0 deg relative to the robot's forward
SCAN_BINS = ${SCAN_BINS}  # ${360 / SCAN_BINS} deg bins sent in telemetry`)
}

function hooks(ctx: GenContext): string {
  const robotHooks =
    ctx.robot === 'walker'
      ? String.raw`
def read_joint_deg(joint):
    """Measured joint angle, degrees joint space (servo feedback)."""
    return None


def read_load(leg):
    """Foot load 0..1 (force sensor)."""
    return None

`
      : String.raw`
def read_wheel_speed(wheel):
    """Encoder speed, rad/s, + = forward. Returning numbers turns on the speed loop."""
    return None

`
  return block(String.raw`
# ===================== optional hooks: edit to add live data =====================
# Return None for "no data" and the field is simply left out of the telemetry.
${robotHooks}
def read_imu():
    """(roll, pitch, yaw) in degrees, e.g. from an MPU6050 / BNO055 on the same I2C bus."""
    return None


def read_vbat():
    """Battery volts, e.g. from an INA219 / ADS1115."""
    return None`)
}

function dryRun(): string {
  return block(String.raw`
class DryRunOutput:
    """--dry-run: no PCA9685, the outputs are only remembered (check them with --stdio)."""

    def __init__(self):
        self.us = {}
        self.duty = {}

    def write_us(self, ch, us):
        self.us[ch] = us

    def off(self, ch):
        self.us.pop(ch, None)

    def all_off(self):
        self.us.clear()
        self.duty.clear()

    def set_duty(self, ch, duty):
        self.duty[ch] = duty

    def set_digital(self, ch, high):
        self.duty[ch] = 1.0 if high else 0.0`)
}

function configBlock(ctx: GenContext): string {
  const parts = [timing(ctx), outputs(ctx)]
  if (ctx.robot === 'walker') parts.push(servoTables(ctx))
  if (ctx.robot === 'walker' && ctx.walker && ctx.level === 'high') parts.push(gaitConfig(ctx.walker))
  if (ctx.robot === 'sweeper') parts.push(sweeperConfig(ctx))
  return parts.join('\n\n')
}

export function buildDaemon(ctx: GenContext): string {
  const robot = ctx.robot === 'walker' ? pyWalker(ctx) : pySweeper()
  const sections = [
    pyHeader(ctx, LINK_TITLE[ctx.link]),
    configBlock(ctx),
    hooks(ctx),
    pyHelpers(),
    dryRun(),
    robot,
    pyBridge(),
    pyLinks(),
    pyMain(ctx),
  ]
  return `${sections.join('\n\n\n')}\n`
}

export function buildRequirements(ctx: GenContext, libs: LibInfo[]): string {
  const lines = ['# SIM CONSOLE kiyobridge daemon, Raspberry Pi Zero 2 W', '# install: .venv/bin/pip install -r requirements.txt']
  for (const l of libs) lines.push(`${l.name}${l.version}`)
  if (ctx.robot === 'sweeper' && !libs.some((l) => l.name === 'pyserial')) lines.push('pyserial>=3.5  # only for the optional LD06 (LD06 = True)')
  return `${lines.join('\n')}\n`
}

export function buildService(ctx: GenContext): string {
  const ws = ctx.link === 'ws'
  const after = ws ? 'network-online.target' : `dev-${PI_SERIAL_PORT.replace('/dev/', '')}.device`
  return block(String.raw`
# kiyobridge.service - starts the SIM CONSOLE bridge at boot (${commentSafe(ctx.robotLabel)}, ${LINK_TITLE[ctx.link]})
# Install: edit User= and the paths, then
#   sudo cp kiyobridge.service /etc/systemd/system/
#   sudo systemctl daemon-reload && sudo systemctl enable --now kiyobridge
# Logs: journalctl -u kiyobridge -f
[Unit]
Description=SIM CONSOLE kiyobridge (${ctx.robot})
After=${after}
Wants=${after}

[Service]
Type=simple
# change "pi" to your username and /home/pi/kiyobridge to where you copied the folder
User=pi
WorkingDirectory=/home/pi/kiyobridge
ExecStart=/home/pi/kiyobridge/.venv/bin/python /home/pi/kiyobridge/kiyobridge.py --link ${ctx.link}
Restart=on-failure
RestartSec=2
SupplementaryGroups=i2c dialout gpio
Environment=PYTHONUNBUFFERED=1${ws ? `\n# port ${WS_PORT} is below 1024: allow binding it without root\nAmbientCapabilities=CAP_NET_BIND_SERVICE` : ''}

[Install]
WantedBy=multi-user.target
`)
}

/** Every file of the Pi build except the README (assembled by the entry point). */
export function buildPiFiles(ctx: GenContext, libs: LibInfo[]): GeneratedFile[] {
  return [
    { path: `${PI_FOLDER}/kiyobridge.py`, language: 'python', content: buildDaemon(ctx) },
    { path: `${PI_FOLDER}/requirements.txt`, language: 'text', content: buildRequirements(ctx, libs) },
    { path: `${PI_FOLDER}/kiyobridge.service`, language: 'ini', content: buildService(ctx) },
  ]
}
