import { block } from '../format'

/* ============================================================
   C++ CORE — helpers every kiyobridge.h shares: number-safe math,
   the NDJSON line writer (no printf floats: newlib-nano on STM32
   cannot print them), the bounded line reader, and log/send.
   Identifiers avoid Arduino macro names (min, max, round, F, B1..).
   ============================================================ */

export function cppUtils(): string {
  return block(String.raw`
// ===================== small utilities =====================
namespace kiyo {

static inline bool isNum(float v) { return v == v && v - v == 0.0f; }
static inline float clampF(float v, float lo, float hi) { return v < lo ? lo : (v > hi ? hi : v); }
static inline long roundL(float v) { return (long)(v < 0.0f ? v - 0.5f : v + 0.5f); }
static inline bool elapsed(uint32_t now, uint32_t since, uint32_t ms) { return (uint32_t)(now - since) >= ms; }

static const float kPi = 3.14159265f;
static const float kHalfPi = 1.57079633f;
static const float kRad2Deg = 57.2957795f;
static const float kDeg2Rad = 0.0174532925f;

// NDJSON line builder with a fixed buffer. Formats numbers itself.
class Writer {
 public:
  Writer& start() { n_ = 0; overflow_ = false; return *this; }
  Writer& begin(const char* type) { start(); raw("{\"t\":\""); raw(type); return put('"'); }
  Writer& key(const char* k) { put(','); put('"'); raw(k); return raw("\":"); }
  Writer& raw(const char* s) { while (*s) put(*s++); return *this; }
  Writer& put(char c) {
    if (n_ < sizeof(buf_) - 3) buf_[n_++] = c;
    else overflow_ = true;
    return *this;
  }
  Writer& str(const char* s) {
    put('"');
    for (; *s; s++) {
      const char c = *s;
      if (c == '"' || c == '\\') { put('\\'); put(c); }
      else if ((unsigned char)c < 0x20) put(' ');
      else put(c);
    }
    return put('"');
  }
  Writer& unum(unsigned long v) {
    char tmp[11];
    uint8_t i = 0;
    do { tmp[i++] = (char)('0' + (v % 10UL)); v /= 10UL; } while (v > 0UL && i < sizeof(tmp));
    while (i > 0) put(tmp[--i]);
    return *this;
  }
  Writer& num(long v) {
    if (v < 0) { put('-'); return unum((unsigned long)(-(v + 1L)) + 1UL); }
    return unum((unsigned long)v);
  }
  // Fixed-point float, 0-4 decimals. Non-finite values are written as 0.
  Writer& fix(float v, uint8_t decimals) {
    static const long kScale[5] = { 1L, 10L, 100L, 1000L, 10000L };
    if (!isNum(v)) return raw("0");
    if (decimals > 4) decimals = 4;
    const long scale = kScale[decimals];
    const float lim = 2.0e9f / (float)scale;
    long q = roundL(clampF(v, -lim, lim) * (float)scale);
    if (q < 0) { put('-'); q = -q; }
    unum((unsigned long)(q / scale));
    if (decimals > 0) {
      put('.');
      const long frac = q % scale;
      for (long d = scale / 10L; d > 0L; d /= 10L) put((char)('0' + (frac / d) % 10L));
    }
    return *this;
  }
  Writer& boolean(bool b) { return raw(b ? "true" : "false"); }
  // Close the object and add the newline; returns the line length.
  size_t end() {
    buf_[n_++] = '}';
    buf_[n_++] = '\n';
    buf_[n_] = 0;
    return n_;
  }
  const char* data() const { return buf_; }
  bool overflow() const { return overflow_; }

 private:
  char buf_[KIYO_TX_BUF];
  size_t n_ = 0;
  bool overflow_ = false;
};

// Bounded, non-blocking line assembler. Lines over KIYO_MAX_LINE are dropped whole.
class LineReader {
 public:
  // Feed one byte; true when a complete line is ready in line().
  bool feed(char c) {
    if (c == '\n') {
      const bool ready = !dropping_ && n_ > 0;
      buf_[n_] = 0;
      len_ = n_;
      n_ = 0;
      dropping_ = false;
      return ready;
    }
    if (c == '\r' || dropping_) return false;
    if (n_ >= KIYO_MAX_LINE - 1) {
      dropping_ = true;
      n_ = 0;
      overflows_++;
      return false;
    }
    buf_[n_++] = c;
    return false;
  }
  const char* line() const { return buf_; }
  size_t length() const { return len_; }
  uint32_t takeOverflows() { const uint32_t o = overflows_; overflows_ = 0; return o; }

 private:
  char buf_[KIYO_MAX_LINE];
  size_t n_ = 0;
  size_t len_ = 0;
  bool dropping_ = false;
  uint32_t overflows_ = 0;
};

// Short message builder for log text ("servos 4, 7 clamped").
class Text {
 public:
  Text& add(const char* s) { while (*s && n_ < sizeof(b_) - 1) b_[n_++] = *s++; b_[n_] = 0; return *this; }
  Text& add(unsigned long v) {
    char tmp[11];
    uint8_t i = 0;
    do { tmp[i++] = (char)('0' + (v % 10UL)); v /= 10UL; } while (v > 0UL && i < sizeof(tmp));
    while (i > 0 && n_ < sizeof(b_) - 1) b_[n_++] = tmp[--i];
    b_[n_] = 0;
    return *this;
  }
  const char* c_str() const { return b_; }
  bool empty() const { return n_ == 0; }

 private:
  char b_[200] = { 0 };
  size_t n_ = 0;
};

}  // namespace kiyo
`)
}

/** send() and log(), placed after the link section (they call linkWrite). */
export function cppSend(): string {
  return block(String.raw`
// ===================== outgoing lines =====================
namespace kiyo {

static Writer telW;
static Writer msgW;
static uint32_t txDropped = 0;

static void send(Writer& w) {
  if (w.overflow()) { txDropped++; return; }
  const size_t n = w.end();
  linkWrite(w.data(), n);
}

// One log line for the app's serial monitor. lvl: "info", "warn" or "err".
static void log(const char* lvl, const char* msg) {
  msgW.begin("log").key("lvl").str(lvl).key("msg").str(msg);
  send(msgW);
}

// A pending diagnostic, sent by the once-a-second log flush (never at the command rate).
class Note {
 public:
  void set(const char* s) {
    size_t i = 0;
    for (; s[i] && i < sizeof(b_) - 1; i++) b_[i] = s[i];
    b_[i] = 0;
    pending_ = true;
  }
  void flush(const char* lvl) {
    if (!pending_) return;
    pending_ = false;
    log(lvl, b_);
  }

 private:
  char b_[120] = { 0 };
  bool pending_ = false;
};

}  // namespace kiyo
`)
}
