import type { GenContext } from '../context'
import { hasCreep } from '../cpp/walker'
import { block } from '../format'

/* ============================================================
   PYTHON WALKER — the Pi daemon's robot section for the legged
   walker. Line-for-line the same behaviour as the C++ build:
   clamp to the joint limits, map to microseconds exactly like the
   app, blend between poses, and (HIGH level) run the on-board gait
   and 3-DOF IK from the spec geometry. PCA9685 via ServoKit.
   ============================================================ */

export function pyServoOutput(): string {
  return block(String.raw`
# ===================== outputs: PCA9685 servos (Adafruit ServoKit) =====================

class ServoOutput:
    """ServoKit per PCA9685 board: channel 0-15 = first address, 16-31 = second."""

    def __init__(self):
        from adafruit_servokit import ServoKit

        self.kits = [
            ServoKit(channels=16, address=a, reference_clock_speed=PCA_OSC_HZ, frequency=PCA_FREQ_HZ)
            for a in PCA_ADDRESSES
        ]
        self.last = {}
        for ch in CHANNEL:
            self.servo(ch).set_pulse_width_range(SERVO_MIN_US, SERVO_MAX_US)
        self.all_off()

    def servo(self, ch):
        return self.kits[ch // 16].servo[ch % 16]

    def write_us(self, ch, us):
        if self.last.get(ch) == us:
            return  # unchanged: skip the I2C write
        self.last[ch] = us
        self.servo(ch).fraction = clamp((us - SERVO_MIN_US) / float(SERVO_MAX_US - SERVO_MIN_US), 0.0, 1.0)

    def off(self, ch):
        self.last.pop(ch, None)
        self.servo(ch).fraction = None  # no pulses: the servo goes limp

    def all_off(self):
        for ch in CHANNEL:
            self.off(ch)


def make_output():
    return ServoOutput()`)
}

function joints(): string {
  return block(String.raw`
# ===================== joints: clamp, map, blend =====================

class Joints:
    def __init__(self, out):
        self.out = out
        self.target = [float(v) for v in HOME]
        self.cur = list(self.target)
        self.frm = list(self.target)
        self.us = [0] * JOINTS
        self.blend_start = 0.0
        self.blend_s = 0.0
        self.enabled = False
        self.clamped = set()

    def clamp(self, j, deg):
        if not is_num(deg):
            self.clamped.add(j)
            return self.target[j]
        if deg < LIM_LO[j]:
            self.clamped.add(j)
            return LIM_LO[j]
        if deg > LIM_HI[j]:
            self.clamped.add(j)
            return LIM_HI[j]
        return float(deg)

    @staticmethod
    def to_us(j, deg):
        """Identical to jointToServoDeg + servoDegToUs in the app (src/core/hardware.ts)."""
        servo_deg = SERVO_CENTER[j] + SERVO_GAIN[j] * deg
        f = clamp(servo_deg / SERVO_RANGE_DEG, 0.0, 1.0)
        return round_half_up(SERVO_MIN_US + f * (SERVO_MAX_US - SERVO_MIN_US))

    def blend(self, now, seconds):
        """Start a smooth move from the current output pose to the targets."""
        self.frm = list(self.cur)
        self.blend_start = now
        self.blend_s = seconds

    def step(self, now):
        u = 1.0
        if self.blend_s > 0.0:
            el = now - self.blend_start
            if el >= self.blend_s:
                self.blend_s = 0.0
            else:
                u = el / self.blend_s
                u = u * u * (3.0 - 2.0 * u)  # smoothstep
        for j in range(JOINTS):
            if self.blend_s > 0.0:
                self.cur[j] = self.frm[j] + (self.target[j] - self.frm[j]) * u
            else:
                self.cur[j] = self.target[j]
            self.us[j] = self.to_us(j, self.cur[j])
            if self.enabled:
                self.out.write_us(CHANNEL[j], self.us[j])

    def enable(self, on):
        if on == self.enabled:
            return
        for j in range(JOINTS):
            self.us[j] = self.to_us(j, self.cur[j])
            if on:
                self.out.write_us(CHANNEL[j], self.us[j])
            else:
                self.out.off(CHANNEL[j])
        self.enabled = on

    def take_clamped(self):
        out = sorted(self.clamped)
        self.clamped.clear()
        return out`)
}

function gait(creep: boolean): string {
  return block(String.raw`
# ===================== on-board gait + IK (REP-103 body frame, meters) =====================

def leg_ik(leg, px, py, pz):
    """Closed-form 3-DOF leg IK (knee up), the same math as the app. Returns (q degrees, reachable)."""
    dx = px - MOUNT_X[leg]
    dy = py - MOUNT_Y[leg]
    lx = MOUNT_COS[leg] * dx + MOUNT_SIN[leg] * dy
    ly = -MOUNT_SIN[leg] * dx + MOUNT_COS[leg] * dy
    r = math.hypot(lx, ly) - COXA
    z = pz
    d = math.hypot(r, z)
    d_max = FEMUR + TIBIA - 0.001
    d_min = abs(FEMUR - TIBIA) + 0.001
    reachable = True
    if d > d_max or d < d_min:
        target = d_max if d > d_max else d_min
        if d < 1e-6:
            r, z = target, 0.0
        else:
            r *= target / d
            z *= target / d
        d = target
        reachable = False
    a1 = math.acos(clamp((FEMUR * FEMUR + d * d - TIBIA * TIBIA) / (2.0 * FEMUR * d), -1.0, 1.0))
    a2 = math.acos(clamp((FEMUR * FEMUR + TIBIA * TIBIA - d * d) / (2.0 * FEMUR * TIBIA), -1.0, 1.0))
    q = [
        math.degrees(math.atan2(ly, lx)),  # coxa, + = CCW seen from above
        math.degrees(math.atan2(z, r) + a1),  # femur, + = up
        math.degrees(a2 - math.pi / 2.0),  # tibia, + = foot out
    ]
    return q, reachable


class Gait:
    def __init__(self):
        self.v = [0.0, 0.0, 0.0]  # commanded twist vx, vy (m/s), wz (rad/s)
        self.s = [0.0, 0.0, 0.0]  # smoothed twist
        self.h = STAND_H
        self.hs = STAND_H
        self.lift = 0.0
        self.phase = 0.0
        self.index = 0
        self.active = False
        self.foot_x = list(FOOT_X)  # foot targets in the gait frame (before any body sway), m
        self.foot_y = list(FOOT_Y)
        self.foot_z = [0.0] * LEGS${creep ? '\n        self.sway_x = 0.0  # body shift over the support triangle, gait frame, m\n        self.sway_y = 0.0' : ''}

    def leg_phase(self, i):
        """Leg phase in [0, 1): stance below the duty factor, swing above (same convention as the app)."""
        return frac(self.phase - GAIT_OFFSET[self.index][i])

    def foot_speed_max(self):
        vmax = 0.0
        for i in range(LEGS):
            fx = self.s[0] - self.s[2] * FOOT_Y[i]
            fy = self.s[1] + self.s[2] * FOOT_X[i]
            vmax = max(vmax, math.hypot(fx, fy))
        return vmax

${creep ? creepPy() : ''}
    def step(self, dt, joints, misses):
        """Advance by dt and write IK joint targets. Stance feet move at exactly -(v + w x r): no foot skate."""
        a = dt / (CMD_TAU_S + dt) if dt > 0.0 else 0.0
        for k in range(3):
            self.s[k] += a * (self.v[k] - self.s[k])
        self.hs += a * (self.h - self.hs)
        moving = abs(self.v[0]) + abs(self.v[1]) + abs(self.v[2]) * FOOT_REACH > 0.002
        self.lift += a * ((1.0 if moving else 0.0) - self.lift)
        duty = GAIT_DUTY[self.index]
        vmax = self.foot_speed_max()
        # high-duty gaits keep a swing of at least SWING_MIN_S so the servos can follow it
        cycle_min = max(CYCLE_MIN_S, SWING_MIN_S / (1.0 - duty))
        cycle_max = max(CYCLE_MAX_S, cycle_min)
        cycle = cycle_max
        if vmax * cycle * duty > MAX_STRIDE:
            cycle = clamp(MAX_STRIDE / (vmax * duty), cycle_min, cycle_max)
        scale = 1.0
        if vmax * cycle * duty > MAX_STRIDE:
            scale = MAX_STRIDE / (vmax * cycle * duty)
        self.phase = frac(self.phase + ${creep ? 'self.creep_advance(duty, dt / cycle)' : 'dt / cycle'})
        lift = self.lift * STEP_H
        span = cycle * duty * scale
        for i in range(LEGS):
            ph = self.leg_phase(i)
            z = 0.0
            if ph < duty:
                k = 0.5 - ph / duty
            else:
                u = (ph - duty) / (1.0 - duty)
                k = -0.5 + 0.5 * (1.0 - math.cos(math.pi * u))
                z = lift * math.sin(math.pi * u)
            self.foot_x[i] = FOOT_X[i] + k * (self.s[0] - self.s[2] * FOOT_Y[i]) * span
            self.foot_y[i] = FOOT_Y[i] + k * (self.s[1] + self.s[2] * FOOT_X[i]) * span
            self.foot_z[i] = z${creep ? '\n        self.creep_sway(dt, duty)  # body over the support triangle' : ''}
        for i in range(LEGS):
            q, ok = leg_ik(i, ${creep ? 'self.foot_x[i] - self.sway_x, self.foot_y[i] - self.sway_y' : 'self.foot_x[i], self.foot_y[i]'}, -self.hs + self.foot_z[i])
            if not ok:
                misses.add(i)
            for m in range(3):
                j = i * 3 + m
                joints.target[j] = joints.clamp(j, q[m])`)
}

/** Python creep sway + lift-off gate for the 4-leg crawl (Gait methods), line for line ../gaitRef.ts. */
function creepPy(): string {
  return String.raw`
    # ---------- quadruped creep (crawl): three feet carry the robot while one swings ----------
    def support_tri(self, skip):
        """Triangle of the three feet other than skip: [x0, y0, x1, y1, x2, y2]."""
        t = []
        for k in range(4):
            if k != skip:
                t += [self.foot_x[k], self.foot_y[k]]
        return t

    @staticmethod
    def tri_margin(t, px, py):
        """Signed distance from (px, py) to the nearest edge of the triangle: + = inside."""
        orient = 1.0 if (t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]) >= 0.0 else -1.0
        best = float("inf")
        for e in range(3):
            n = ((e + 1) % 3) * 2
            ex = t[n] - t[e * 2]
            ey = t[n + 1] - t[e * 2 + 1]
            length = math.hypot(ex, ey)
            d = orient * (ex * (py - t[e * 2 + 1]) - ey * (px - t[e * 2])) / length if length > 1e-9 else -float("inf")
            best = min(best, d)
        return best

    def creep_point(self, skip):
        """From the un-swayed body toward the incentre, the first point CREEP_MARGIN inside (None if degenerate)."""
        t = self.support_tri(skip)
        a = math.hypot(t[4] - t[2], t[5] - t[3])
        b = math.hypot(t[0] - t[4], t[1] - t[5])
        c = math.hypot(t[2] - t[0], t[3] - t[1])
        p = a + b + c
        area2 = abs((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]))
        if p < 1e-9 or area2 < 1e-6 * p * p:
            return None
        ix = (a * t[0] + b * t[2] + c * t[4]) / p
        iy = (a * t[1] + b * t[3] + c * t[5]) / p
        r = self.tri_margin(t, ix, iy)
        m0 = self.tri_margin(t, 0.0, 0.0)
        k = 0.0 if m0 >= CREEP_MARGIN else (min(1.0, (CREEP_MARGIN - m0) / (r - m0)) if r > m0 else 1.0)
        return ix * k, iy * k

    def creep_advance(self, duty, dph):
        """Phase step the lift-off gate allows: the next foot waits until the body is over the other three."""
        if not GAIT_CREEP[self.index] or self.lift < CREEP_MIN_LIFT:
            return dph
        nxt, wait = 0, 2.0
        for k in range(4):
            psi = self.leg_phase(k)
            if psi >= duty:
                return dph  # a foot is already up: its triangle was checked at lift-off
            if duty - psi < wait:
                nxt, wait = k, duty - psi
        if wait > dph:
            return dph
        if self.tri_margin(self.support_tri(nxt), self.sway_x, self.sway_y) >= CREEP_GATE:
            return dph
        return wait - 1e-4 if wait > 1e-4 else 0.0

    def creep_target(self, duty):
        """The swinging foot's creep point, or the last foot's blended into the next one's across the four-feet phase."""
        nxt = prev = 0
        wait = ago = 2.0
        for k in range(4):
            psi = self.leg_phase(k)
            if psi >= duty:
                return self.creep_point(k)
            if duty - psi < wait:
                nxt, wait = k, duty - psi
            if psi < ago:
                prev, ago = k, psi
        a = self.creep_point(prev)
        b = self.creep_point(nxt)
        if a is None or b is None:
            return None
        u = clamp(ago / max((ago + wait) * SWAY_ARRIVE, 1e-6), 0.0, 1.0)
        u = u * u * (3.0 - 2.0 * u)
        return a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u

    def creep_sway(self, dt, duty):
        """Low-pass the body toward the target (scaled by the step fade), capped at SWAY_MAX_SPEED."""
        target = self.creep_target(duty) if GAIT_CREEP[self.index] and self.lift > 1e-4 else None
        tx, ty = (target[0] * self.lift, target[1] * self.lift) if target is not None else (0.0, 0.0)
        g = dt / (SWAY_TAU_S + dt) if dt > 0.0 else 0.0
        dx = (tx - self.sway_x) * g
        dy = (ty - self.sway_y) * g
        step = math.hypot(dx, dy)
        cap = SWAY_MAX_SPEED * dt
        if step > cap:
            dx *= cap / step
            dy *= cap / step
        self.sway_x += dx
        self.sway_y += dy
`
}

function robotCommon(high: boolean): string {
  const homeStop = high ? '\n        self.gait_stop()  # HOME always wins over a running gait' : ''
  return block(String.raw`
# ===================== robot: walker (${high ? 'on-board gait + IK' : 'joint streaming'}) =====================

class Robot:
    def __init__(self, out):
        self.j = Joints(out)
        self.home_done_at = 0.0
        self.notes = []
        self.ik_miss = set()${high ? '\n        self.gait = Gait()\n        self.gait.index = GAIT_KEY.get(GAIT_NAME[0], 0)' : ''}

    def caps(self):
        caps = []
        if hook_num(read_joint_deg, 0) is not None:
            caps.append("feedback")
        if hook_num(read_load, 0) is not None:
            caps.append("load")
        return caps

    def note(self, msg):
        if msg not in self.notes:
            self.notes.append(msg)

    def home_start(self, now):${homeStop}
        self.j.target = [float(v) for v in HOME]
        if not self.j.enabled:
            # pose unknown (power-up or relaxed): jump to home and give the servos time to arrive
            self.j.cur = list(self.j.target)
            self.j.blend_s = 0.0
            self.j.enable(True)
            self.home_done_at = now + HOME_SETTLE_MS / 1000.0
        else:
            self.j.blend(now, HOME_RAMP_MS / 1000.0)
            self.home_done_at = now + HOME_RAMP_MS / 1000.0

    def home_done(self, now):
        return now >= self.home_done_at

    def apply_q(self, q):
        if not isinstance(q, list) or len(q) != JOINTS:
            n = len(q) if isinstance(q, list) else 0
            self.note("cmd q has %d values, this robot has %d" % (n, JOINTS))
            return False
        for j, v in enumerate(q):
            self.j.target[j] = self.j.clamp(j, v)
        return True

    def telemetry(self, tel):
        ang = []
        for j in range(JOINTS):
            m = hook_num(read_joint_deg, j)
            ang.append(round(m if m is not None else self.j.cur[j], 2))
        tel["ang"] = ang
        if hook_num(read_load, 0) is not None:
            loads = []
            for i in range(LEGS):
                v = hook_num(read_load, i)
                loads.append(round(clamp(v if v is not None else 0.0, 0.0, 1.0), 3))
            tel["load"] = loads

    def flush_logs(self):
        out = list(self.notes)
        self.notes = []
        clamped = self.j.take_clamped()
        if len(clamped) == 1:
            out.append("servo %d (%s) clamped" % (clamped[0], JOINT_NAME[clamped[0]]))
        elif clamped:
            out.append("servos " + ", ".join(str(j) for j in clamped) + " clamped")
        if self.ik_miss:
            out.append("IK: foot target out of reach on leg " + " ".join("L%d" % (i + 1) for i in sorted(self.ik_miss)))
            self.ik_miss.clear()
        return out`)
}

function jointLevelRobot(): string {
  return String.raw`
    def command(self, msg, now):
        q = msg.get("q")
        if q is None:
            if msg.get("v") is not None:
                self.note("this daemon streams joints (q); regenerate at the HIGH level for v")
            return False
        return self.apply_q(q)

    def control(self, dt, now):
        self.j.step(now)

    def safe(self, relax):
        if relax:
            self.j.enable(False)  # hold: the targets simply stay where they are

    def estop(self):
        self.j.enable(False)`
}

function highLevelRobot(): string {
  return String.raw`
    def gait_stop(self):
        self.gait.v = [0.0, 0.0, 0.0]
        self.gait.active = False

    def apply_twist(self, msg, v, now):
        if not isinstance(v, list) or len(v) != 3 or not all(is_num(x) for x in v):
            self.note("cmd v must be [vx, vy, wz]")
            return False
        self.gait.v = [float(x) for x in v]
        mode = msg.get("mode")
        if isinstance(mode, str):
            if mode in GAIT_KEY:
                self.gait.index = GAIT_KEY[mode]
            else:
                self.note("unknown gait '%s', keeping %s" % (mode[:24], GAIT_NAME[self.gait.index]))
        h = msg.get("h")
        if is_num(h):
            self.gait.h = clamp(float(h), H_MIN, H_MAX)
        if not self.gait.active:
            self.gait.active = True
            self.gait.s = [0.0, 0.0, 0.0]
            self.gait.hs = self.gait.h
            self.gait.lift = 0.0
            self.gait.sway_x = self.gait.sway_y = 0.0  # the body starts centred (4-leg crawl)
            self.gait.step(0.0, self.j, self.ik_miss)  # stance targets at the current phase
            self.j.blend(now, HOME_RAMP_MS / 1000.0)  # ease from the current pose into the stance
        return True

    def command(self, msg, now):
        q = msg.get("q")
        if q is not None:
            self.gait.active = False  # joint streaming takes over
            return self.apply_q(q)
        v = msg.get("v")
        if v is None:
            return False
        return self.apply_twist(msg, v, now)

    def control(self, dt, now):
        if self.gait.active:
            self.gait.step(dt, self.j, self.ik_miss)  # a running blend eases toward the moving targets
        self.j.step(now)

    def safe(self, relax):
        self.gait.v = [0.0, 0.0, 0.0]  # stop walking, the feet settle into the stance
        if relax:
            self.gait_stop()
            self.j.enable(False)

    def estop(self):
        self.gait_stop()
        self.j.enable(False)`
}

export function pyWalker(ctx: GenContext): string {
  const high = ctx.level === 'high' && ctx.walker !== null
  const parts = [pyServoOutput(), joints()]
  if (high && ctx.walker) parts.push(gait(hasCreep(ctx.walker)))
  parts.push(`${robotCommon(high)}\n${high ? highLevelRobot() : jointLevelRobot()}`)
  return parts.join('\n\n\n')
}
