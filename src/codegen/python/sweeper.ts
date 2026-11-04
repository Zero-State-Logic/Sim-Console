import { block } from '../format'

/* ============================================================
   PYTHON SWEEPER — the Pi daemon's robot section for the mecanum
   sweeper: 4 DC motors through a TB6612-style driver whose PWM,
   IN1, IN2 and STBY lines all sit on PCA9685 channels, mecanum
   mixing for cmd v, wheel speeds for cmd w, an optional encoder
   PI loop, odometry, and an optional LD06 reader. Same behaviour
   as the C++ build.
   ============================================================ */

function motorOutput(): string {
  return block(String.raw`
# ===================== outputs: PCA9685 motor driver lines =====================

class MotorOutput:
    """PCA9685 at PCA_FREQ_HZ: PWM per wheel, IN1 / IN2 / STBY as full-on / full-off channels."""

    def __init__(self):
        import board
        from adafruit_pca9685 import PCA9685  # installed with adafruit-circuitpython-servokit

        i2c = board.I2C()
        self.boards = []
        for a in PCA_ADDRESSES:
            pca = PCA9685(i2c, address=a, reference_clock_speed=PCA_OSC_HZ)
            pca.frequency = PCA_FREQ_HZ
            self.boards.append(pca)
        self.last = {}
        self.all_off()

    def set_duty(self, ch, duty):
        value = round_half_up(clamp(duty, 0.0, 1.0) * 0xFFFF)
        if self.last.get(ch) == value:
            return  # unchanged: skip the I2C write
        self.last[ch] = value
        self.boards[ch // 16].channels[ch % 16].duty_cycle = value

    def set_digital(self, ch, high):
        self.set_duty(ch, 1.0 if high else 0.0)

    def all_off(self):
        for ch in list(CHANNEL) + list(IN1) + list(IN2) + [STBY]:
            self.set_duty(ch, 0.0)


def make_output():
    return MotorOutput()`)
}

function ld06(): string {
  return block(String.raw`
# ===================== optional LD06 LiDAR (230400 baud UART) =====================

class Ld06:
    """47-byte packets: header, speed, start angle, 12 x (mm, intensity), end angle, time, CRC-8 (poly 0x4D)."""

    def __init__(self):
        self.crc = []
        for i in range(256):
            c = i
            for _ in range(8):
                c = ((c << 1) ^ 0x4D) & 0xFF if c & 0x80 else (c << 1) & 0xFF
            self.crc.append(c)
        self.pkt = bytearray()
        self.bins = [0.0] * SCAN_BINS
        self.scan = None
        self.last = 0.0
        self.bad = 0
        self.lock = threading.Lock()

    def start(self):
        import serial  # pyserial

        ser = serial.Serial(LD06_PORT, 230400, timeout=0.1)
        threading.Thread(target=self.reader, args=(ser,), daemon=True).start()
        info("LD06 on %s" % LD06_PORT)

    def reader(self, ser):
        while True:
            data = ser.read(512)
            if data:
                self.feed(data)

    def feed(self, data):
        for b in data:
            n = len(self.pkt)
            if n == 0:
                if b == 0x54:
                    self.pkt.append(b)
                continue
            if n == 1:
                if b == 0x2C:
                    self.pkt.append(b)
                elif b != 0x54:
                    self.pkt.clear()
                continue
            self.pkt.append(b)
            if len(self.pkt) == 47:
                self.decode(bytes(self.pkt))
                self.pkt.clear()

    def decode(self, p):
        crc = 0
        for i in range(46):
            crc = self.crc[(crc ^ p[i]) & 0xFF]
        if crc != p[46]:
            self.bad += 1
            return
        start = (p[4] | (p[5] << 8)) * 0.01
        stop = (p[42] | (p[43] << 8)) * 0.01
        if stop < start:
            stop += 360.0
        step = (stop - start) / 11.0
        for i in range(12):
            cw = start + step * i
            if cw >= 360.0:
                cw -= 360.0
            if cw + 180.0 < self.last:
                self.revolution()  # the angle wrapped: one full turn collected
            self.last = cw
            mm = p[6 + 3 * i] | (p[7 + 3 * i] << 8)
            if mm == 0:
                continue
            ccw = (LD06_YAW_DEG - cw) % 360.0  # LD06 turns clockwise, the app wants CCW from forward
            b = min(int(ccw * SCAN_BINS / 360.0), SCAN_BINS - 1)
            m = mm * 0.001
            if self.bins[b] == 0.0 or m < self.bins[b]:
                self.bins[b] = m

    def revolution(self):
        with self.lock:
            self.scan = list(self.bins)
        self.bins = [0.0] * SCAN_BINS

    def take(self):
        with self.lock:
            scan, self.scan = self.scan, None
        return scan`)
}

function robot(): string {
  return block(String.raw`
# ===================== robot: mecanum sweeper =====================

class Robot:
    def __init__(self, out):
        self.out = out
        self.target = [0.0] * WHEELS  # rad/s after saturation
        self.cmd = [0.0] * WHEELS  # rad/s after the acceleration limit
        self.meas = [0.0] * WHEELS  # encoder speed, or cmd without encoders
        self.integ = [0.0] * WHEELS
        self.odo = [0.0, 0.0, 0.0]  # x, y (m), heading (rad)
        self.motors_on = False
        self.limited = False
        self.notes = []
        self.home_done_at = 0.0
        self.lidar = Ld06() if LD06 else None
        if self.lidar is not None:
            self.lidar.start()
        self.motors_off()

    def caps(self):
        caps = []
        if hook_num(read_wheel_speed, 0) is not None:
            caps.append("encoders")
        if self.lidar is not None:
            caps.append("lidar")
        return caps

    def note(self, msg):
        if msg not in self.notes:
            self.notes.append(msg)

    def motor_write(self, i, duty, brake):
        """duty -1..1. At zero: short brake (both IN high) or coast (both low)."""
        mag = abs(duty)
        if mag < 0.004:
            self.out.set_digital(IN1[i], brake)
            self.out.set_digital(IN2[i], brake)
            self.out.set_duty(CHANNEL[i], 0.0)
            return
        self.out.set_digital(IN1[i], duty > 0.0)
        self.out.set_digital(IN2[i], duty < 0.0)
        self.out.set_duty(CHANNEL[i], mag)

    def wheels_zero(self, reset_cmd):
        for i in range(WHEELS):
            self.target[i] = 0.0
            self.integ[i] = 0.0
            if reset_cmd:
                self.cmd[i] = 0.0
                self.meas[i] = 0.0

    def motors_off(self):
        for i in range(WHEELS):
            self.motor_write(i, 0.0, False)
        self.out.set_digital(STBY, False)
        self.motors_on = False

    def home_start(self, now):
        self.wheels_zero(True)
        self.odo = [0.0, 0.0, 0.0]
        self.out.set_digital(STBY, True)
        self.motors_on = True
        self.home_done_at = now  # stopped wheels are the home pose

    def home_done(self, now):
        return now >= self.home_done_at

    def mix(self, vx, vy, wz):
        """Mecanum inverse kinematics: body twist -> wheel speeds (rad/s)."""
        for i in range(WHEELS):
            self.target[i] = (vx - wz * WHEEL_Y[i] + WHEEL_K[i] * (vy + wz * WHEEL_X[i])) / WHEEL_RADIUS

    def command(self, msg, now):
        w = msg.get("w")
        v = msg.get("v")
        if w is not None:
            if not isinstance(w, list) or len(w) != WHEELS:
                self.note("cmd w must have 4 wheel speeds")
                return False
            self.target = [float(s) if is_num(s) else 0.0 for s in w]
        elif isinstance(v, list) and len(v) == 3 and all(is_num(x) for x in v):
            self.mix(float(v[0]), float(v[1]), float(v[2]))
        else:
            return False
        # saturate as one vector so the robot keeps its heading and only slows down
        peak = max(abs(s) for s in self.target)
        if peak > MAX_WHEEL_SPEED:
            k = MAX_WHEEL_SPEED / peak
            self.target = [s * k for s in self.target]
            self.limited = True
        return True

    def odometry(self, dt):
        vx = sum(FK[0][i] * self.meas[i] for i in range(WHEELS))
        vy = sum(FK[1][i] * self.meas[i] for i in range(WHEELS))
        wz = sum(FK[2][i] * self.meas[i] for i in range(WHEELS))
        c = math.cos(self.odo[2])
        s = math.sin(self.odo[2])
        self.odo[0] += (vx * c - vy * s) * dt
        self.odo[1] += (vx * s + vy * c) * dt
        self.odo[2] = math.atan2(math.sin(self.odo[2] + wz * dt), math.cos(self.odo[2] + wz * dt))

    def control(self, dt, now):
        peak = max(abs(self.target[i] - self.cmd[i]) for i in range(WHEELS))
        max_step = WHEEL_ACCEL * dt
        k = max_step / peak if peak > max_step and peak > 0.0 else 1.0
        for i in range(WHEELS):
            self.cmd[i] += k * (self.target[i] - self.cmd[i])
            duty = self.cmd[i] / MAX_WHEEL_SPEED  # feed-forward
            meas = hook_num(read_wheel_speed, i)
            if meas is not None:
                err = self.cmd[i] - meas
                self.integ[i] = clamp(self.integ[i] + err * dt, -WHEEL_I_MAX, WHEEL_I_MAX)
                duty += WHEEL_KP * err + WHEEL_KI * self.integ[i]
                self.meas[i] = meas
            else:
                self.meas[i] = self.cmd[i]
            if self.motors_on:
                self.motor_write(i, clamp(duty * WHEEL_DIR[i], -1.0, 1.0), True)
        self.odometry(dt)

    def safe(self, relax):
        self.wheels_zero(False)  # decelerate under the acceleration limit, then brake
        if relax:
            self.wheels_zero(True)
            self.motors_off()

    def estop(self):
        self.wheels_zero(True)
        self.motors_off()

    def telemetry(self, tel):
        tel["enc"] = [round(s, 2) for s in self.meas]
        tel["pose"] = [round(self.odo[0], 3), round(self.odo[1], 3), round(math.degrees(self.odo[2]), 1)]
        scan = self.lidar.take() if self.lidar is not None else None
        if scan is not None:
            tel["scan"] = {"a0": round(180.0 / SCAN_BINS, 2), "da": round(360.0 / SCAN_BINS, 2), "r": [round(r, 3) for r in scan]}

    def flush_logs(self):
        out = list(self.notes)
        self.notes = []
        if self.limited:
            self.limited = False
            out.append("wheel speed limited to MAX_WHEEL_SPEED")
        if self.lidar is not None and self.lidar.bad:
            out.append("LD06: %d packets failed CRC" % self.lidar.bad)
            self.lidar.bad = 0
        return out`)
}

export function pySweeper(): string {
  return [motorOutput(), ld06(), robot()].join('\n\n\n')
}
