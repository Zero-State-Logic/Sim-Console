import type { Example } from './types'

/* Swarm examples. World frame is three.js Y-up: x, z on the ground, y = altitude. */

const HOP_CPP = `// Triangle formation hop
// Take off, form a triangle, then hop the whole formation between four
// corners by replacing the route waypoint every 6 seconds.

const float HOP[4][2] = {{1.5, 0.0}, {0.0, 1.5}, {-1.5, 0.0}, {0.0, -1.5}};
int corner = 0;
unsigned long lastHop = 0;

void setup() {
  Serial.begin(115200);
  takeoff();
  setFormation(2);           // 0 line, 1 wedge, 2 triangle, 3 circle, 4 column
}

void loop() {
  if (millis() - lastHop >= 6000) {
    lastHop = millis();
    clearWaypoints();
    addWaypoint(HOP[corner][0], HOP[corner][1]);
    Serial.print("hop to corner ");
    Serial.print(corner);
    Serial.print("  leader alt ");
    Serial.print(readY(0), 2);
    Serial.println(" m");
    corner = (corner + 1) % 4;
  }
}
`

const HOP_JS = `// Triangle formation hop
// Take off, form a triangle, then hop the whole formation between four
// corners by replacing the route waypoint every 6 seconds.

const HOPS = [[1.5, 0], [0, 1.5], [-1.5, 0], [0, -1.5]]
let corner = 0

function setup() {
  takeoff()
  setFormation(2)            // 0 line, 1 wedge, 2 triangle, 3 circle, 4 column
}

async function loop() {
  await delay(6000)
  const [x, z] = HOPS[corner]
  clearWaypoints()
  addWaypoint(x, z)
  Serial.println('hop to corner ' + corner + '  leader alt ' + readY(0).toFixed(2) + ' m')
  corner = (corner + 1) % HOPS.length
}
`

const ORBIT_CPP = `// Orbit a point with setTarget()
// Every drone leaves the formation and flies its own slot on a circle
// around (CX, CZ), nose toward the center. The slots rotate: the swarm orbits.

const float CX = 0.0;
const float CZ = 0.0;
const float R = 1.2;         // m
const float ALT = 1.2;       // m
const float RATE = 20.0;     // deg/s

void setup() {
  Serial.begin(115200);
  takeoff();
}

void loop() {
  if (millis() < 3000) return;          // climb first
  int n = (int)droneCount();
  float base = millis() / 1000.0 * RATE;
  for (int i = 0; i < n; i++) {
    float a = radians(base + 360.0 * i / n);
    setTarget(i, CX + R * cos(a), ALT, CZ + R * sin(a));
    setYaw(i, 180.0 - degrees(a));       // face the center
  }
}
`

const ORBIT_JS = `// Orbit a point with setTarget()
// Every drone leaves the formation and flies its own slot on a circle
// around (CX, CZ), nose toward the center. The slots rotate: the swarm orbits.

const CX = 0, CZ = 0
const R = 1.2        // m
const ALT = 1.2      // m
const RATE = 20      // deg/s

async function setup() {
  takeoff()
  await delay(3000)  // climb first
}

function loop() {
  const n = droneCount()
  const base = (millis() / 1000) * RATE
  for (let i = 0; i < n; i++) {
    const a = radians(base + (360 * i) / n)
    setTarget(i, CX + R * Math.cos(a), ALT, CZ + R * Math.sin(a))
    setYaw(i, 180 - degrees(a))          // face the center
  }
  watch('speed0', readSpeed(0))
}
`

const BATTERY_CPP = `// Land on low battery
// Fly a square route in a wedge and watch every pack. When the weakest drone
// drops below LOW_PCT, the whole swarm lands. A real pack lands near 25 %;
// 92 % keeps the demo short (a full pack hovers about 6 minutes).

const float LOW_PCT = 92.0;
bool landing = false;
unsigned long lastLog = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  takeoff();
  setFormation(1);           // wedge
  clearWaypoints();
  addWaypoint(2.0, 2.0);
  addWaypoint(-2.0, 2.0);
  addWaypoint(-2.0, -2.0);
  addWaypoint(2.0, -2.0);
}

void loop() {
  int n = (int)droneCount();
  float weakest = 100.0;
  int weakestId = 0;
  for (int i = 0; i < n; i++) {
    float b = readBattery(i);
    if (b < weakest) {
      weakest = b;
      weakestId = i;
    }
  }
  if (millis() - lastLog >= 2000) {
    lastLog = millis();
    Serial.print("weakest pack: drone ");
    Serial.print(weakestId);
    Serial.print(" at ");
    Serial.print(weakest, 1);
    Serial.println(" %");
  }
  if (!landing && weakest < LOW_PCT) {
    landing = true;
    land();
    Serial.println("LOW BATTERY: landing every drone");
  }
  digitalWrite(LED_BUILTIN, landing && (millis() / 250) % 2 == 0 ? HIGH : LOW);
}
`

const BATTERY_JS = `// Land on low battery
// Fly a square route in a wedge and watch every pack. When the weakest drone
// drops below LOW_PCT, the whole swarm lands. A real pack lands near 25 %;
// 92 % keeps the demo short (a full pack hovers about 6 minutes).

const LOW_PCT = 92
let landing = false

function setup() {
  pinMode(LED_BUILTIN, OUTPUT)
  takeoff()
  setFormation(1)            // wedge
  clearWaypoints()
  for (const [x, z] of [[2, 2], [-2, 2], [-2, -2], [2, -2]]) addWaypoint(x, z)
}

function loop() {
  const packs = []
  for (let i = 0; i < droneCount(); i++) packs.push(readBattery(i))
  const weakest = Math.min(...packs)
  watch('packs %', packs.map((b) => Number(b.toFixed(1))))
  if (!landing && weakest < LOW_PCT) {
    landing = true
    land()
    Serial.println('LOW BATTERY (' + weakest.toFixed(1) + ' %): landing every drone')
  }
  digitalWrite(LED_BUILTIN, landing && Math.floor(millis() / 250) % 2 === 0 ? HIGH : LOW)
}
`

export const SWARM_EXAMPLES: Example[] = [
  { id: 'swarm-hop', title: 'Triangle formation hop', summary: 'Take off, form a triangle, hop between corners.', cpp: HOP_CPP, js: HOP_JS },
  { id: 'swarm-orbit', title: 'Orbit a point with setTarget()', summary: 'Every drone flies its own rotating slot on a circle.', cpp: ORBIT_CPP, js: ORBIT_JS },
  { id: 'swarm-battery', title: 'Land on low battery', summary: 'Fly a route and land when the weakest pack runs low.', cpp: BATTERY_CPP, js: BATTERY_JS },
]
