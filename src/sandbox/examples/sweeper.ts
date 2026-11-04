import type { Example } from './types'

/* Sweeper examples. LiDAR angles are degrees CCW from forward: 90 = left, 270 = right. */

const WALL_CPP = `// Wall follower with readLidar()
// Keeps a wall on the right at TARGET meters. Mecanum wheels can strafe,
// so vy closes the distance error while wz keeps the nose parallel to the
// wall (two rays 20 degrees either side of straight right).

const float TARGET = 0.35;   // m, LiDAR to wall
const float SPEED = 0.18;    // m/s
unsigned long lastLog = 0;

float range(int deg) {
  float r = readLidar(deg);
  return r > 0.02 ? r : 9.0;   // 0 = no return
}

void setup() {
  Serial.begin(115200);
}

void loop() {
  float ahead = min(range(0), min(range(10), range(350)));
  float right = range(270);
  if (ahead < 0.45) {
    drive(0.0, 0.0, 70.0);           // inside corner: spin left
  } else if (right > 1.0) {
    drive(SPEED, 0.0, 0.0);          // no wall yet: go find one
  } else {
    float back = range(250);
    float fwd = range(290);
    float vy = constrain(-1.2 * (right - TARGET), -0.15, 0.15);
    float wz = constrain(300.0 * (back - fwd), -60.0, 60.0);
    drive(SPEED, vy, wz);
  }
  if (millis() - lastLog >= 1000) {
    lastLog = millis();
    Serial.print("right ");
    Serial.print(right, 2);
    Serial.print(" m  ahead ");
    Serial.print(ahead, 2);
    Serial.print(" m  coverage ");
    Serial.print(coverage(), 1);
    Serial.println(" %");
  }
}
`

const WALL_JS = `// Wall follower with readLidar()
// Keeps a wall on the right at TARGET meters. Mecanum wheels can strafe,
// so vy closes the distance error while wz keeps the nose parallel to the
// wall (two rays 20 degrees either side of straight right).

const TARGET = 0.35   // m, LiDAR to wall
const SPEED = 0.18    // m/s
const range = (deg) => {
  const r = readLidar(deg)
  return r > 0.02 ? r : 9   // 0 = no return
}

function loop() {
  const ahead = Math.min(range(0), range(10), range(350))
  const right = range(270)
  if (ahead < 0.45) drive(0, 0, 70)            // inside corner: spin left
  else if (right > 1) drive(SPEED, 0, 0)       // no wall yet: go find one
  else {
    const vy = constrain(-1.2 * (right - TARGET), -0.15, 0.15)
    const wz = constrain(300 * (range(250) - range(290)), -60, 60)
    drive(SPEED, vy, wz)
  }
  watch('right', right)
  watch('ahead', ahead)
  watch('coverage', coverage())
}
`

const BUMP_CPP = `// Bump and turn
// Robot-vacuum style: drive until the bumper (or a very close LiDAR return)
// fires, back off, turn a random angle, go again.

int state = 0;               // 0 drive, 1 back off, 2 turn
unsigned long deadline = 0;
float turnRate = 90.0;       // deg/s
int bumps = 0;

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  randomSeed(7);
}

void loop() {
  unsigned long now = millis();
  float front = readLidar(0);
  bool blocked = readBump() > 0.5 || (front > 0.02 && front < 0.25);
  if (state == 0) {
    drive(0.22, 0.0, 0.0);
    if (blocked) {
      state = 1;
      deadline = now + 600;
      bumps++;
      Serial.print("bump #");
      Serial.println(bumps);
    }
  } else if (state == 1) {
    drive(-0.12, 0.0, 0.0);
    if (now >= deadline) {
      int angle = random(60, 180);
      turnRate = random(0, 2) == 0 ? 90.0 : -90.0;
      deadline = now + (unsigned long)(angle * 1000 / 90);
      state = 2;
    }
  } else {
    drive(0.0, 0.0, turnRate);
    if (now >= deadline) state = 0;
  }
  digitalWrite(LED_BUILTIN, state == 0 ? LOW : HIGH);
}
`

const BUMP_JS = `// Bump and turn
// Robot-vacuum style: drive until the bumper (or a very close LiDAR return)
// fires, back off, turn a random angle, go again.

let bumps = 0

function setup() {
  pinMode(LED_BUILTIN, OUTPUT)
  randomSeed(7)
}

async function loop() {
  const front = readLidar(0)
  const blocked = readBump() > 0.5 || (front > 0.02 && front < 0.25)
  if (!blocked) {
    drive(0.22, 0, 0)
    digitalWrite(LED_BUILTIN, LOW)
    return
  }
  bumps++
  Serial.println('bump #' + bumps)
  digitalWrite(LED_BUILTIN, HIGH)
  drive(-0.12, 0, 0)
  await delay(600)
  const angle = random(60, 180)
  drive(0, 0, random(0, 2) === 0 ? 90 : -90)
  await delay((angle * 1000) / 90)
}
`

const SQUARE_CPP = `// Square path with drive()
// Drives a square from odometry: straight legs hold the heading and end on
// distance, 90 degree turns end on heading (readPose: x m, y m, heading deg).

const float SIDE = 0.8;      // m
bool turning = false;
float startX = 0;
float startY = 0;
float targetHeading = 0;
int legs = 0;

float wrap180(float a) {
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

void setup() {
  Serial.begin(115200);
  startX = readPose(0);
  startY = readPose(1);
  targetHeading = readPose(2);
}

void loop() {
  float x = readPose(0);
  float y = readPose(1);
  float err = wrap180(targetHeading - readPose(2));
  if (!turning) {
    float dx = x - startX;
    float dy = y - startY;
    drive(0.25, 0.0, constrain(3.0 * err, -40.0, 40.0));
    if (sqrt(dx * dx + dy * dy) >= SIDE) {
      turning = true;
      targetHeading = wrap180(targetHeading + 90);
    }
  } else {
    drive(0.0, 0.0, constrain(2.5 * err, -90.0, 90.0));
    if (fabs(err) < 1.5) {
      turning = false;
      startX = x;
      startY = y;
      legs++;
      Serial.print("corner ");
      Serial.print(legs);
      Serial.print(" at ");
      Serial.print(x, 2);
      Serial.print(", ");
      Serial.println(y, 2);
    }
  }
}
`

const SQUARE_JS = `// Square path with drive()
// Drives a square from odometry: straight legs hold the heading and end on
// distance, 90 degree turns end on heading (readPose: x m, y m, heading deg).

const SIDE = 0.8   // m
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180

async function driveLeg(heading) {
  const x0 = readPose(0)
  const y0 = readPose(1)
  while (Math.hypot(readPose(0) - x0, readPose(1) - y0) < SIDE) {
    drive(0.25, 0, constrain(3 * wrap180(heading - readPose(2)), -40, 40))
    await delay(10)
  }
}

async function turnTo(heading) {
  let err = wrap180(heading - readPose(2))
  while (Math.abs(err) >= 1.5) {
    drive(0, 0, constrain(2.5 * err, -90, 90))
    await delay(10)
    err = wrap180(heading - readPose(2))
  }
}

let heading = 0

function setup() {
  heading = readPose(2)
}

async function loop() {
  await driveLeg(heading)
  heading = wrap180(heading + 90)
  await turnTo(heading)
  Serial.println('corner at ' + readPose(0).toFixed(2) + ', ' + readPose(1).toFixed(2))
}
`

export const SWEEPER_EXAMPLES: Example[] = [
  { id: 'sweeper-wall', title: 'Wall follower with readLidar()', summary: 'Strafe and steer to hold a wall on the right.', cpp: WALL_CPP, js: WALL_JS },
  { id: 'sweeper-bump', title: 'Bump and turn', summary: 'Drive until blocked, back off, turn a random angle.', cpp: BUMP_CPP, js: BUMP_JS },
  { id: 'sweeper-square', title: 'Square path with drive()', summary: 'Closed-loop square from odometry.', cpp: SQUARE_CPP, js: SQUARE_JS },
]
