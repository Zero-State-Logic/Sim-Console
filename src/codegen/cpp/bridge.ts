import type { GenContext } from '../context'
import { block } from '../format'

/* ============================================================
   C++ BRIDGE — the protocol state machine every build shares.
     boot: outputs off, hello · "home": move to the safe pose, then
     ack · "cmd": only once homed, feeds the watchdog · "estop":
     outputs off + ack, needs "home" again · "ping" → pong ·
     "hello?" → hello · telemetry at KIYO_TEL_HZ · logs at most 1/s.
   ============================================================ */

function hooks(ctx: GenContext): string {
  const robotHooks: string[] = []
  if (ctx.robot === 'walker') {
    robotHooks.push(
      'float kiyo_read_joint_deg(uint8_t joint) __attribute__((weak));   // measured joint angle, deg (NAN = none)',
      'float kiyo_read_load(uint8_t leg) __attribute__((weak));          // foot load 0..1 (NAN = none)',
    )
  }
  if (ctx.robot === 'sweeper') robotHooks.push('float kiyo_read_wheel_speed(uint8_t wheel) __attribute__((weak));   // encoder speed, rad/s, + = forward (NAN = none)')
  return block(String.raw`
// ===================== optional user hooks =====================
// Write any of these in your sketch (exact signature) to add live data to the app's
// instruments. Leave them out and the field is simply omitted: they are weak symbols.
${robotHooks.join('\n')}
bool kiyo_read_imu(float* rollDeg, float* pitchDeg, float* yawDeg) __attribute__((weak));   // false = none
float kiyo_read_vbat() __attribute__((weak));   // battery volts (NAN = none)`)
}

export function hooksSection(ctx: GenContext): string {
  return hooks(ctx)
}

export function bridgeSection(): string {
  return block(String.raw`
// ===================== the bridge =====================
namespace kiyo {
enum State : uint8_t { kIdle = 0, kHoming = 1, kReady = 2, kEstop = 3 };
}

class KiyoBridge {
 public:
  // Call once in setup(). Opens the link and announces the board with hello.
  void begin() {
    kiyo::linkBegin();
    kiyo::robotBegin();
    const uint32_t now = millis();
    lastCtl_ = lastTel_ = lastLog_ = lastCmd_ = now;
    sendHello();
  }

  // Call on every loop() pass. Never blocks.
  void update() {
    kiyo::linkPoll();
    if (kiyo::linkTakeConnect()) sendHello();
    pump();
    const uint32_t now = millis();
    if (state_ == kiyo::kHoming && kiyo::robotHomeDone(now)) {
      state_ = kiyo::kReady;
      lastCmd_ = now;
      tripped_ = false;
      ack("home", true);
    }
    if (state_ == kiyo::kReady) watchdog(now);
    if (kiyo::elapsed(now, lastCtl_, KIYO_CONTROL_PERIOD_MS)) {
      const float dt = (float)(now - lastCtl_) * 0.001f;
      lastCtl_ = now;
      kiyo::robotControl(dt > 0.05f ? 0.05f : dt, now);
    }
    if (kiyo::elapsed(now, lastTel_, KIYO_TEL_PERIOD_MS)) {
      lastTel_ = now;
      sendTel(now);
    }
    if (kiyo::elapsed(now, lastLog_, KIYO_LOG_PERIOD_MS)) {
      lastLog_ = now;
      flushLogs();
    }
  }

  // Send a line to the app's serial monitor. lvl: "info", "warn" or "err".
  void log(const char* msg, const char* lvl = "info") { kiyo::log(lvl, msg); }
  // True once homed and accepting commands.
  bool live() const { return state_ == kiyo::kReady; }
  bool estopped() const { return state_ == kiyo::kEstop; }

 private:
  void pump() {
    char chunk[64];
    for (uint8_t pass = 0; pass < 32; pass++) {   // at most 2 KB per update() keeps loop() responsive
      const int n = kiyo::linkRead(chunk, (int)sizeof(chunk));
      if (n <= 0) break;
      for (int i = 0; i < n; i++) {
        if (reader_.feed(chunk[i])) dispatch(reader_.line(), reader_.length());
      }
    }
  }

  void dispatch(const char* line, size_t len) {
    const DeserializationError err = deserializeJson(doc_, line, len);
    if (err) { badJson_++; return; }
    const char* t = doc_["t"] | "";
    const uint32_t now = millis();
    if (strcmp(t, "cmd") == 0) onCmd(now);
    else if (strcmp(t, "home") == 0) onHome(now);
    else if (strcmp(t, "estop") == 0) onEstop();
    else if (strcmp(t, "ping") == 0) pong(doc_["id"] | 0UL);
    else if (strcmp(t, "hello?") == 0) sendHello();
    else unknown_++;
  }

  void onCmd(uint32_t now) {
    if (state_ != kiyo::kReady) { notReady_++; return; }
    if (!kiyo::robotCommand(doc_, now)) return;
    lastCmd_ = now;
    if (tripped_) {
      tripped_ = false;
      kiyo::log("info", "watchdog cleared, commands resumed");
    }
  }

  void onHome(uint32_t now) {
    state_ = kiyo::kHoming;
    kiyo::robotHomeStart(now);
  }

  void onEstop() {
    kiyo::robotEstop();
    state_ = kiyo::kEstop;
    ack("estop", true);
    kiyo::log("warn", "E-STOP: outputs off, send home to resume");
  }

  void watchdog(uint32_t now) {
    if (tripped_ || !kiyo::elapsed(now, lastCmd_, KIYO_WATCHDOG_MS)) return;
    tripped_ = true;
    kiyo::robotSafe(KIYO_WATCHDOG_RELAX != 0);
    if (KIYO_WATCHDOG_RELAX) {
      state_ = kiyo::kIdle;
      kiyo::log("warn", KIYO_WATCHDOG_TEXT ", outputs relaxed; send home to resume");
    } else {
      kiyo::log("warn", KIYO_WATCHDOG_TEXT ", holding the last pose");
    }
  }

  void ack(const char* of, bool ok) {
    kiyo::msgW.begin("ack").key("of").str(of).key("ok").boolean(ok);
    kiyo::send(kiyo::msgW);
  }

  void pong(unsigned long id) {
    kiyo::msgW.begin("pong").key("id").unum(id);
    kiyo::send(kiyo::msgW);
  }

  void sendHello() {
    kiyo::Writer& w = kiyo::msgW;
    w.start().raw(KIYO_HELLO_HEAD).raw(",\"caps\":[").raw(KIYO_CAPS);
    kiyo::robotCaps(w);
    float r = 0.0f, p = 0.0f, y = 0.0f;
    if (kiyo_read_imu && kiyo_read_imu(&r, &p, &y)) w.raw(",\"imu\"");
    if (kiyo_read_vbat && kiyo::isNum(kiyo_read_vbat())) w.raw(",\"vbat\"");
    w.put(']');
    kiyo::send(w);
  }

  void sendTel(uint32_t now) {
    kiyo::Writer& w = kiyo::telW;
    w.begin("tel").key("ms").unum(now);
    kiyo::robotTelemetry(w);
    float r = 0.0f, p = 0.0f, y = 0.0f;
    if (kiyo_read_imu && kiyo_read_imu(&r, &p, &y) && kiyo::isNum(r) && kiyo::isNum(p) && kiyo::isNum(y)) {
      w.key("imu").put('[').fix(r, 2).put(',').fix(p, 2).put(',').fix(y, 2).put(']');
    }
    if (kiyo_read_vbat) {
      const float v = kiyo_read_vbat();
      if (kiyo::isNum(v)) w.key("vbat").fix(v, 2);
    }
    kiyo::send(w);
  }

  // Rate-limited diagnostics: at most one line per kind per KIYO_LOG_PERIOD_MS.
  void flushLogs() {
    kiyo::robotFlushLogs();
    countLog(notReady_, " cmd ignored: send home first");
    countLog(badJson_, " malformed lines dropped");
    countLog(unknown_, " lines with an unknown type ignored");
    uint32_t over = reader_.takeOverflows();
    countLog(over, " lines over KIYO_MAX_LINE bytes dropped");
    countLog(kiyo::txDropped, " outgoing lines too long for KIYO_TX_BUF");
  }

  void countLog(uint32_t& counter, const char* what) {
    if (counter == 0) return;
    kiyo::Text t;
    t.add((unsigned long)counter).add(what);
    counter = 0;
    kiyo::log("warn", t.c_str());
  }

  kiyo::LineReader reader_;
  JsonDocument doc_;
  uint8_t state_ = kiyo::kIdle;
  bool tripped_ = false;
  uint32_t lastCtl_ = 0;
  uint32_t lastTel_ = 0;
  uint32_t lastLog_ = 0;
  uint32_t lastCmd_ = 0;
  uint32_t notReady_ = 0;
  uint32_t badJson_ = 0;
  uint32_t unknown_ = 0;
};

KiyoBridge Bridge;   // the one bridge: Bridge.begin() in setup(), Bridge.update() in loop()
`)
}
