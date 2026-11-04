import type { GenContext } from '../context'
import { NUS, WIFI_PASS_PLACEHOLDER, WS_PORT } from '../context'
import { BLE_NAME_MAX } from '../validate'
import { asciiOnly, block, cString } from '../format'

/* ============================================================
   C++ LINK — one transport per build, behind the same five calls:
   linkBegin, linkPoll, linkRead (non-blocking), linkWrite and
   linkTakeConnect (true once when a client connects, so the board
   re-announces itself with hello).
   ============================================================ */

export function linkIncludes(ctx: GenContext): string[] {
  if (ctx.link === 'ble') return ['<NimBLEDevice.h>        // NimBLE-Arduino 2.x by h2zero', '<freertos/FreeRTOS.h>', '<freertos/stream_buffer.h>']
  if (ctx.link === 'ws') return ['<WiFi.h>', '<WebSocketsServer.h>     // WebSockets (arduinoWebSockets) by Markus Sattler']
  return []
}

export function linkConfig(ctx: GenContext): string {
  if (ctx.link === 'ble') {
    const name = asciiOnly(ctx.hw.bleName).slice(0, BLE_NAME_MAX)
    return block(String.raw`
#define KIYO_BLE_NAME ${cString(name)}
// Nordic UART Service: the app writes to RX, the board notifies on TX
#define KIYO_NUS_SERVICE "${NUS.service}"
#define KIYO_NUS_RX "${NUS.rx}"
#define KIYO_NUS_TX "${NUS.tx}"
#define KIYO_BLE_RX_BUF 2048`)
  }
  if (ctx.link === 'ws') {
    return block(String.raw`
#define KIYO_WIFI_AP ${ctx.hw.wifiMode === 'ap' ? 1 : 0}                  // 1 = the board makes its own network, 0 = join yours
#define KIYO_WIFI_SSID ${cString(ctx.hw.wifiSsid)}
// Type your WiFi password here. It is never stored by SIM CONSOLE.
// Access-point mode needs at least 8 characters.
#define KIYO_WIFI_PASS "${WIFI_PASS_PLACEHOLDER}"
#define KIYO_WS_PORT ${WS_PORT}
#define KIYO_WS_RX_BUF 2048`)
  }
  return ''
}

function serialSection(ctx: GenContext): string {
  const esp32Buffers =
    ctx.board === 'esp32'
      ? `
#if CONFIG_IDF_TARGET_ESP32
  Serial.setRxBufferSize(1024);   // classic ESP32 UART: room for bursts, writes do not block
  Serial.setTxBufferSize(2048);
#endif`
      : ''
  const cdcNote = ctx.usbCdc ? '  // native USB CDC: the baud value is ignored\n' : ''
  const connect = ctx.usbCdc
    ? `static bool linkTakeConnect() {
  // USB CDC: announce again when the app opens the port (DTR goes high)
  static bool was = false;
  const bool open = (bool)Serial;
  const bool edge = open && !was;
  was = open;
  return edge;
}`
    : `static bool linkTakeConnect() { return false; }   // the app asks with "hello?" after opening the port`
  return block(String.raw`
// ===================== link: USB serial =====================
namespace kiyo {

static void linkBegin() {${esp32Buffers}
${cdcNote}  Serial.begin(KIYO_BAUD);
}

static void linkPoll() {}

static int linkRead(char* dst, int max) {
  int n = 0;
  while (n < max) {
    const int c = Serial.read();
    if (c < 0) break;
    dst[n++] = (char)c;
  }
  return n;
}

static void linkWrite(const char* s, size_t n) { Serial.write((const uint8_t*)s, n); }

${connect}

}  // namespace kiyo
`)
}

function bleSection(): string {
  return block(String.raw`
// ===================== link: BLE (NimBLE, Nordic UART Service) =====================
namespace kiyo {

static StreamBufferHandle_t bleRx = nullptr;
static NimBLECharacteristic* bleTx = nullptr;
static volatile bool bleConnected = false;
static volatile bool bleSubscribed = false;
static volatile uint16_t bleChunk = 20;

class BleServerCb : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& info) override {
    (void)server; (void)info;
    bleConnected = true;
    bleChunk = 20;
  }
  void onDisconnect(NimBLEServer* server, NimBLEConnInfo& info, int reason) override {
    (void)server; (void)info; (void)reason;
    bleConnected = false;
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, NimBLEConnInfo& info) override {
    (void)info;
    const uint16_t payload = mtu > 23 ? (uint16_t)(mtu - 3) : 20;
    bleChunk = payload > 180 ? 180 : payload;
  }
};

class BleRxCb : public NimBLECharacteristicCallbacks {
  // Runs in the NimBLE host task: only queue the bytes, update() parses them.
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& info) override {
    (void)info;
    NimBLEAttValue v = c->getValue();
    if (bleRx != nullptr && v.length() > 0) xStreamBufferSend(bleRx, v.data(), v.length(), 0);
  }
};

class BleTxCb : public NimBLECharacteristicCallbacks {
  void onSubscribe(NimBLECharacteristic* c, NimBLEConnInfo& info, uint16_t subValue) override {
    (void)c; (void)info;
    if (subValue != 0) bleSubscribed = true;
  }
};

static void linkBegin() {
  Serial.begin(115200);   // diagnostics only; the app talks over BLE
  bleRx = xStreamBufferCreate(KIYO_BLE_RX_BUF, 1);
  NimBLEDevice::init(KIYO_BLE_NAME);
  NimBLEDevice::setMTU(247);
  NimBLEServer* server = NimBLEDevice::createServer();
  server->setCallbacks(new BleServerCb());
  NimBLEService* svc = server->createService(KIYO_NUS_SERVICE);
  bleTx = svc->createCharacteristic(KIYO_NUS_TX, NIMBLE_PROPERTY::NOTIFY);
  bleTx->setCallbacks(new BleTxCb());
  NimBLECharacteristic* rx = svc->createCharacteristic(KIYO_NUS_RX, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  rx->setCallbacks(new BleRxCb());
  svc->start();
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->setName(KIYO_BLE_NAME);
  adv->addServiceUUID(svc->getUUID());
  adv->enableScanResponse(true);
  adv->start();
  Serial.print("[kiyo] BLE advertising as ");
  Serial.println(KIYO_BLE_NAME);
}

static void linkPoll() {}

static int linkRead(char* dst, int max) {
  if (bleRx == nullptr) return 0;
  return (int)xStreamBufferReceive(bleRx, dst, (size_t)max, 0);
}

// Notifications carry at most MTU-3 bytes, so long lines go out in chunks.
static void linkWrite(const char* s, size_t n) {
  if (!bleConnected || bleTx == nullptr) return;
  const size_t chunk = bleChunk;
  for (size_t i = 0; i < n; i += chunk) {
    const size_t len = (n - i) < chunk ? (n - i) : chunk;
    bleTx->setValue((const uint8_t*)(s + i), len);
    bleTx->notify();
  }
}

static bool linkTakeConnect() {
  if (!bleSubscribed) return false;
  bleSubscribed = false;
  return true;
}

}  // namespace kiyo
`)
}

function wifiBegin(ctx: GenContext, espNow: boolean): string {
  const apMode = espNow ? 'WIFI_AP_STA' : 'WIFI_AP'
  const apStart = espNow ? `WiFi.softAP(KIYO_WIFI_SSID, KIYO_WIFI_PASS, KIYO_ESPNOW_CHANNEL)` : `WiFi.softAP(KIYO_WIFI_SSID, KIYO_WIFI_PASS)`
  const apIp = ctx.board === 'esp32' ? 'WiFi.softAPIP()' : 'WiFi.localIP()'
  const autoReconnect = ctx.board === 'esp32' ? '\n  WiFi.setAutoReconnect(true);' : ''
  return String.raw`
static void wifiBegin() {
  if (strcmp(KIYO_WIFI_PASS, "${WIFI_PASS_PLACEHOLDER}") == 0) Serial.println("[kiyo] WARNING: set KIYO_WIFI_PASS in kiyobridge.h");
#if KIYO_WIFI_AP
  WiFi.mode(${apMode});
  if (!${apStart}) Serial.println("[kiyo] softAP failed (password must be 8+ characters)");
  Serial.print("[kiyo] WiFi AP '");
  Serial.print(KIYO_WIFI_SSID);
  Serial.print("' ready, connect the app to ws://");
  Serial.print(${apIp});
  Serial.print(":");
  Serial.println(KIYO_WS_PORT);
#else
  WiFi.mode(WIFI_STA);${autoReconnect}
  WiFi.begin(KIYO_WIFI_SSID, KIYO_WIFI_PASS);
  Serial.print("[kiyo] joining WiFi '");
  Serial.print(KIYO_WIFI_SSID);
  Serial.print("'");
  const uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < 15000UL) {   // setup only, bounded
    delay(250);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[kiyo] connect the app to ws://");
    Serial.print(WiFi.localIP());
    Serial.print(":");
    Serial.println(KIYO_WS_PORT);
  } else {
    Serial.println("[kiyo] WiFi not connected yet, still trying in the background");
  }
#endif
}`
}

function wsSection(ctx: GenContext): string {
  const espNow = ctx.robot === 'swarm'
  return block(String.raw`
// ===================== link: WiFi WebSocket (port ${WS_PORT}) =====================
namespace kiyo {

static WebSocketsServer ws(KIYO_WS_PORT);
static uint8_t wsRing[KIYO_WS_RX_BUF];
static uint16_t wsHead = 0;
static uint16_t wsTail = 0;
static bool wsNewClient = false;

static void wsPush(const uint8_t* d, size_t n) {
  for (size_t i = 0; i < n; i++) {
    const uint16_t next = (uint16_t)((wsHead + 1) % KIYO_WS_RX_BUF);
    if (next == wsTail) return;   // full: drop the rest, the line reader resyncs on '\n'
    wsRing[wsHead] = d[i];
    wsHead = next;
  }
}

// Runs inside ws.loop() on the loop() thread.
static void wsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  (void)num;
  if (type == WStype_CONNECTED) {
    wsNewClient = true;
  } else if (type == WStype_TEXT) {
    wsPush(payload, length);
    if (length == 0 || payload[length - 1] != '\n') {
      const uint8_t nl = '\n';
      wsPush(&nl, 1);   // one JSON object per WebSocket message
    }
  }
}
${wifiBegin(ctx, espNow)}

static void linkBegin() {
  Serial.begin(115200);   // diagnostics only; the app talks over WiFi
  wifiBegin();
  ws.begin();
  ws.onEvent(wsEvent);
}

static void linkPoll() { ws.loop(); }

static int linkRead(char* dst, int max) {
  int n = 0;
  while (n < max && wsTail != wsHead) {
    dst[n++] = (char)wsRing[wsTail];
    wsTail = (uint16_t)((wsTail + 1) % KIYO_WS_RX_BUF);
  }
  return n;
}

static void linkWrite(const char* s, size_t n) {
  if (ws.connectedClients() > 0) ws.broadcastTXT(s, n);
}

static bool linkTakeConnect() {
  const bool fresh = wsNewClient;
  wsNewClient = false;
  return fresh;
}

}  // namespace kiyo
`)
}

export function linkSection(ctx: GenContext): string {
  if (ctx.link === 'ble') return bleSection()
  if (ctx.link === 'ws') return wsSection(ctx)
  return serialSection(ctx)
}

