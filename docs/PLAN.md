# SIM CONSOLE — Design (v1)

> One instrument bench where a virtual robot can be driven by the **simulator**, by a
> **real board** over a wire, or by **your own code** — and the instruments can't tell
> which, because all three feed the same telemetry.
> Sim to design it, hardware to prove it, code to test it.

This is the design reference for v1: the decisions that shape the code, the contracts
between its parts, and what each robot simulates.

---

## 1. Locked decisions

| Area | Decision |
|---|---|
| Stack | Vite + React 18 + react-three-fiber 8 + drei + three 0.160 + @react-three/postprocessing + zustand + uPlot + Radix primitives + CodeMirror 6. TypeScript strict. |
| Theme | `src/theme.css` `:root` tokens are **frozen**. Lab-white surfaces, blueprint hairlines, registration corners, orange `#FF5A1F` = live/active only. SIM teal, HARDWARE green, CODE violet. |
| Fonts | Chakra Petch (display: brand and robot switcher only), Inter (UI), JetBrains Mono (all data, never replaced). |
| Robots | **Walker** (4 / 6 / 8 legs, selectable), **Sweeper** (romi_nav twin: mecanum + LD06), **Swarm** (3–6 quadrotors). |
| Fidelity | Walker: exact 3-DOF IK + support-polygon load + Jacobian joint torque, an actuator (servo) model, and an optional Rapier rigid-body DYNAMIC mode. Sweeper: mecanum kinematics + raycast LD06 + occupancy grid + A* + boustrophedon coverage. Swarm: 12-state rigid-body equations of motion + motor model + cascaded PID + formation + reciprocal avoidance. |
| Drive source | SIM / HARDWARE / CODE. One switch, same instruments. Hardware needs a home-first handshake before it accepts live commands. |
| Protocol | Newline-delimited JSON (NDJSON), both directions, version 1 (`src/core/protocol.ts`). |
| Transports | Web Serial (USB, every board), Web Bluetooth (ESP32, Pico W), WebSocket (ESP32, Pico W, Pi Zero 2 W), plus a built-in **Virtual Device** loopback that emulates the generated firmware, so the hardware flow can be demoed online with no board. |
| Codegen | ESP32 (Serial / BLE / WiFi-WS), Pico (Serial), Pico W (Serial / WiFi-WS), STM32 via STM32duino (Serial), Pi Zero 2 W (Python daemon: Serial-gadget / WS). Servo output via direct GPIO or PCA9685. Joint clamping + command watchdog + home pose are always generated. |
| Code sandbox | Two dialects. **Arduino C++ subset** goes through our own compiler (lexer → parser → semantic checks → bytecode → VM). **JavaScript** runs in a Web Worker with the same Arduino shim. Both run off the main thread, with a watchdog. |
| Deploy | Static build. No server needed. GitHub Pages (primary, free), with Vercel / Netlify / Cloudflare Pages configs included. |

### Design decisions

1. **HIL control model.** USB streams joint angles at 50 Hz on 921600 baud (the app runs the IK and drives every joint). Wireless (BLE / WiFi) sends high-level commands (`v` = vx, vy, wz plus gait and height), and the board runs its own gait. Both are generated.
2. **Code sandbox v1.** Both dialects ship. Real-chip emulation (avr8js) stays the v2 frontier.
3. **Pi Zero 2 W and STM32.** Both are in v1. STM32 uses STM32duino (it has `loop()`). The Pi gets a Python daemon, not `loop()` code.
4. **Physics.** KINEMATIC is the default (crisp, controllable, matches the reference). DYNAMIC (Rapier) is a toggle on the walker. The servo actuator model works in both modes. The calibration hook fits per-joint offset and scale from real telemetry.

---

## 2. Architecture

```
src/
  core/        contracts + runtime glue (types, protocol, hardware config, runtime, recorder, profiles)
  robots/      one folder per robot module, each implements RobotModule
    walker/  sweeper/  swarm/
  scene/       R3F viewport, lighting, postprocessing, camera presets, pointer routing
  ui/          shell: top bar, instrument rail, control rail, drawer chrome, timeline
  bridge/      transports, NDJSON link, handshake, serial monitor, telemetry table, calibration
  codegen/     firmware generators + the firmware dialog
  compiler/    Arduino C++ subset compiler + bytecode VM (pure TS, no DOM)
  sandbox/     worker host, Arduino shim, robot API binding, JS dialect, code editor drawer
```

### 2.1 The RobotModule contract (`src/core/types.ts`)

The shell never knows what a spider is. Each module declares:

- `root` (THREE.Group), `world` (grid, camera presets, zoom limits), `revision` (bumped when the control schema or instrument layout changes).
- `update(dt, ctx)`, `reset()`, `dispose()`.
- Controls: `getControlSchema()`, `getControlValues()`, `setControl(key, value)`. The control types are slider, select (segmented / dropdown / 3×3 grid), toggle and button, grouped into panels.
- Instruments: `getInstrumentLayout()` (gauges, streaming charts, bars, readouts) and `getTelemetry()`.
- Scene: `followTarget()`, and optional `onPointer(e)` for dragging obstacles and dropping waypoints.
- Record and replay: `snapshot()` and `restore(s)`.
- Profiles: `serializeConfig()` and `loadConfig(c)`.
- HARDWARE source: `getHardwareSpec()`, `buildCommand(level)`, `applyTelemetry(tel)`, `telemetryTable(tel)`.
- CODE source: `getSandboxApi()`, `getSandboxSensors()`, `applySandboxCommands(cmds)`, `releaseSandbox()`.

### 2.2 Runtime loop (`src/core/runtime.ts`)

Every frame: read the drive source. **CODE**: the sandbox gets a sensor snapshot and returns commands (one frame of latency, like a real control loop). **HARDWARE**: the bridge sends `buildCommand()` at the command rate and feeds the latest `tel` to `applyTelemetry()`. Then `module.update(dt)` runs, telemetry is published to the bus, and the recorder captures a frame. The instruments read the bus on their own rAF, so React never re-renders at 60 Hz.

### 2.3 Telemetry never branches on source

SIM computes the frame, HARDWARE reads it off the wire, CODE produces it from your controller. Every instrument reads the same `TelemetryFrame`.

---

## 3. Module specs

### 3.1 Walker (Phase 1). The hero.

- **Legs 4 / 6 / 8**, switchable live. The body rebuilds as rectangular (4), hexagonal (6) or octagonal (8). Radial hip mounts, mirrored left/right.
- **3-DOF IK per leg** (coxa yaw, femur pitch, tibia pitch). Closed-form, with a reachability clamp. Knees bend up-and-out like the reference. Forward kinematics is verified against IK in tests.
- **Gait engine**, leg-count agnostic: phase offsets plus duty factor. 6/8 legs: tripod (tetrapod for 8), ripple, wave. 4 legs: crawl (statically stable creep), trot, pace. Only valid gaits are offered for the chosen leg count. Stance feet stay planted in world space (no foot-skate). Swing feet follow a smooth lift trajectory.
- **Locomotion**: a 3×3 direction pad plus turn, speed, stride, step height. **Body pose**: height, roll, pitch, yaw, x/y shift.
- **Telemetry that is physically real**: support-polygon stability margin (CoM projection distance to the polygon edge), per-leg vertical load (static equilibrium, minimum-norm force distribution across the stance legs), joint torque via Jacobianᵀ·F, foot height chart, servo current estimate.
- **Actuator model** (both physics modes): per-joint first-order servo response, speed limit (deg/s), stall-torque limit, deadband, backlash. Presets: IDEAL, SG90, MG996R, DS3218, plus custom values.
- **DYNAMIC mode** (Rapier, `@dimforge/rapier3d-compat`): rigid body plus leg links joined by revolute motors driven from IK targets through the actuator model, friction feet, gravity. It can tip over, which is the point. Reset re-spawns.
- **Look**: like the reference video. White beveled faceted body, white servo-bracket segments with orange servo horns/discs on the real joint axes, orange foot caps, soft AO.

### 3.2 Sweeper (Phase 2). Your romi_nav twin.

- **Mecanum kinematics**: inverse mixing (body twist → 4 wheel speeds) and forward kinematics, wheel speed limits, roller visuals.
- **LD06 LiDAR model**: 360°, 10 Hz scan, about 450 samples per revolution, 0.02–12 m range, Gaussian range noise, drawn live as a fan of rays plus hit points.
- **Occupancy grid**: log-odds mapping from the simulated scans (built from the sensor, not ground truth), shown as an overlay.
- **Planning**: A* on the inflated grid (8-connected, octile heuristic), path smoothing, a holonomic pure-pursuit follower. **Coverage**: boustrophedon lanes over free space. Coverage % is painted as the robot sweeps. **Reactive layer**: emergency slow-down or stop from the LiDAR minimum range.
- **Arena**: bounded room with walls. Drag obstacles with the mouse, add and remove boxes and cylinders, click to set a goal. Modes: COVERAGE, GOTO, TELEOP, WANDER.

### 3.3 Swarm (Phase 3)

- **3–6 quadrotors**, each with a 12-state rigid-body model (position, velocity, attitude, body rates), an X-frame mixer, a first-order motor lag, thrust kT·ω², drag, gravity. Integrated at a 1 kHz substep (semi-implicit or RK4).
- **Cascaded PID**: position → velocity → attitude → rate, with saturation and anti-windup. Gains are exposed as controls. It can be unstable if gains are bad, honestly.
- **Formation**: line, wedge (V), triangle, circle, column. Virtual-structure offsets around a leader or centroid. **Waypoints**: click to drop on the ground at the cruise altitude. Route modes: loop, ping-pong, once.
- **Avoidance**: reciprocal velocity obstacles (ORCA-lite) between drones, plus a minimum-separation guard. **Wind** disturbance with gusts.
- **Look**: X-frame quads with spinning props, status LEDs, flight trails, waypoint markers, formation ghost slots.

---

## 4. Hardware bridge (Phase 4)

- **Transports**: Web Serial (any baud, default 921600 for the walker over USB), Web Bluetooth (Nordic-UART-style service UUIDs, chunked writes), WebSocket (`ws://<ip>:81`), Virtual Device (loopback that behaves exactly like the generated firmware, including hello, home ack, telemetry and watchdog).
- **Link layer**: NDJSON framing with partial-line buffering, schema validation of every inbound message, sequence numbers, ping/pong RTT, rate limiting of outbound commands.
- **Handshake**: connect → board sends `hello` → app checks the robot kind and joint count against the active module → app sends `home` → board acks when it is in the safe pose → LIVE. E-STOP is always one click away. Dropping the link puts the UI back in a safe state.
- **Serial monitor**: raw RX/TX stream with timestamps, filter, pause, clear, send-line, export. Plus a live per-leg (or per-wheel / per-drone) telemetry table.
- **Calibration hook**: collect commanded vs measured joint angles, then least-squares fit per-joint offset and scale and write them to the hardware profile. Shows the residual error and the measured link latency.

### Protocol v1 (`src/core/protocol.ts`)

```
bot → app  {"t":"hello","proto":1,"board":"esp32","robot":"walker","legs":6,"joints":18,"fw":"kiyobridge-1.0"}
app → bot  {"t":"home"}                              bot → app {"t":"ack","of":"home","ok":true}
app → bot  {"t":"cmd","seq":42,"q":[12.4,-30.1,55.0,...]}      // joint targets, degrees (USB)
app → bot  {"t":"cmd","seq":43,"v":[0.1,0,0.2],"mode":"tripod","h":0.09}   // high level (wireless)
bot → app  {"t":"tel","ms":10422,"ang":[...],"load":[...],"imu":[r,p,y],"vbat":7.4}
app → bot  {"t":"estop"}     app → bot {"t":"ping","id":7}     bot → app {"t":"pong","id":7}
bot → app  {"t":"log","lvl":"warn","msg":"servo 4 clamped"}
```

## 5. Firmware codegen (Phase 4)

A menu: robot × board × transport × servo driver. The output is
`kiyobridge.h` (paste once) plus an example sketch showing the three touch-points:

```cpp
#include "kiyobridge.h"
void setup() { Bridge.begin(); }   // one line
void loop()  { Bridge.update(); }  // one line — routes everything
```

The generated code includes the pin/channel map, joint limits clamping, a watchdog
(hold or relax after N ms with no commands), the home pose, telemetry at the configured
rate, library install notes, and wiring and placement instructions. Pi Zero 2 W gets a
Python daemon plus a systemd unit. Download it as a .zip or copy each file.

## 6. Code sandbox + our own compiler (Phase 5)

- **Arduino C++ subset compiler** (`src/compiler`): lexer, recursive-descent parser, typed AST, semantic checks (types, undeclared names, arity), a bytecode compiler, and a stack VM. Supported: `#define`, `#include` of known libraries, globals, `const`, int/long/unsigned/float/double/bool/char/byte/String and the fixed-width ints, 1D and 2D arrays with initializers, functions, `struct`, if/else, for, while, do/while, switch, break/continue, ternary, all arithmetic, bitwise, compound and ++/-- operators, casts, and **C integer semantics** (truncating division, wraparound). Natives: `Serial`, `Servo`, `Adafruit_PWMServoDriver`, `pinMode` / `digitalWrite` / `analogRead` / ..., `millis` / `micros` / `delay`, `map` / `constrain` / math, plus the robot API. `delay()` really pauses the VM in virtual time. Diagnostics give line:col and are shown inline in the editor.
- **Servo → joint mapping**: `Servo.attach(pin)` and PCA9685 channels map to joints through the same hardware profile the codegen uses. **Your real servo sketch can drive the virtual robot unchanged** if the pins match.
- **JavaScript dialect**: same shim. `await delay(ms)` works. It runs in a dedicated worker.
- **Runner**: Web Worker, instruction budget per tick, a watchdog that kills the worker on a runaway loop, a console that feeds the serial monitor, Run / Pause / Step / Reset, and example programs per robot.

## 7. Cross-cutting features

- **Record & replay**: REC captures snapshots plus telemetry at 30 Hz (ring buffer, 120 s). A timeline scrubber restores the robot pose and instruments. Export CSV (telemetry) and JSON (recording).
- **Profiles**: save, load, import and export robot profiles (controls + module config + hardware config) in localStorage and JSON files. Built-in presets per robot.
- **Camera**: orbit plus presets (ISO, FRONT, SIDE, TOP, FOLLOW).
- **Quality**: HIGH (AO + bloom + SMAA + soft shadows) or LOW (plain) for weak GPUs and phones, auto-detected.
- **Responsive**: desktop-first, still usable on a tablet or phone (the rails stack).

## 8. Quality gates

- Unit tests (Vitest) for all the math and logic: IK/FK round-trip, gait phase validity, load distribution, mecanum inverse/forward identity, LiDAR ray hits, A*, coverage, drone hover equilibrium and PID step response, formation offsets, ORCA, NDJSON framing, handshake state machine, codegen output, compiler and VM programs, sandbox shim.
- `tsc --noEmit` clean, `vite build` clean, and a browser smoke test of every robot × source.
- Code review, TypeScript review and security review passes (the bridge parses untrusted serial/WS input; the sandbox runs user code).

## 9. Deployment: free and online

The whole app is a static site. Simulation, compiler, VM, codegen and the Web Serial/BLE bridge all run in the browser, so it works fully online with no backend and no cost.

| Host | Free tier | Notes |
|---|---|---|
| **GitHub Pages** (primary) | Free for public repos, HTTPS | The repo *is* the portfolio piece, and the live demo sits next to the code. Deployed by `.github/workflows/deploy.yml` on every push to `main`. |
| Vercel | Hobby (non-commercial) | `vercel.json` included. Sets the security headers. |
| Netlify | 100 GB/month | `netlify.toml` included. |
| Cloudflare Pages | Unlimited bandwidth | `public/_headers` included. |

**What works online, honestly:**

- Simulation, recording, profiles, compiler, sandbox, codegen and Virtual Device: every modern browser.
- **Web Serial (USB) and Web Bluetooth**: Chrome or Edge on desktop (and Android for BLE), served over HTTPS. All four hosts serve HTTPS, so it works from the deployed URL. Firefox and Safari do not implement these APIs; the app detects that and explains it.
- **WiFi WebSocket from the hosted (HTTPS) site**: browsers block `ws://` to a LAN IP from an HTTPS page (mixed content). The workarounds, all built in and documented: (a) run locally with `npm run dev` (http://localhost is allowed), (b) use USB or BLE from the hosted site, or (c) run the bundled `tools/ws-relay.mjs` on your PC. The app talks to `ws://localhost`, which browsers treat as trustworthy, and the relay forwards to the board.
- Flashing firmware stays in the Arduino IDE / PlatformIO (the app generates the code). Browser flashing via esptool-js is a v2 item.

### Deploy steps (GitHub Pages)

1. Create a public GitHub repo (for example `sim-console`) and push this folder to `main`.
2. Repo → Settings → Pages → Source: **GitHub Actions**.
3. The workflow runs the tests, builds and publishes. The URL is `https://<user>.github.io/<repo>/`.

## 10. v2 frontier (not in v1)

avr8js real-firmware emulation wired to the robot · esptool-js browser flashing · editable terrain for the walker · multi-robot scenes · ROS 2 bridge via rosbridge WebSocket · ESP32 emulation research.
