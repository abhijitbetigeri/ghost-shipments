// Smart-PhySystem rover firmware
// Arduino Uno + L298N (tank drive, 2 DC motors, no encoders) + HC-SR04.
// Serial protocol: see DECISIONS.md, "Firmware serial protocol".
//
// 115200 baud, one command per line (\n or \r\n), one reply line per command.
//   F <ms> <speed>        forward; ultrasonic polled every ~50 ms; stops on obstacle
//                         -> DONE | BLOCKED <cm>
//   B <ms> <speed>        backward, never blocked             -> DONE
//   L <deg> / R <deg>     turn in place, time based            -> DONE
//   M <left> <right> <ms> raw tank drive, -255..255            -> DONE
//   S                     stop now                             -> OK
//   D                     distance in cm (999 = no echo)       -> D <cm>
//   P                     ping / keepalive                     -> OK
//   anything else                                              -> ERR
//
// Moves are non-blocking: loop() keeps reading serial while the wheels turn.
//  - A move's DONE / BLOCKED is printed when the move ends, so a P sent
//    mid-move gets its OK *before* the move's DONE.
//  - S mid-move: the move ends and replies DONE, then S replies OK.
//  - A new move (F/B/L/R/M) mid-move: the current move replies DONE, then the
//    new move starts (and later sends its own reply).
//  - F when an obstacle is already closer than STOP_CM: BLOCKED <cm> at once,
//    no motion. B, L, R and M still work so the rover can escape.
//  - Watchdog: while a move is active, if no line arrives for WATCHDOG_MS
//    (500 ms), the motors stop and the move replies WATCHDOG instead of DONE.
//    The host sends P every 200 ms during moves.
//  - Arguments that do not parse -> ERR, and any running move continues.

#include <Arduino.h>
#include <stdlib.h>
#include <ctype.h>

// ---------------------------------------------------------------------------
// Calibration constants (edit these after the hardware tests)
// ---------------------------------------------------------------------------
const int   MAX_SPEED    = 200;    // PWM cap applied to every motor output (0..255)
const int   TURN_SPEED   = 160;    // PWM used by L / R
const float MS_PER_DEG_L = 6.0;    // ms of turning per degree, left turn
const float MS_PER_DEG_R = 6.0;    // ms of turning per degree, right turn
const int   STOP_CM      = 20;     // F stops when an obstacle is closer than this
const bool  INVERT_LEFT  = false;  // flip if the left wheel runs backwards on F
const bool  INVERT_RIGHT = false;  // flip if the right wheel runs backwards on F
const float LEFT_TRIM    = 1.0;    // PWM multiplier; lower the faster side to drive straight
const float RIGHT_TRIM   = 1.0;
const bool  USE_BRAKE    = true;   // true: L298N fast stop on stop; false: coast

const unsigned long MAX_MOVE_MS      = 3000;   // every move is clamped to this
const unsigned long WATCHDOG_MS      = 500;    // 0 disables (bench testing only!)
const unsigned long SONAR_PERIOD_MS  = 50;     // ultrasonic poll period during F
const unsigned long SONAR_TIMEOUT_US = 25000;  // pulseIn timeout (~4 m)
const long          NO_ECHO_CM       = 999;
const long          MAX_RANGE_CM     = 400;

// ---------------------------------------------------------------------------
// Pins (left motor = L298N channel A, right motor = channel B)
// ---------------------------------------------------------------------------
const uint8_t PIN_ENA  = 5;   // left PWM
const uint8_t PIN_ENB  = 6;   // right PWM
const uint8_t PIN_IN1  = 7;   // left dir
const uint8_t PIN_IN2  = 8;
const uint8_t PIN_IN3  = 9;   // right dir
const uint8_t PIN_IN4  = 10;
const uint8_t PIN_TRIG = 2;
const uint8_t PIN_ECHO = 3;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const uint8_t LINE_MAX = 40;
char    lineBuf[LINE_MAX];
uint8_t lineLen = 0;
bool    lineOverflow = false;

bool          moving = false;
bool          moveIsForward = false;
unsigned long moveStartMs = 0;
unsigned long moveDurMs = 0;
unsigned long lastPollMs = 0;
unsigned long lastLineMs = 0;

// ---------------------------------------------------------------------------
// Motors
// ---------------------------------------------------------------------------
void setMotor(uint8_t pinEn, uint8_t pinA, uint8_t pinB, int speed, bool invert, float trim) {
  if (invert) speed = -speed;
  long mag = speed < 0 ? -(long)speed : (long)speed;
  mag = (long)(mag * trim + 0.5f);
  if (mag > MAX_SPEED) mag = MAX_SPEED;
  if (mag < 0) mag = 0;

  if (mag == 0) {
    digitalWrite(pinA, LOW);
    digitalWrite(pinB, LOW);
    analogWrite(pinEn, USE_BRAKE ? 255 : 0);  // IN1==IN2 with EN high = fast stop
    return;
  }
  if (speed > 0) {
    digitalWrite(pinA, HIGH);
    digitalWrite(pinB, LOW);
  } else {
    digitalWrite(pinA, LOW);
    digitalWrite(pinB, HIGH);
  }
  analogWrite(pinEn, (int)mag);
}

void setMotors(int left, int right) {
  setMotor(PIN_ENA, PIN_IN1, PIN_IN2, left, INVERT_LEFT, LEFT_TRIM);
  setMotor(PIN_ENB, PIN_IN3, PIN_IN4, right, INVERT_RIGHT, RIGHT_TRIM);
}

void stopMotors() {
  setMotors(0, 0);
}

// ---------------------------------------------------------------------------
// Ultrasonic
// ---------------------------------------------------------------------------
long readDistanceCm() {
  digitalWrite(PIN_TRIG, LOW);
  delayMicroseconds(2);
  digitalWrite(PIN_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(PIN_TRIG, LOW);
  unsigned long us = pulseIn(PIN_ECHO, HIGH, SONAR_TIMEOUT_US);
  if (us == 0) return NO_ECHO_CM;
  long cm = (long)(us / 58UL);
  if (cm > MAX_RANGE_CM) return NO_ECHO_CM;
  return cm;
}

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------
void finishMove(const char *reply) {
  stopMotors();
  moving = false;
  if (reply != NULL) Serial.println(reply);
}

void endCurrentMove() {
  if (moving) finishMove("DONE");
}

long clampLong(long v, long lo, long hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

void startMove(int left, int right, long ms, bool forward) {
  ms = clampLong(ms, 0, (long)MAX_MOVE_MS);
  if (ms == 0) {
    stopMotors();
    Serial.println("DONE");
    return;
  }
  setMotors(left, right);
  moving = true;
  moveIsForward = forward;
  moveStartMs = millis();
  moveDurMs = (unsigned long)ms;
  lastPollMs = moveStartMs;
}

void updateMove() {
  if (!moving) return;
  unsigned long now = millis();

  if (WATCHDOG_MS > 0 && (now - lastLineMs) > WATCHDOG_MS) {
    finishMove("WATCHDOG");
    return;
  }
  if ((now - moveStartMs) >= moveDurMs) {
    finishMove("DONE");
    return;
  }
  if (moveIsForward && (now - lastPollMs) >= SONAR_PERIOD_MS) {
    lastPollMs = now;
    long cm = readDistanceCm();
    if (cm < STOP_CM) {
      stopMotors();
      moving = false;
      Serial.print("BLOCKED ");
      Serial.println(cm);
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
// Parses exactly n integers from p; anything else on the line fails.
bool parseArgs(const char *p, long *out, uint8_t n) {
  for (uint8_t i = 0; i < n; i++) {
    char *end;
    long v = strtol(p, &end, 10);
    if (end == p) return false;
    out[i] = v;
    p = end;
  }
  while (*p == ' ' || *p == '\t') p++;
  return *p == '\0';
}

void handleLine(char *s) {
  while (*s == ' ' || *s == '\t') s++;
  if (*s == '\0') return;  // blank line: no reply

  char cmd = (char)toupper((unsigned char)s[0]);
  // The command must be a single letter followed by a space or end of line.
  if (s[1] != '\0' && s[1] != ' ' && s[1] != '\t') {
    Serial.println("ERR");
    return;
  }
  const char *args = s + 1;
  long a[3];

  switch (cmd) {
    case 'P':
      if (!parseArgs(args, a, 0)) { Serial.println("ERR"); return; }
      Serial.println("OK");
      return;

    case 'S':
      if (!parseArgs(args, a, 0)) { Serial.println("ERR"); return; }
      if (moving) finishMove("DONE");
      else stopMotors();
      Serial.println("OK");
      return;

    case 'D': {
      if (!parseArgs(args, a, 0)) { Serial.println("ERR"); return; }
      long cm = readDistanceCm();
      Serial.print("D ");
      Serial.println(cm);
      return;
    }

    case 'F': {
      if (!parseArgs(args, a, 2)) { Serial.println("ERR"); return; }
      endCurrentMove();
      int spd = (int)clampLong(labs(a[1]), 0, MAX_SPEED);
      long cm = readDistanceCm();
      if (cm < STOP_CM) {
        stopMotors();
        Serial.print("BLOCKED ");
        Serial.println(cm);
        return;
      }
      startMove(spd, spd, a[0], true);
      return;
    }

    case 'B': {
      if (!parseArgs(args, a, 2)) { Serial.println("ERR"); return; }
      endCurrentMove();
      int spd = (int)clampLong(labs(a[1]), 0, MAX_SPEED);
      startMove(-spd, -spd, a[0], false);
      return;
    }

    case 'L':
    case 'R': {
      if (!parseArgs(args, a, 1)) { Serial.println("ERR"); return; }
      endCurrentMove();
      float msPerDeg = (cmd == 'L') ? MS_PER_DEG_L : MS_PER_DEG_R;
      float msf = (float)labs(a[0]) * msPerDeg;
      if (msf > (float)MAX_MOVE_MS) msf = (float)MAX_MOVE_MS;
      long ms = (long)(msf + 0.5f);
      int ts = (int)clampLong(TURN_SPEED, 0, MAX_SPEED);
      if (cmd == 'L') startMove(-ts, ts, ms, false);
      else            startMove(ts, -ts, ms, false);
      return;
    }

    case 'M': {
      if (!parseArgs(args, a, 3)) { Serial.println("ERR"); return; }
      endCurrentMove();
      int l = (int)clampLong(a[0], -255, 255);
      int r = (int)clampLong(a[1], -255, 255);
      startMove(l, r, a[2], false);  // setMotor() caps |speed| at MAX_SPEED
      return;
    }

    default:
      Serial.println("ERR");
      return;
  }
}

void readSerial() {
  while (Serial.available() > 0) {
    int ch = Serial.read();
    if (ch < 0) break;
    if (ch == '\n' || ch == '\r') {
      if (lineOverflow) {
        lastLineMs = millis();
        Serial.println("ERR");
      } else if (lineLen > 0) {
        lastLineMs = millis();
        lineBuf[lineLen] = '\0';
        handleLine(lineBuf);
      }
      lineLen = 0;
      lineOverflow = false;
    } else if (lineLen < LINE_MAX - 1) {
      lineBuf[lineLen++] = (char)ch;
    } else {
      lineOverflow = true;
    }
  }
}

// ---------------------------------------------------------------------------
void setup() {
  pinMode(PIN_ENA, OUTPUT);
  pinMode(PIN_ENB, OUTPUT);
  pinMode(PIN_IN1, OUTPUT);
  pinMode(PIN_IN2, OUTPUT);
  pinMode(PIN_IN3, OUTPUT);
  pinMode(PIN_IN4, OUTPUT);
  pinMode(PIN_TRIG, OUTPUT);
  pinMode(PIN_ECHO, INPUT);
  digitalWrite(PIN_TRIG, LOW);
  stopMotors();

  Serial.begin(115200);
  lastLineMs = millis();
  Serial.println("READY");
}

void loop() {
  readSerial();
  updateMove();
}
