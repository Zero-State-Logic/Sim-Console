import type { GenContext } from '../context'
import { ESPNOW_CHANNEL, FW_ID } from '../context'
import { block, cFloat, cList } from '../format'

/* ============================================================
   C++ SWARM — the ESP32 is a ground-station relay: it takes the
   app's drone setpoints (cmd sp) and broadcasts them over ESP-NOW;
   drones answer with their state, which becomes tel.drones.
   A second sketch runs on each drone and hands the setpoints to
   the user's flight controller. Stabilisation stays on the FC.
   ============================================================ */

/** ESP-NOW payload limit (ESP_NOW_MAX_DATA_LEN). */
export const ESPNOW_MAX_BYTES = 250
/** Bytes of the command packet header and of one setpoint (packed structs below). */
export const CMD_PKT_HEAD = 6
export const SETPOINT_BYTES = 17
/** Most drones whose setpoints fit in one ESP-NOW packet. */
export const MAX_SWARM_DRONES = Math.floor((ESPNOW_MAX_BYTES - CMD_PKT_HEAD) / SETPOINT_BYTES)

/**
 * Battery percent below this goes on the wire as 0: the app (src/robots/swarm/hardwareIO.ts)
 * decodes 0-4.35 as a 1S cell voltage, so 1-4 % would read as 0-85 %.
 */
export const BAT_FLOOR_PCT = 4.5

/** What the relay sends in tel.drones[].bat for a drone's battery percent (reference for tests). */
export function batteryOnWire(pct: number): number {
  const p = Math.min(Math.max(pct, 0), 100)
  return p < BAT_FLOOR_PCT ? 0 : Math.round(p)
}

/** Mission phases the app sends in cmd.mode, as the byte the drones receive. */
export const SWARM_PHASES = ['idle', 'takeoff', 'mission', 'landing'] as const

/** Packet layout shared by the relay and the drone sketch (must match on both ends). */
export function packetDefs(): string {
  return String.raw`
// ESP-NOW packets (little-endian, packed). Keep identical on the relay and the drones.
#define KIYO_PKT_MAGIC 0x4B
enum KiyoPktKind : uint8_t { kPktSetpoint = 1, kPktHold = 2, kPktLand = 3, kPktEstop = 4, kPktState = 16 };
// mission phase from the app's cmd.mode (0 = not sent)
enum KiyoPhase : uint8_t { kPhaseNone = 0, kPhaseIdle = 1, kPhaseTakeoff = 2, kPhaseMission = 3, kPhaseLanding = 4 };
struct __attribute__((packed)) KiyoSp {
  uint8_t id;
  float x, y, z;    // app world frame, meters (y up): ENU = (x, -z, y)
  float yawDeg;
};
struct __attribute__((packed)) KiyoCmdPkt {
  uint8_t magic;
  uint8_t kind;
  uint16_t seq;
  uint8_t count;
  uint8_t phase;    // KiyoPhase
  KiyoSp sp[KIYO_DRONES];
};
static_assert(sizeof(KiyoCmdPkt) <= ${ESPNOW_MAX_BYTES}, "too many drones for one ESP-NOW packet");
struct __attribute__((packed)) KiyoStatePkt {
  uint8_t magic;
  uint8_t kind;
  uint8_t id;
  float x, y, z;                // app world frame, meters
  float rollDeg, pitchDeg, yawDeg;
  float bat;                    // battery percent 0..100, or a negative value when unknown
};`
}

export function swarmConfig(ctx: GenContext): string {
  const macs = Array.from({ length: ctx.drones }, () => '{ 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF }')
  return block(String.raw`
// ---------- ESP-NOW relay ----------
#define KIYO_ESPNOW_CHANNEL ${ESPNOW_CHANNEL}            // the drones must listen on the same WiFi channel
#define KIYO_SAFE_RESEND_MS 200          // hold / land / estop packets repeat this often
#define KIYO_DRONE_STALE_MS 1000         // drone state older than this is not reported
#define KIYO_BAT_FLOOR_PCT ${cFloat(BAT_FLOOR_PCT, 1)}        // battery below this is reported as 0 % (see robotTelemetry)
// ESP-NOW address per drone (the swarm's "pin map"). Broadcast reaches every drone;
// put a drone's MAC here to unicast to it instead.
static const uint8_t KIYO_DRONE_MAC[KIYO_DRONES][6] = ${cList(macs, 1)};
${packetDefs()}`)
}

export function swarmIncludes(): string[] {
  return ['<WiFi.h>', '<esp_now.h>', '<esp_wifi.h>', '<freertos/FreeRTOS.h>', '<freertos/queue.h>']
}

function relayRadio(ctx: GenContext): string {
  const wifi =
    ctx.link === 'ws'
      ? '  // WiFi (and its channel) is already up: the WebSocket link started it'
      : '  WiFi.mode(WIFI_STA);\n  WiFi.disconnect();\n  esp_wifi_set_channel(KIYO_ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);'
  return String.raw`
static QueueHandle_t stateQ = nullptr;
static KiyoCmdPkt pkt;
static uint16_t pktSeq = 0;
static uint8_t phase = kPhaseNone;    // last mission phase from the app
static uint8_t safeKind = kPktHold;   // repeated while no setpoints stream (hold / land / estop)
static uint32_t lastSafeMs = 0;
static uint32_t sendFails = 0;
static uint32_t homeDoneAt = 0;

struct DroneState { KiyoStatePkt s; uint32_t at; bool valid; };
static DroneState drones[KIYO_DRONES];

static void nowHandle(const uint8_t* data, int len) {
  if (stateQ == nullptr || len != (int)sizeof(KiyoStatePkt) || data[0] != KIYO_PKT_MAGIC || data[1] != kPktState) return;
  KiyoStatePkt s;
  memcpy(&s, data, sizeof(s));
  xQueueSend(stateQ, &s, 0);   // ESP-NOW callbacks run in the WiFi task: hand over, parse in update()
}

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
static void nowRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) { (void)info; nowHandle(data, len); }
#else
static void nowRecv(const uint8_t* mac, const uint8_t* data, int len) { (void)mac; nowHandle(data, len); }
#endif

static bool sameMac(const uint8_t* a, const uint8_t* b) { return memcmp(a, b, 6) == 0; }

// One packet to every distinct address in KIYO_DRONE_MAC (a single broadcast by default).
static void nowSend(uint8_t kind, uint8_t count) {
  pkt.magic = KIYO_PKT_MAGIC;
  pkt.kind = kind;
  pkt.seq = pktSeq++;
  pkt.count = count;
  pkt.phase = phase;
  const size_t len = sizeof(KiyoCmdPkt) - sizeof(KiyoSp) * (KIYO_DRONES - count);
  for (uint8_t i = 0; i < KIYO_DRONES; i++) {
    bool seen = false;
    for (uint8_t k = 0; k < i; k++) seen = seen || sameMac(KIYO_DRONE_MAC[i], KIYO_DRONE_MAC[k]);
    if (!seen && esp_now_send(KIYO_DRONE_MAC[i], (const uint8_t*)&pkt, len) != ESP_OK) sendFails++;
  }
}

static void robotBegin() {
${wifi}
  stateQ = xQueueCreate(16, sizeof(KiyoStatePkt));
  if (esp_now_init() != ESP_OK) {
    log("err", "ESP-NOW init failed");
    return;
  }
  esp_now_register_recv_cb(nowRecv);
  for (uint8_t i = 0; i < KIYO_DRONES; i++) {
    if (esp_now_is_peer_exist(KIYO_DRONE_MAC[i])) continue;
    esp_now_peer_info_t peer;
    memset(&peer, 0, sizeof(peer));
    memcpy(peer.peer_addr, KIYO_DRONE_MAC[i], 6);
    peer.channel = 0;   // current channel
    peer.encrypt = false;
    esp_now_add_peer(&peer);
  }
  for (uint8_t i = 0; i < KIYO_DRONES; i++) drones[i].valid = false;
}`
}

function relayRobot(): string {
  return String.raw`
static void setSafe(uint8_t kind) {
  safeKind = kind;
  lastSafeMs = millis();
  nowSend(kind, 0);
}

static void robotHomeStart(uint32_t now) {
  setSafe(kPktHold);   // drones hold position until setpoints stream
  homeDoneAt = now;
}

static bool robotHomeDone(uint32_t now) { return (int32_t)(now - homeDoneAt) >= 0; }

static uint8_t phaseOf(const char* mode) {
  if (mode == nullptr) return phase;
  if (strcmp(mode, "idle") == 0) return kPhaseIdle;
  if (strcmp(mode, "takeoff") == 0) return kPhaseTakeoff;
  if (strcmp(mode, "mission") == 0) return kPhaseMission;
  if (strcmp(mode, "landing") == 0) return kPhaseLanding;
  return phase;
}

static bool robotCommand(JsonDocument& doc, uint32_t now) {
  (void)now;
  const char* mode = doc["mode"].as<const char*>();
  phase = phaseOf(mode);
  JsonArrayConst sp = doc["sp"].as<JsonArrayConst>();
  if (sp.isNull()) {
    // no setpoints: explicit safe commands only
    if (mode != nullptr && strcmp(mode, "land") == 0) { setSafe(kPktLand); return true; }
    if (mode != nullptr && strcmp(mode, "hold") == 0) { setSafe(kPktHold); return true; }
    return false;
  }
  uint8_t n = 0;
  for (JsonObjectConst e : sp) {
    if (n >= KIYO_DRONES) break;
    JsonArrayConst p = e["p"].as<JsonArrayConst>();
    if (p.isNull() || p.size() != 3) continue;
    const float x = p[0] | 0.0f;
    const float y = p[1] | 0.0f;
    const float z = p[2] | 0.0f;
    if (!isNum(x) || !isNum(y) || !isNum(z)) continue;
    pkt.sp[n].id = (uint8_t)(e["id"] | 0);
    pkt.sp[n].x = x;
    pkt.sp[n].y = y;
    pkt.sp[n].z = z;
    pkt.sp[n].yawDeg = e["yaw"] | 0.0f;
    n++;
  }
  if (n == 0) return false;
  safeKind = 0;
  nowSend(kPktSetpoint, n);
  return true;
}

static void robotControl(float dt, uint32_t now) {
  (void)dt;
  KiyoStatePkt s;
  while (stateQ != nullptr && xQueueReceive(stateQ, &s, 0) == pdTRUE) {
    for (uint8_t i = 0; i < KIYO_DRONES; i++) {
      if (!drones[i].valid || drones[i].s.id == s.id) {
        drones[i].s = s;
        drones[i].at = now;
        drones[i].valid = true;
        break;
      }
    }
  }
  if (safeKind != 0 && elapsed(now, lastSafeMs, KIYO_SAFE_RESEND_MS)) {
    lastSafeMs = now;
    nowSend(safeKind, 0);
  }
}

static void robotSafe(bool relax) { setSafe(relax ? kPktLand : kPktHold); }

static void robotEstop() {
  for (uint8_t i = 0; i < 3; i++) setSafe(kPktEstop);   // broadcast is unacknowledged: say it three times
}

static void robotTelemetry(Writer& w) {
  const uint32_t now = millis();
  w.key("drones").put('[');
  bool first = true;
  for (uint8_t i = 0; i < KIYO_DRONES; i++) {
    const DroneState& d = drones[i];
    if (!d.valid || elapsed(now, d.at, KIYO_DRONE_STALE_MS)) continue;
    if (!first) w.put(',');
    first = false;
    w.raw("{\"id\":").unum(d.s.id);
    w.raw(",\"p\":[").fix(d.s.x, 3).put(',').fix(d.s.y, 3).put(',').fix(d.s.z, 3).put(']');
    w.raw(",\"att\":[").fix(d.s.rollDeg, 1).put(',').fix(d.s.pitchDeg, 1).put(',').fix(d.s.yawDeg, 1).put(']');
    if (d.s.bat >= 0.0f) {
      // whole percent; below KIYO_BAT_FLOOR_PCT it goes out as 0, because the app reads
      // values up to 4.35 as a cell voltage (4 % would show as a full battery)
      const float pct = clampF(d.s.bat, 0.0f, 100.0f);
      w.raw(",\"bat\":").fix(pct < KIYO_BAT_FLOOR_PCT ? 0.0f : pct, 0);
    }
    w.put('}');
  }
  w.put(']');
}

static void robotCaps(Writer& w) { (void)w; }

static void robotFlushLogs() {
  if (sendFails == 0) return;
  Text t;
  t.add("ESP-NOW: ").add((unsigned long)sendFails).add(" sends failed");
  sendFails = 0;
  log("warn", t.c_str());
}`
}

export function swarmSection(ctx: GenContext): string {
  return block(String.raw`
// ===================== robot: swarm ground-station relay (ESP-NOW) =====================
namespace kiyo {
${relayRadio(ctx)}
${relayRobot()}

}  // namespace kiyo
`)
}

/** Sketch for each drone's ESP32 (or a companion ESP32 wired to the flight controller). */
export function droneSketch(ctx: GenContext): string {
  return block(String.raw`
/*
 * ${ctx.sketch}_drone.ino  -  SIM CONSOLE swarm, drone side (${FW_ID}).
 * Flash this on an ESP32 on each drone (or one wired to its flight controller).
 * It receives the relay's ESP-NOW setpoints and hands them to YOUR flight-controller
 * code below. Flight stabilisation (attitude and rate loops, motor mixing, failsafes)
 * stays on the flight controller: this sketch only delivers position setpoints and
 * reports the drone's state back to the relay.
 *
 * Set KIYO_DRONE_ID to 0, 1, 2, ... (one per drone, matching the app's drone ids).
 */
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#define KIYO_DRONE_ID 0                  // <-- change per drone
#define KIYO_DRONES ${ctx.drones}
#define KIYO_ESPNOW_CHANNEL ${ESPNOW_CHANNEL}            // same channel as the relay
#define KIYO_STATE_PERIOD_MS 100         // state report rate (10 Hz)
#define KIYO_LINK_TIMEOUT_MS 1000        // no packet for this long: hold
${packetDefs()}

static const uint8_t KIYO_BCAST[6] = { 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF };
static portMUX_TYPE rxMux = portMUX_INITIALIZER_UNLOCKED;
static KiyoCmdPkt rxPkt;
static volatile bool rxFresh = false;
static uint32_t lastRxMs = 0;
static bool linkLost = true;

// ---------- connect these to your flight controller ----------
// Position setpoint in the app's world frame (meters, y up). For ENU use (x, -z, y);
// for MAVLink LOCAL_NED use north = -z, east = x, down = -y.
void kiyoOnSetpoint(float x, float y, float z, float yawDeg) {
  (void)x; (void)y; (void)z; (void)yawDeg;
  // e.g. send SET_POSITION_TARGET_LOCAL_NED (MAVLink) or an MSP command to the FC
}
void kiyoOnHold() { /* hold the current position */ }
void kiyoOnLand() { /* land in place */ }
void kiyoOnEstop() { /* disarm NOW (the drone will fall) or trigger the FC's emergency land */ }
// The app's mission phase changed (KiyoPhase): e.g. arm on kPhaseTakeoff, disarm on kPhaseIdle.
void kiyoOnPhase(uint8_t phase) { (void)phase; }
// Fill the drone's state for the app; return false to skip a report.
// bat = battery percent 0..100 (leave it negative when unknown).
bool kiyoReadState(float* x, float* y, float* z, float* rollDeg, float* pitchDeg, float* yawDeg, float* bat) {
  (void)x; (void)y; (void)z; (void)rollDeg; (void)pitchDeg; (void)yawDeg;
  *bat = -1.0f;   // unknown
  return false;
}
// -------------------------------------------------------------

// Runs in the WiFi task: copy the packet out, loop() handles it.
static void onPacket(const uint8_t* data, int len) {
  if (len < ${CMD_PKT_HEAD} || len > (int)sizeof(KiyoCmdPkt) || data[0] != KIYO_PKT_MAGIC) return;
  portENTER_CRITICAL(&rxMux);
  memset(&rxPkt, 0, sizeof(rxPkt));
  memcpy(&rxPkt, data, (size_t)len);
  rxFresh = true;
  portEXIT_CRITICAL(&rxMux);
}

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
static void onRecv(const esp_now_recv_info_t* info, const uint8_t* data, int len) { (void)info; onPacket(data, len); }
#else
static void onRecv(const uint8_t* mac, const uint8_t* data, int len) { (void)mac; onPacket(data, len); }
#endif

static uint8_t lastPhase = kPhaseNone;

static void handle(const KiyoCmdPkt& p) {
  lastRxMs = millis();
  linkLost = false;
  if (p.phase != kPhaseNone && p.phase != lastPhase) {
    lastPhase = p.phase;
    kiyoOnPhase(p.phase);
  }
  if (p.kind == kPktHold) { kiyoOnHold(); return; }
  if (p.kind == kPktLand) { kiyoOnLand(); return; }
  if (p.kind == kPktEstop) { kiyoOnEstop(); return; }
  if (p.kind != kPktSetpoint) return;
  for (uint8_t i = 0; i < p.count && i < KIYO_DRONES; i++) {
    if (p.sp[i].id == KIYO_DRONE_ID) kiyoOnSetpoint(p.sp[i].x, p.sp[i].y, p.sp[i].z, p.sp[i].yawDeg);
  }
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  esp_wifi_set_channel(KIYO_ESPNOW_CHANNEL, WIFI_SECOND_CHAN_NONE);
  if (esp_now_init() != ESP_OK) {
    Serial.println("[kiyo] ESP-NOW init failed");
    return;
  }
  esp_now_register_recv_cb(onRecv);
  esp_now_peer_info_t peer;
  memset(&peer, 0, sizeof(peer));
  memcpy(peer.peer_addr, KIYO_BCAST, 6);
  peer.channel = 0;
  peer.encrypt = false;
  esp_now_add_peer(&peer);
  Serial.print("[kiyo] drone ");
  Serial.print(KIYO_DRONE_ID);
  Serial.print(" listening, MAC ");
  Serial.println(WiFi.macAddress());
}

void loop() {
  if (rxFresh) {
    KiyoCmdPkt p;
    portENTER_CRITICAL(&rxMux);
    memcpy(&p, &rxPkt, sizeof(p));
    rxFresh = false;
    portEXIT_CRITICAL(&rxMux);
    handle(p);
  }
  const uint32_t now = millis();
  if (!linkLost && now - lastRxMs > KIYO_LINK_TIMEOUT_MS) {
    linkLost = true;
    kiyoOnHold();   // relay silent: hold position (your FC's own failsafe still applies)
  }
  static uint32_t lastState = 0;
  if (now - lastState >= KIYO_STATE_PERIOD_MS) {
    lastState = now;
    // read into aligned locals: the packed struct's floats are unaligned (Xtensa faults on those)
    float x = 0.0f, y = 0.0f, z = 0.0f, roll = 0.0f, pitch = 0.0f, yaw = 0.0f, bat = -1.0f;
    if (kiyoReadState(&x, &y, &z, &roll, &pitch, &yaw, &bat)) {
      KiyoStatePkt s;
      memset(&s, 0, sizeof(s));
      s.magic = KIYO_PKT_MAGIC;
      s.kind = kPktState;
      s.id = KIYO_DRONE_ID;
      s.x = x;
      s.y = y;
      s.z = z;
      s.rollDeg = roll;
      s.pitchDeg = pitch;
      s.yawDeg = yaw;
      s.bat = bat;
      esp_now_send(KIYO_BCAST, (const uint8_t*)&s, sizeof(s));
    }
  }
  // keep loop() fast: no long delay() here, your FC link code goes below
}
`)
}
