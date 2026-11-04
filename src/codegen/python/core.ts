import { FW_ID } from '../context'
import type { GenContext } from '../context'
import { block, commentSafe } from '../format'

/* ============================================================
   PYTHON CORE — the parts of kiyobridge.py every Pi build shares:
   helpers, the bounded NDJSON line splitter, the protocol state
   machine (same states and rules as the C++ KiyoBridge), the three
   links (WebSocket, USB-gadget serial, stdio for testing) and main.
   Hardware imports are lazy, so the file runs with --dry-run and
   --stdio on any machine with plain Python 3.9+.
   ============================================================ */

export function pyHeader(ctx: GenContext, linkTitle: string): string {
  return block(String.raw`
#!/usr/bin/env python3
"""
kiyobridge.py - SIM CONSOLE hardware bridge (${FW_ID}, protocol v1, newline-delimited JSON)
Robot: ${commentSafe(ctx.robotLabel)} (${ctx.robot}, ${ctx.joints} outputs)   Board: Raspberry Pi Zero 2 W
Link: ${linkTitle}   Level: ${ctx.level.toUpperCase()}   Output: PCA9685

Run it:
  .venv/bin/python kiyobridge.py               talk to the app over the configured link
  .venv/bin/python kiyobridge.py --dry-run     no PCA9685 attached: outputs are only simulated
  .venv/bin/python kiyobridge.py --stdio       NDJSON on stdin / stdout (handy for testing)
At boot it runs from systemd (kiyobridge.service). Regenerate this file in SIM CONSOLE
(FIRMWARE) whenever the robot, the board or the wiring changes.
"""

import argparse
import asyncio
import json
import math
from queue import Full as QueueFull, Queue as ThreadQueue
import signal
import sys
import threading
import time`)
}

export function pyHelpers(): string {
  return block(String.raw`
# ===================== small utilities =====================

def info(msg):
    """Diagnostics go to stderr, so --stdio keeps stdout pure NDJSON."""
    print("[kiyo] " + msg, file=sys.stderr, flush=True)


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def round_half_up(v):
    """Math.round in the app (Python's round() rounds half to even)."""
    return int(math.floor(v + 0.5))


def frac(v):
    return v - math.floor(v)


HOOK_ERRORS = {}


def hook(fn, *args):
    """Call a user hook; a broken hook is reported in the log instead of stopping the robot."""
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 - user code may raise anything
        HOOK_ERRORS[fn.__name__] = repr(exc)
        return None


def hook_num(fn, *args):
    v = hook(fn, *args)
    return float(v) if is_num(v) else None


class LineSplitter:
    """Bounded NDJSON line assembler. Lines over MAX_LINE bytes are dropped whole."""

    def __init__(self):
        self.buf = bytearray()
        self.dropping = False
        self.overflows = 0

    def feed(self, data):
        lines = []
        start = 0
        while True:
            nl = data.find(b"\n", start)
            chunk = data[start:] if nl < 0 else data[start:nl]
            if not self.dropping:
                self.buf += chunk
                if len(self.buf) > MAX_LINE:
                    self.buf.clear()
                    self.dropping = True
                    self.overflows += 1
            if nl < 0:
                return lines
            if not self.dropping and self.buf:
                text = self.buf.decode("utf-8", "replace").strip()
                if text:
                    lines.append(text)
            self.buf.clear()
            self.dropping = False
            start = nl + 1`)
}

export function pyBridge(): string {
  return block(String.raw`
# ===================== the bridge (protocol state machine) =====================
IDLE, HOMING, READY, ESTOP = 0, 1, 2, 3


class Bridge:
    """Same rules as the firmware: outputs off until "home", cmd only once homed,
    watchdog after WATCHDOG_MS, E-STOP needs "home" again, logs at most once a second."""

    def __init__(self, robot, write):
        self.robot = robot
        self.write = write
        self.state = IDLE
        self.tripped = False
        self.t0 = time.monotonic()
        now = self.t0
        self.last_ctl = self.last_tel = self.last_log = self.last_cmd = now
        self.counts = {"not_ready": 0, "bad_json": 0, "unknown": 0, "overflow": 0, "tx_bad": 0}

    # ---- outgoing ----
    def send(self, obj):
        try:
            text = json.dumps(obj, separators=(",", ":"), allow_nan=False)
        except ValueError:  # a non-finite number from a hook: never put invalid JSON on the wire
            self.counts["tx_bad"] += 1
            return
        self.write(text + "\n")

    def log(self, lvl, msg):
        self.send({"t": "log", "lvl": lvl, "msg": msg})

    def ack(self, of, ok):
        self.send({"t": "ack", "of": of, "ok": ok})

    def hello(self):
        msg = dict(HELLO)
        caps = list(CAPS) + self.robot.caps()
        imu = hook(read_imu)
        if isinstance(imu, (list, tuple)) and len(imu) == 3:
            caps.append("imu")
        if hook_num(read_vbat) is not None:
            caps.append("vbat")
        msg["caps"] = caps
        self.send(msg)

    def telemetry(self, now):
        tel = {"t": "tel", "ms": int((now - self.t0) * 1000)}
        self.robot.telemetry(tel)
        imu = hook(read_imu)
        if isinstance(imu, (list, tuple)) and len(imu) == 3 and all(is_num(v) for v in imu):
            tel["imu"] = [round(float(v), 2) for v in imu]
        vbat = hook_num(read_vbat)
        if vbat is not None:
            tel["vbat"] = round(vbat, 2)
        self.send(tel)

    # ---- incoming ----
    def on_connect(self):
        self.hello()

    def on_line(self, line):
        try:
            msg = json.loads(line)
        except (ValueError, RecursionError):
            self.counts["bad_json"] += 1
            return
        if not isinstance(msg, dict):
            self.counts["bad_json"] += 1
            return
        t = msg.get("t")
        now = time.monotonic()
        if t == "cmd":
            self.on_cmd(msg, now)
        elif t == "home":
            self.state = HOMING
            self.robot.home_start(now)
        elif t == "estop":
            self.robot.estop()
            self.state = ESTOP
            self.ack("estop", True)
            self.log("warn", "E-STOP: outputs off, send home to resume")
        elif t == "ping":
            pid = msg.get("id")
            self.send({"t": "pong", "id": pid if isinstance(pid, int) and not isinstance(pid, bool) and pid >= 0 else 0})
        elif t == "hello?":
            self.hello()
        else:
            self.counts["unknown"] += 1

    def on_cmd(self, msg, now):
        if self.state != READY:
            self.counts["not_ready"] += 1
            return
        if not self.robot.command(msg, now):
            return
        self.last_cmd = now
        if self.tripped:
            self.tripped = False
            self.log("info", "watchdog cleared, commands resumed")

    # ---- timing ----
    def tick(self, now):
        if self.state == HOMING and self.robot.home_done(now):
            self.state = READY
            self.last_cmd = now
            self.tripped = False
            self.ack("home", True)
        if self.state == READY:
            self.watchdog(now)
        if now - self.last_ctl >= 1.0 / CONTROL_HZ:
            dt = min(now - self.last_ctl, 0.05)
            self.last_ctl = now
            self.robot.control(dt, now)
        if now - self.last_tel >= 1.0 / TEL_HZ:
            self.last_tel = now
            self.telemetry(now)
        if now - self.last_log >= LOG_PERIOD_S:
            self.last_log = now
            self.flush_logs()

    def watchdog(self, now):
        if self.tripped or (now - self.last_cmd) * 1000.0 < WATCHDOG_MS:
            return
        self.tripped = True
        self.robot.safe(WATCHDOG_RELAX)
        if WATCHDOG_RELAX:
            self.state = IDLE
            self.log("warn", "watchdog: no cmd for %d ms, outputs relaxed; send home to resume" % WATCHDOG_MS)
        else:
            self.log("warn", "watchdog: no cmd for %d ms, holding the last pose" % WATCHDOG_MS)

    def flush_logs(self):
        for msg in self.robot.flush_logs():
            self.log("warn", msg)
        texts = {
            "not_ready": " cmd ignored: send home first",
            "bad_json": " malformed lines dropped",
            "unknown": " lines with an unknown type ignored",
            "overflow": " lines over MAX_LINE bytes dropped",
            "tx_bad": " outgoing lines with a non-finite number dropped",
        }
        for key, text in texts.items():
            if self.counts[key]:
                self.log("warn", str(self.counts[key]) + text)
                self.counts[key] = 0
        for name, err in list(HOOK_ERRORS.items()):
            self.log("err", "hook " + name + " failed: " + err[:120])
        HOOK_ERRORS.clear()

    async def run(self):
        while True:
            self.tick(time.monotonic())
            await asyncio.sleep(1.0 / CONTROL_HZ)`)
}

export function pyLinks(): string {
  return block(String.raw`
# ===================== links =====================

class ThreadedLineLink:
    """Shared by serial and stdio: a daemon thread reads bytes, the event loop parses lines."""

    def __init__(self):
        self.splitter = LineSplitter()
        self.bridge = None

    def reader(self, loop, queue):
        raise NotImplementedError

    async def run(self, bridge):
        self.bridge = bridge
        loop = asyncio.get_running_loop()
        queue = asyncio.Queue()
        threading.Thread(target=self.reader, args=(loop, queue), daemon=True).start()
        while True:
            data = await queue.get()
            if data is None:
                return
            for line in self.splitter.feed(data):
                bridge.on_line(line)
            if self.splitter.overflows:
                bridge.counts["overflow"] += self.splitter.overflows
                self.splitter.overflows = 0


class StdioLink(ThreadedLineLink):
    def reader(self, loop, queue):
        stream = sys.stdin.buffer
        while True:
            data = stream.readline(MAX_LINE + 1)
            loop.call_soon_threadsafe(queue.put_nowait, data if data else None)
            if not data:
                return

    def send(self, text):
        sys.stdout.write(text)
        sys.stdout.flush()


class SerialLink(ThreadedLineLink):
    """USB gadget serial (/dev/ttyGS0): the Pi's USB data port shows up as a COM port on the PC."""

    def __init__(self, port, baud):
        super().__init__()
        import serial  # pyserial

        self.serial_mod = serial
        try:
            self.ser = serial.Serial(port, baud, timeout=0.1, write_timeout=0.5)
        except serial.SerialException as exc:
            raise SystemExit(
                "cannot open %s (%s). Enable the USB serial gadget (dtoverlay=dwc2, modules-load=dwc2,g_serial) "
                "and use the Pi's USB data port." % (port, exc)
            )
        # writes go through a thread: a host that stops reading must not stall the control loop
        self.tx = ThreadQueue(maxsize=64)
        threading.Thread(target=self.writer, daemon=True).start()
        info("serial link on %s, waiting for the app" % port)

    def reader(self, loop, queue):
        while True:
            try:
                data = self.ser.read(256)
            except self.serial_mod.SerialException as exc:
                info("serial read failed: %s" % exc)
                loop.call_soon_threadsafe(queue.put_nowait, None)
                return
            if data:
                loop.call_soon_threadsafe(queue.put_nowait, data)

    def writer(self):
        while True:
            text = self.tx.get()
            try:
                self.ser.write(text.encode("utf-8"))
            except self.serial_mod.SerialException:
                pass  # host not reading (port closed): the line is dropped, like the firmware

    def send(self, text):
        try:
            self.tx.put_nowait(text)
        except QueueFull:
            pass  # the host is not reading: drop the line instead of blocking the event loop


class WsLink:
    """WebSocket server on WS_PORT. Every client gets every line; each message is one or more lines."""

    def __init__(self, host, port):
        self.host = host
        self.port = port
        self.clients = {}
        self.bridge = None

    def send(self, text):
        for queue in list(self.clients.values()):
            if queue.qsize() < 256:
                queue.put_nowait(text)

    async def writer(self, ws, queue):
        while True:
            await ws.send(await queue.get())

    async def client(self, ws, *_legacy_path):
        queue = asyncio.Queue()
        self.clients[ws] = queue
        task = asyncio.create_task(self.writer(ws, queue))
        info("app connected")
        self.bridge.on_connect()
        try:
            async for msg in ws:
                text = msg.decode("utf-8", "replace") if isinstance(msg, bytes) else msg
                for line in text.split("\n"):
                    line = line.strip()
                    if len(line) > MAX_LINE:
                        self.bridge.counts["overflow"] += 1
                    elif line:
                        self.bridge.on_line(line)
        except Exception:  # noqa: BLE001 - any close / protocol error ends this client only
            pass
        finally:
            self.clients.pop(ws, None)
            task.cancel()
            info("app disconnected")

    async def run(self, bridge):
        self.bridge = bridge
        try:
            from websockets.asyncio.server import serve
        except ImportError:  # websockets < 13
            from websockets import serve
        try:
            server = serve(self.client, self.host, self.port, max_size=MAX_LINE * 4)
            async with server:
                info("connect the app to ws://%s:%d" % (local_ip(), self.port))
                await asyncio.Future()
        except PermissionError:
            raise SystemExit(
                "port %d needs root or CAP_NET_BIND_SERVICE. The systemd unit grants it; by hand use "
                "--port 8081 and connect the app to ws://<pi>:8081" % self.port
            )


def local_ip():
    import socket

    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; it only picks the outgoing interface
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()`)
}

export function pyMain(ctx: GenContext): string {
  const linkDefault = ctx.link === 'ws' ? 'ws' : 'serial'
  return block(String.raw`
# ===================== main =====================

def make_link(args):
    if args.stdio:
        return StdioLink()
    if args.link == "ws":
        return WsLink(WS_HOST, args.port)
    return SerialLink(args.serial, BAUD)


async def amain(args):
    out = DryRunOutput() if args.dry_run else make_output()
    robot = Robot(out)
    link = make_link(args)
    bridge = Bridge(robot, link.send)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass  # not available on this platform: Ctrl+C still ends the loop
    bridge.hello()
    tasks = [asyncio.create_task(link.run(bridge)), asyncio.create_task(bridge.run())]
    waiter = asyncio.create_task(stop.wait())
    try:
        done, _ = await asyncio.wait(tasks + [waiter], return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if task is not waiter and not task.cancelled() and task.exception() is not None:
                raise task.exception()
    finally:
        for task in tasks + [waiter]:
            task.cancel()
        robot.estop()  # leaving: every output off
        info("stopped, outputs off")


def main():
    parser = argparse.ArgumentParser(description="SIM CONSOLE kiyobridge daemon (${ctx.robot})")
    parser.add_argument("--link", choices=["ws", "serial"], default="${linkDefault}", help="link to the app")
    parser.add_argument("--port", type=int, default=WS_PORT, help="WebSocket port (default %(default)s)")
    parser.add_argument("--serial", default=SERIAL_PORT, help="serial device (default %(default)s)")
    parser.add_argument("--stdio", action="store_true", help="NDJSON on stdin / stdout instead of the link")
    parser.add_argument("--dry-run", action="store_true", help="no PCA9685: simulate the outputs")
    args = parser.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()`)
}
