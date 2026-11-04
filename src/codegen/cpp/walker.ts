import type { GenContext, WalkerCtx } from '../context'
import { CREEP } from '../creep'
import { block, cFloat, cFloatList, cInt, cList, cString } from '../format'

/* ============================================================
   C++ WALKER — robot section for the legged walker.
   joint level: the app streams q (every joint, degrees); the board
   clamps, maps and writes them.
   high level : additionally runs its own gait + 3-DOF IK from the
   spec geometry, driven by cmd v / mode / h. q still works. The
   4-leg crawl adds the creep sway and lift-off gate (../creep.ts).
   The loop is the one in ../gaitRef.ts, which the tests check.
   ============================================================ */

/** Only a 4-leg build has a crawl, so only it gets the creep code. */
export function hasCreep(w: WalkerCtx): boolean {
  return w.geom.legs === 4 && w.gaits.some((g) => g.creep)
}

function creepConfig(w: WalkerCtx): string {
  return String.raw`
// quadruped creep (crawl): three feet carry the robot while one swings, so the body first
// shifts over their triangle and a foot lifts only once the body is there
#define KIYO_CREEP_MARGIN ${cFloat(CREEP.margin)}      // the body aims this far inside the support triangle
#define KIYO_CREEP_GATE ${cFloat(CREEP.gate)}        // a foot lifts only once the body is this far inside
#define KIYO_CREEP_MIN_LIFT ${cFloat(CREEP.minLift)}     // no gate while the step height is faded out
#define KIYO_SWAY_TAU_S ${cFloat(CREEP.tauS)}        // body sway smoothing
#define KIYO_SWAY_MAX_SPEED ${cFloat(CREEP.maxSpeed)}    // m/s, keeps the shift within servo speed
#define KIYO_SWAY_ARRIVE ${cFloat(CREEP.arrive)}      // reach the next triangle after this much of the four-feet phase
static const uint8_t KIYO_GAIT_CREEP[KIYO_GAITS] = ${cList(w.gaits.map((gd) => (gd.creep ? '1' : '0')))};`
}

const DEG = Math.PI / 180

export function walkerGaitConfig(w: WalkerCtx): string {
  const g = w.geom
  const t = w.tuning
  const keys = w.gaits.flatMap((gd, i) => [gd.name, ...gd.aliases].map((k) => ({ k, i })))
  const unique = keys.filter((e, idx) => keys.findIndex((o) => o.k === e.k) === idx)
  const offsets = cList(w.gaits.map((gd) => cFloatList(gd.offsets, 4, 8)), 1)
  return block(String.raw`
// ---------- on-board gait + IK (REP-103 body frame: x forward, y left, z up; meters) ----------
#define KIYO_COXA ${cFloat(g.coxa)}
#define KIYO_FEMUR ${cFloat(g.femur)}
#define KIYO_TIBIA ${cFloat(g.tibia)}
#define KIYO_STAND_H ${cFloat(g.standHeight)}        // default body height (cmd h overrides)
#define KIYO_FOOT_REACH ${cFloat(g.footReach)}     // coxa axis to neutral foot, horizontal
#define KIYO_H_MIN ${cFloat(t.heightMin)}
#define KIYO_H_MAX ${cFloat(t.heightMax)}
// tuning: edit freely
#define KIYO_STEP_H ${cFloat(t.stepHeight)}          // swing foot lift
#define KIYO_MAX_STRIDE ${cFloat(t.maxStride)}      // longest foot travel per stance
#define KIYO_CYCLE_MIN_S ${cFloat(t.cycleMinS)}       // fastest gait cycle
#define KIYO_CYCLE_MAX_S ${cFloat(t.cycleMaxS)}       // slowest gait cycle (walking slowly)
#define KIYO_SWING_MIN_S ${cFloat(t.swingMinS)}      // shortest swing the servos can follow (slow gaits get a longer cycle)
#define KIYO_CMD_TAU_S ${cFloat(t.cmdTauS)}         // command smoothing time constant
#define KIYO_GAITS ${w.gaits.length}
#define KIYO_GAIT_KEYS ${unique.length}

static const float KIYO_MOUNT_X[KIYO_LEGS] = ${cFloatList(g.mountX)};
static const float KIYO_MOUNT_Y[KIYO_LEGS] = ${cFloatList(g.mountY)};
static const float KIYO_MOUNT_COS[KIYO_LEGS] = ${cFloatList(g.mountYawDeg.map((d) => Math.cos(d * DEG)))};
static const float KIYO_MOUNT_SIN[KIYO_LEGS] = ${cFloatList(g.mountYawDeg.map((d) => Math.sin(d * DEG)))};
static const float KIYO_FOOT_X[KIYO_LEGS] = ${cFloatList(w.neutralX)};
static const float KIYO_FOOT_Y[KIYO_LEGS] = ${cFloatList(w.neutralY)};
// gait = duty factor + per-leg phase offset; names the app may send in cmd.mode
static const char* const KIYO_GAIT_NAME[KIYO_GAITS] = ${cList(w.gaits.map((gd) => cString(gd.name)))};
static const float KIYO_GAIT_DUTY[KIYO_GAITS] = ${cFloatList(w.gaits.map((gd) => gd.duty), 4)};
static const float KIYO_GAIT_OFFSET[KIYO_GAITS][KIYO_LEGS] = ${offsets};
static const char* const KIYO_GAIT_KEY[KIYO_GAIT_KEYS] = ${cList(unique.map((e) => cString(e.k)))};
static const uint8_t KIYO_GAIT_KEY_IDX[KIYO_GAIT_KEYS] = ${cList(unique.map((e) => cInt(e.i)), 12)};${hasCreep(w) ? creepConfig(w) : ''}`)
}

/** Shared by both levels; `high` adds the gait stop to HOME (gaitStop is defined before it). */
function jointCommon(high: boolean): string {
  return String.raw`
static uint32_t homeDoneAt = 0;
static Note cmdNote;   // malformed-command diagnostics, flushed once a second

static void robotHomeStart(uint32_t now) {${high ? '\n  gaitStop();   // HOME always wins over a running gait' : ''}
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) jTarget[j] = KIYO_HOME[j];
  if (!jOutputs) {
    // pose unknown (power-up or relaxed): jump to home and give the servos time to arrive
    for (uint8_t j = 0; j < KIYO_JOINTS; j++) jOut[j] = KIYO_HOME[j];
    jBlendMs = 0;
    jointsEnable(true);
    homeDoneAt = now + KIYO_HOME_SETTLE_MS;
  } else {
    jointsBlend(now, KIYO_HOME_RAMP_MS);
    homeDoneAt = now + KIYO_HOME_RAMP_MS;
  }
}

static bool robotHomeDone(uint32_t now) { return (int32_t)(now - homeDoneAt) >= 0; }

// q: one target per joint, degrees joint space.
static bool applyQ(JsonArrayConst q) {
  if (q.size() != KIYO_JOINTS) {
    Text t;
    t.add("cmd q has ").add((unsigned long)q.size()).add(" values, this robot has ").add((unsigned long)KIYO_JOINTS);
    cmdNote.set(t.c_str());
    return false;
  }
  uint8_t j = 0;
  for (JsonVariantConst v : q) {
    jTarget[j] = jointClamp(j, v.is<float>() ? v.as<float>() : NAN);
    j++;
  }
  return true;
}

static void robotTelemetry(Writer& w) {
  w.key("ang").put('[');
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    float a = jOut[j];
    if (kiyo_read_joint_deg) {
      const float m = kiyo_read_joint_deg(j);
      if (isNum(m)) a = m;
    }
    if (j) w.put(',');
    w.fix(a, 2);
  }
  w.put(']');
  if (kiyo_read_load && isNum(kiyo_read_load(0))) {
    w.key("load").put('[');
    for (uint8_t i = 0; i < KIYO_LEGS; i++) {
      if (i) w.put(',');
      w.fix(clampF(kiyo_read_load(i), 0.0f, 1.0f), 3);
    }
    w.put(']');
  }
}

// One line per second at most: "servo 4 (L2 femur) clamped" or "servos 4, 7 clamped".
static void logClamps() {
  const uint32_t m = takeClampMask();
  if (m == 0) return;
  uint8_t count = 0;
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    if (m & (1UL << j)) count++;
  }
  Text t;
  t.add(count == 1 ? "servo " : "servos ");
  bool first = true;
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) {
    if (!(m & (1UL << j))) continue;
    if (!first) t.add(", ");
    t.add((unsigned long)j);
    if (count == 1) t.add(" (").add(KIYO_JOINT_NAME[j]).add(")");
    first = false;
  }
  t.add(" clamped");
  log("warn", t.c_str());
}

static void robotCaps(Writer& w) {
  if (kiyo_read_joint_deg && isNum(kiyo_read_joint_deg(0))) w.raw(",\"feedback\"");
  if (kiyo_read_load && isNum(kiyo_read_load(0))) w.raw(",\"load\"");
}`
}

function jointLevel(): string {
  return String.raw`
static void robotBegin() {
  outBegin();
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) { jTarget[j] = KIYO_HOME[j]; jOut[j] = KIYO_HOME[j]; }
  // outputs stay off (servos limp) until the app sends "home"
}
${jointCommon(false)}

static bool robotCommand(JsonDocument& doc, uint32_t now) {
  (void)now;
  JsonArrayConst q = doc["q"].as<JsonArrayConst>();
  if (q.isNull()) {
    if (!doc["v"].isNull()) cmdNote.set("this firmware streams joints (q); regenerate at the HIGH level for v");
    return false;
  }
  return applyQ(q);
}

static void robotControl(float dt, uint32_t now) {
  (void)dt;
  jointsStep(now);
}

static void robotFlushLogs() {
  logClamps();
  cmdNote.flush("warn");
}

static void robotSafe(bool relax) {
  if (relax) jointsEnable(false);   // hold: targets simply stay where they are
}

static void robotEstop() { jointsEnable(false); }`
}

function ikAndGait(creep: boolean): string {
  return String.raw`
// Closed-form 3-DOF leg IK (knee up), the same math as the app. Target in the body frame.
static bool legIk(uint8_t leg, float px, float py, float pz, float* q) {
  const float dx = px - KIYO_MOUNT_X[leg];
  const float dy = py - KIYO_MOUNT_Y[leg];
  const float lx = KIYO_MOUNT_COS[leg] * dx + KIYO_MOUNT_SIN[leg] * dy;
  const float ly = -KIYO_MOUNT_SIN[leg] * dx + KIYO_MOUNT_COS[leg] * dy;
  float r = sqrtf(lx * lx + ly * ly) - KIYO_COXA;
  float z = pz;
  float d = sqrtf(r * r + z * z);
  const float fe = KIYO_FEMUR;
  const float ti = KIYO_TIBIA;
  const float dMax = fe + ti - 0.001f;
  const float dMin = fabsf(fe - ti) + 0.001f;
  bool reachable = true;
  if (d > dMax || d < dMin) {
    const float target = d > dMax ? dMax : dMin;
    if (d < 1.0e-6f) { r = target; z = 0.0f; } else { r *= target / d; z *= target / d; }
    d = target;
    reachable = false;
  }
  const float a1 = acosf(clampF((fe * fe + d * d - ti * ti) / (2.0f * fe * d), -1.0f, 1.0f));
  const float a2 = acosf(clampF((fe * fe + ti * ti - d * d) / (2.0f * fe * ti), -1.0f, 1.0f));
  q[0] = atan2f(ly, lx) * kRad2Deg;            // coxa, + = CCW seen from above
  q[1] = (atan2f(z, r) + a1) * kRad2Deg;       // femur, + = up
  q[2] = (a2 - kHalfPi) * kRad2Deg;            // tibia, + = foot out
  return reachable;
}

struct Gait {
  float vx, vy, wz;     // commanded twist (m/s, m/s, rad/s)
  float sx, sy, sw;     // smoothed twist
  float h, hs;          // commanded / smoothed body height
  float lift;           // 0..1, fades the step height in and out
  float phase;          // 0..1 position in the gait cycle
  uint8_t gait;
};
static Gait gait = { 0, 0, 0, 0, 0, 0, KIYO_STAND_H, KIYO_STAND_H, 0, 0, 0 };
static bool gaitActive = false;
static uint32_t ikMissMask = 0;
static float gFootX[KIYO_LEGS];   // foot targets in the gait frame (before any body sway), m
static float gFootY[KIYO_LEGS];
static float gFootZ[KIYO_LEGS];

static bool gaitSelect(const char* name) {
  for (uint8_t i = 0; i < KIYO_GAIT_KEYS; i++) {
    if (strcmp(name, KIYO_GAIT_KEY[i]) == 0) { gait.gait = KIYO_GAIT_KEY_IDX[i]; return true; }
  }
  return false;
}

// Stop walking and hand the joints back to the joint layer (HOME, E-STOP, relax).
static void gaitStop() {
  gait.vx = gait.vy = gait.wz = 0.0f;
  gaitActive = false;
}

// Fastest foot speed relative to the body, m/s.
static float gaitFootSpeedMax() {
  float vmax = 0.0f;
  for (uint8_t i = 0; i < KIYO_LEGS; i++) {
    const float fx = gait.sx - gait.sw * KIYO_FOOT_Y[i];
    const float fy = gait.sy + gait.sw * KIYO_FOOT_X[i];
    const float s = sqrtf(fx * fx + fy * fy);
    if (s > vmax) vmax = s;
  }
  return vmax;
}

// Leg phase in [0, 1): stance below the duty factor, swing above (same convention as the app).
static float legPhase(uint8_t i) {
  const float ph = gait.phase - KIYO_GAIT_OFFSET[gait.gait][i];
  return ph - floorf(ph);
}
${creep ? creepCpp() : ''}
// Advance the gait by dt and write IK joint targets for every leg.
// Stance feet slide from +stride/2 to -stride/2 at exactly -(v + w x r): no foot skate.
static void gaitStep(float dt) {
  const float a = dt / (KIYO_CMD_TAU_S + dt);
  gait.sx += a * (gait.vx - gait.sx);
  gait.sy += a * (gait.vy - gait.sy);
  gait.sw += a * (gait.wz - gait.sw);
  gait.hs += a * (gait.h - gait.hs);
  const bool moving = fabsf(gait.vx) + fabsf(gait.vy) + fabsf(gait.wz) * KIYO_FOOT_REACH > 0.002f;
  gait.lift += a * ((moving ? 1.0f : 0.0f) - gait.lift);
  const float duty = KIYO_GAIT_DUTY[gait.gait];
  const float vmax = gaitFootSpeedMax();
  // the cycle shortens with speed so the stride stays under KIYO_MAX_STRIDE; high-duty gaits
  // keep a swing of at least KIYO_SWING_MIN_S so the servos can follow it
  const float cycleMin = fmaxf(KIYO_CYCLE_MIN_S, KIYO_SWING_MIN_S / (1.0f - duty));
  const float cycleMax = fmaxf(KIYO_CYCLE_MAX_S, cycleMin);
  float cycle = cycleMax;
  if (vmax * cycle * duty > KIYO_MAX_STRIDE) cycle = clampF(KIYO_MAX_STRIDE / (vmax * duty), cycleMin, cycleMax);
  float scale = 1.0f;
  if (vmax * cycle * duty > KIYO_MAX_STRIDE) scale = KIYO_MAX_STRIDE / (vmax * cycle * duty);
  gait.phase += ${creep ? 'creepAdvance(duty, dt / cycle)' : 'dt / cycle'};
  gait.phase -= floorf(gait.phase);
  const float lift = gait.lift * KIYO_STEP_H;
  const float span = cycle * duty * scale;
  for (uint8_t i = 0; i < KIYO_LEGS; i++) {
    const float ph = legPhase(i);
    float k = 0.0f;
    float z = 0.0f;
    if (ph < duty) {
      k = 0.5f - ph / duty;
    } else {
      const float u = (ph - duty) / (1.0f - duty);
      k = -0.5f + 0.5f * (1.0f - cosf(kPi * u));
      z = lift * sinf(kPi * u);
    }
    gFootX[i] = KIYO_FOOT_X[i] + k * (gait.sx - gait.sw * KIYO_FOOT_Y[i]) * span;
    gFootY[i] = KIYO_FOOT_Y[i] + k * (gait.sy + gait.sw * KIYO_FOOT_X[i]) * span;
    gFootZ[i] = z;
  }${creep ? '\n  creepSway(dt, duty);   // body over the support triangle' : ''}
  for (uint8_t i = 0; i < KIYO_LEGS; i++) {
    float q[3];
    if (!legIk(i, ${creep ? 'gFootX[i] - swayX, gFootY[i] - swayY' : 'gFootX[i], gFootY[i]'}, -gait.hs + gFootZ[i], q)) ikMissMask |= (1UL << i);
    for (uint8_t m = 0; m < 3; m++) jTarget[i * 3 + m] = jointClamp((uint8_t)(i * 3 + m), q[m]);
  }
}`
}

/** C++ creep sway + lift-off gate for the 4-leg crawl, line for line ../gaitRef.ts. */
function creepCpp(): string {
  return String.raw`
// ---------- quadruped creep (crawl) ----------
static float swayX = 0.0f;   // body shift over the support triangle, gait frame, m
static float swayY = 0.0f;

// Triangle of the three feet other than skip: x0 y0 x1 y1 x2 y2.
static void supportTri(uint8_t skip, float* t) {
  uint8_t m = 0;
  for (uint8_t k = 0; k < 4; k++) {
    if (k == skip) continue;
    t[m++] = gFootX[k];
    t[m++] = gFootY[k];
  }
}

// Signed distance from (px, py) to the nearest edge of the triangle: + = inside.
static float triMargin(const float* t, float px, float py) {
  const float orient = (t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]) >= 0.0f ? 1.0f : -1.0f;
  float best = 1.0e9f;
  for (uint8_t e = 0; e < 3; e++) {
    const uint8_t n = (uint8_t)(((e + 1) % 3) * 2);
    const float ex = t[n] - t[e * 2];
    const float ey = t[n + 1] - t[e * 2 + 1];
    const float len = sqrtf(ex * ex + ey * ey);
    const float d = len > 1.0e-9f ? orient * (ex * (py - t[e * 2 + 1]) - ey * (px - t[e * 2])) / len : -1.0e9f;
    if (d < best) best = d;
  }
  return best;
}

// Creep point: from the un-swayed body toward the triangle's incentre, the first point
// KIYO_CREEP_MARGIN inside (margin is concave, so the whole way stays safe).
static bool creepPoint(uint8_t skip, float* ox, float* oy) {
  float t[6];
  supportTri(skip, t);
  const float a = sqrtf((t[4] - t[2]) * (t[4] - t[2]) + (t[5] - t[3]) * (t[5] - t[3]));
  const float b = sqrtf((t[0] - t[4]) * (t[0] - t[4]) + (t[1] - t[5]) * (t[1] - t[5]));
  const float c = sqrtf((t[2] - t[0]) * (t[2] - t[0]) + (t[3] - t[1]) * (t[3] - t[1]));
  const float p = a + b + c;
  const float area2 = fabsf((t[2] - t[0]) * (t[5] - t[1]) - (t[3] - t[1]) * (t[4] - t[0]));
  if (p < 1.0e-9f || area2 < 1.0e-6f * p * p) return false;
  const float ix = (a * t[0] + b * t[2] + c * t[4]) / p;
  const float iy = (a * t[1] + b * t[3] + c * t[5]) / p;
  const float r = triMargin(t, ix, iy);
  const float m0 = triMargin(t, 0.0f, 0.0f);
  const float k = m0 >= KIYO_CREEP_MARGIN ? 0.0f : (r > m0 ? fminf(1.0f, (KIYO_CREEP_MARGIN - m0) / (r - m0)) : 1.0f);
  *ox = ix * k;
  *oy = iy * k;
  return true;
}

// Phase step the lift-off gate allows: the next foot waits until the body is over the other three.
static float creepAdvance(float duty, float dph) {
  if (!KIYO_GAIT_CREEP[gait.gait] || gait.lift < KIYO_CREEP_MIN_LIFT) return dph;
  uint8_t next = 0;
  float wait = 2.0f;
  for (uint8_t k = 0; k < 4; k++) {
    const float psi = legPhase(k);
    if (psi >= duty) return dph;   // a foot is already up: its triangle was checked at lift-off
    if (duty - psi < wait) { wait = duty - psi; next = k; }
  }
  if (wait > dph) return dph;
  float t[6];
  supportTri(next, t);
  if (triMargin(t, swayX, swayY) >= KIYO_CREEP_GATE) return dph;
  return wait > 1.0e-4f ? wait - 1.0e-4f : 0.0f;
}

// Sway target: the swinging foot's creep point, or the last foot's blended into the next one's
// across the four-feet phase, so the body arrives before the next foot lifts.
static bool creepTarget(float duty, float* tx, float* ty) {
  uint8_t next = 0;
  uint8_t prev = 0;
  float wait = 2.0f;
  float ago = 2.0f;
  for (uint8_t k = 0; k < 4; k++) {
    const float psi = legPhase(k);
    if (psi >= duty) return creepPoint(k, tx, ty);
    if (duty - psi < wait) { wait = duty - psi; next = k; }
    if (psi < ago) { ago = psi; prev = k; }
  }
  float ax = 0.0f, ay = 0.0f, bx = 0.0f, by = 0.0f;
  if (!creepPoint(prev, &ax, &ay) || !creepPoint(next, &bx, &by)) return false;
  float u = clampF(ago / fmaxf((ago + wait) * KIYO_SWAY_ARRIVE, 1.0e-6f), 0.0f, 1.0f);
  u = u * u * (3.0f - 2.0f * u);
  *tx = ax + (bx - ax) * u;
  *ty = ay + (by - ay) * u;
  return true;
}

// Low-pass the body toward the target (scaled by the step fade), capped at KIYO_SWAY_MAX_SPEED.
static void creepSway(float dt, float duty) {
  float tx = 0.0f;
  float ty = 0.0f;
  if (!(KIYO_GAIT_CREEP[gait.gait] && gait.lift > 1.0e-4f && creepTarget(duty, &tx, &ty))) tx = ty = 0.0f;
  tx *= gait.lift;
  ty *= gait.lift;
  const float g = dt > 0.0f ? dt / (KIYO_SWAY_TAU_S + dt) : 0.0f;
  float dx = (tx - swayX) * g;
  float dy = (ty - swayY) * g;
  const float step = sqrtf(dx * dx + dy * dy);
  const float cap = KIYO_SWAY_MAX_SPEED * dt;
  if (step > cap) { dx *= cap / step; dy *= cap / step; }
  swayX += dx;
  swayY += dy;
}
`
}

function highLevel(creep: boolean): string {
  return String.raw`${ikAndGait(creep)}

static void robotBegin() {
  outBegin();
  for (uint8_t j = 0; j < KIYO_JOINTS; j++) { jTarget[j] = KIYO_HOME[j]; jOut[j] = KIYO_HOME[j]; }
  if (!gaitSelect(KIYO_GAIT_NAME[0])) gait.gait = 0;
}
${jointCommon(true)}

static bool applyTwist(JsonDocument& doc, JsonArrayConst v, uint32_t now) {
  if (v.size() != 3) { cmdNote.set("cmd v must be [vx, vy, wz]"); return false; }
  const float vx = v[0] | 0.0f;
  const float vy = v[1] | 0.0f;
  const float wz = v[2] | 0.0f;
  if (!isNum(vx) || !isNum(vy) || !isNum(wz)) return false;
  gait.vx = vx;
  gait.vy = vy;
  gait.wz = wz;
  const char* mode = doc["mode"].as<const char*>();
  if (mode != nullptr && !gaitSelect(mode)) {
    Text t;
    t.add("unknown gait '").add(mode).add("', keeping ").add(KIYO_GAIT_NAME[gait.gait]);
    cmdNote.set(t.c_str());
  }
  if (doc["h"].is<float>()) {
    const float h = doc["h"].as<float>();
    if (isNum(h)) gait.h = clampF(h, KIYO_H_MIN, KIYO_H_MAX);
  }
  if (!gaitActive) {
    gaitActive = true;
    gait.sx = gait.sy = gait.sw = 0.0f;
    gait.hs = gait.h;
    gait.lift = 0.0f;${creep ? '\n    swayX = swayY = 0.0f;   // the body starts centred' : ''}
    gaitStep(0.0f);                        // stance targets at the current phase
    jointsBlend(now, KIYO_HOME_RAMP_MS);   // ease from the current pose into the stance
  }
  return true;
}

static bool robotCommand(JsonDocument& doc, uint32_t now) {
  JsonArrayConst q = doc["q"].as<JsonArrayConst>();
  if (!q.isNull()) {
    gaitActive = false;   // joint streaming takes over
    return applyQ(q);
  }
  JsonArrayConst v = doc["v"].as<JsonArrayConst>();
  if (v.isNull()) return false;
  return applyTwist(doc, v, now);
}

static void robotControl(float dt, uint32_t now) {
  if (gaitActive) gaitStep(dt);   // a running blend eases toward the moving gait targets
  jointsStep(now);
}

static void robotFlushLogs() {
  logClamps();
  cmdNote.flush("warn");
  if (ikMissMask == 0) return;
  Text t;
  t.add("IK: foot target out of reach on leg");
  for (uint8_t i = 0; i < KIYO_LEGS; i++) {
    if (ikMissMask & (1UL << i)) t.add(" L").add((unsigned long)(i + 1));
  }
  ikMissMask = 0;
  log("warn", t.c_str());
}

static void robotSafe(bool relax) {
  gait.vx = gait.vy = gait.wz = 0.0f;   // stop walking, the feet settle into the stance
  if (relax) {
    gaitStop();
    jointsEnable(false);
  }
}

static void robotEstop() {
  gaitStop();
  jointsEnable(false);
}`
}

export function walkerSection(ctx: GenContext): string {
  const high = ctx.level === 'high' && ctx.walker !== null
  return block(String.raw`
// ===================== robot: walker (${high ? 'on-board gait + IK' : 'joint streaming'}) =====================
namespace kiyo {
${high && ctx.walker ? highLevel(hasCreep(ctx.walker)) : jointLevel()}

}  // namespace kiyo
`)
}
