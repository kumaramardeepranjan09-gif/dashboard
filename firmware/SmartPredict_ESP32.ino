// =============================================================================
// SmartPredict_ESP32.ino
// Predictive Maintenance System — 3 Motors, 3 MPU6050, 3 LM35, 3 Relays
// =============================================================================
// IMPORTANT: All thresholds are labeled UNCALIBRATED.
// You MUST calibrate thresholds for your specific hardware before deployment.
// Motor protection runs locally even if Wi-Fi or dashboard is unavailable.
// Do NOT modify GPIO assignments without reviewing the README wiring guide.
// =============================================================================

#include <Arduino.h>
#include <Wire.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <math.h>
#include <Preferences.h>

// =============================================================================
// ─── USER CONFIGURATION ──────────────────────────────────────────────────────
// =============================================================================

// --- Wi-Fi ---
const char* WIFI_SSID     = "YOUR_WIFI_SSID";      // <-- Change this
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";  // <-- Change this

// --- Web Server ---
const uint16_t HTTP_PORT = 80;
// Active buzzer driven through a transistor (see README), HIGH = sound.
const uint8_t BUZZER_PIN = 23;
const bool BUZZER_ENABLED = true;
const double SERVICE_LIFE_HOURS = 200.0;

// --- Relay Polarity ---
// Set to true if your relay module activates on LOW signal (most common)
// Set to false if your relay module activates on HIGH signal
const bool RELAY_ACTIVE_LOW = true;

// --- Sampling ---
const uint16_t SAMPLE_INTERVAL_MS    = 2000;  // Main loop interval
const uint16_t VIBRATION_SAMPLES     = 100;   // Samples for RMS/peak calc
const uint16_t WIFI_RECONNECT_MS     = 30000; // Wi-Fi retry interval

// =============================================================================
// ─── THRESHOLDS (UNCALIBRATED — must be verified for your hardware) ───────────
// =============================================================================
// These are example values only. DO NOT use for real protection until calibrated.

struct MotorThresholds {
  float tempWarning;        // °C
  float tempCritical;       // °C
  float vibRmsWarning;      // g
  float vibRmsCritical;     // g
  float vibPeakWarning;     // g
  float vibPeakCritical;    // g
  float tempHysteresis;     // °C — return to normal band
  float vibHysteresis;      // g  — return to normal band
  uint16_t warningPersistMs;  // ms — how long warning must persist before alert
  uint16_t criticalPersistMs; // ms — how long critical must persist before shutdown
};

MotorThresholds THRESHOLDS[3] = {
  // Motor 1 — UNCALIBRATED
  { 60.0f, 80.0f, 0.5f, 1.5f, 1.0f, 3.0f, 3.0f, 0.1f, 3000, 1000 },
  // Motor 2 — UNCALIBRATED
  { 60.0f, 80.0f, 0.5f, 1.5f, 1.0f, 3.0f, 3.0f, 0.1f, 3000, 1000 },
  // Motor 3 — UNCALIBRATED
  { 60.0f, 80.0f, 0.5f, 1.5f, 1.0f, 3.0f, 3.0f, 0.1f, 3000, 1000 },
};

// LM35 calibration offsets (°C) — UNCALIBRATED
const float LM35_OFFSET[3] = { 0.0f, 0.0f, 0.0f };

// =============================================================================
// ─── GPIO MAPPING (DO NOT CHANGE) ─────────────────────────────────────────────
// =============================================================================

// I2C Bus 1 — Motor 1 (addr 0x68) and Motor 2 (addr 0x69)
const uint8_t I2C1_SDA = 21;
const uint8_t I2C1_SCL = 22;

// I2C Bus 2 — Motor 3 (addr 0x68)
const uint8_t I2C2_SDA = 16;
const uint8_t I2C2_SCL = 17;

// LM35 ADC pins
const uint8_t LM35_PIN[3] = { 34, 35, 32 };

// Relay pins
const uint8_t RELAY_PIN[3] = { 25, 26, 27 };

// MPU6050 addresses
const uint8_t MPU_ADDR[3] = { 0x68, 0x69, 0x68 };

// =============================================================================
// ─── MPU6050 REGISTER DEFINITIONS ─────────────────────────────────────────────
// =============================================================================
#define MPU6050_REG_PWR_MGMT_1   0x6B
#define MPU6050_REG_ACCEL_CONFIG 0x1C
#define MPU6050_REG_ACCEL_XOUT_H 0x3B
#define MPU6050_REG_WHO_AM_I     0x75
#define MPU6050_ACCEL_SCALE_2G   16384.0f  // LSB/g at ±2g range

// =============================================================================
// ─── DATA STRUCTURES ──────────────────────────────────────────────────────────
// =============================================================================

enum MotorState {
  STATE_NORMAL      = 0,
  STATE_WARNING     = 1,
  STATE_CRITICAL    = 2,
  STATE_SENSOR_FAULT = 3,
  STATE_LATCHED_OFF = 4
};

struct SensorReading {
  float temperature;      // °C
  float vibRms;           // g
  float vibPeak;          // g
  float accelX;           // g
  float accelY;           // g
  float accelZ;           // g
  bool  tempOk;           // sensor valid
  bool  vibOk;            // sensor valid
  unsigned long timestamp; // millis()
};

struct MotorStatus {
  uint8_t      id;
  MotorState   state;
  MotorState   prevState;
  SensorReading reading;
  bool         relayOn;       // true = motor powered
  bool         latchedOff;    // requires manual reset
  bool         faultAck;      // acknowledged by operator
  float        healthScore;   // 0–100
  String       faultReason;
  String       faultEvidence;
  unsigned long stateEnteredMs;
  unsigned long warningStartMs;
  unsigned long criticalStartMs;
  uint32_t     incidentCount;
};

// =============================================================================
// ─── GLOBALS ──────────────────────────────────────────────────────────────────
// =============================================================================

TwoWire I2C1 = TwoWire(0);
TwoWire I2C2 = TwoWire(1);

MotorStatus motors[3];
WebServer   server(HTTP_PORT);

unsigned long lastSampleMs    = 0;
unsigned long lastWifiRetryMs = 0;
bool          wifiConnected   = false;

Preferences runtimeStore;
uint64_t runtimeMs[3] = {0,0,0};
uint32_t runtimeTick = 0;
uint32_t runtimeSavedAt = 0;
bool runtimePersistenceReady = false;
void accountRuntime() {
  const uint32_t now = millis();
  const uint32_t elapsed = now - runtimeTick;
  runtimeTick = now;
  for (uint8_t i=0;i<3;i++) if (motors[i].relayOn) runtimeMs[i] += elapsed;
}
void saveRuntime() {
  if (!runtimePersistenceReady) return;
  for (uint8_t i=0;i<3;i++) { char key[8]; snprintf(key,sizeof(key),"motor%u",i+1); runtimeStore.putULong64(key,runtimeMs[i]); }
  runtimeSavedAt = millis();
}
void updateBuzzer() {
  bool fault = false;
  for (uint8_t i=0;i<3;i++) fault |= motors[i].state == STATE_CRITICAL || motors[i].state == STATE_SENSOR_FAULT || motors[i].state == STATE_LATCHED_OFF;
  digitalWrite(BUZZER_PIN, BUZZER_ENABLED && fault ? HIGH : LOW);
}

// =============================================================================
// ─── RELAY HELPERS ────────────────────────────────────────────────────────────
// =============================================================================

void setRelay(uint8_t motorIdx, bool activate) {
  if (motorIdx > 2) return;
  accountRuntime();
  bool wasRunning = motors[motorIdx].relayOn;
  bool pinLevel = RELAY_ACTIVE_LOW ? !activate : activate;
  digitalWrite(RELAY_PIN[motorIdx], pinLevel ? HIGH : LOW);
  motors[motorIdx].relayOn = activate;
  if (wasRunning && !activate) saveRuntime();
  Serial.printf("[RELAY] Motor %d relay %s\n", motorIdx + 1, activate ? "ON" : "OFF");
}

// =============================================================================
// ─── MPU6050 I2C HELPERS ──────────────────────────────────────────────────────
// =============================================================================

TwoWire& getBus(uint8_t motorIdx) {
  return (motorIdx < 2) ? I2C1 : I2C2;
}

bool mpu6050Write(uint8_t motorIdx, uint8_t reg, uint8_t value) {
  TwoWire& bus = getBus(motorIdx);
  bus.beginTransmission(MPU_ADDR[motorIdx]);
  bus.write(reg);
  bus.write(value);
  return (bus.endTransmission() == 0);
}

bool mpu6050Read(uint8_t motorIdx, uint8_t reg, uint8_t* buf, uint8_t len) {
  TwoWire& bus = getBus(motorIdx);
  bus.beginTransmission(MPU_ADDR[motorIdx]);
  bus.write(reg);
  if (bus.endTransmission(false) != 0) return false;
  bus.requestFrom((uint8_t)MPU_ADDR[motorIdx], len);
  if (bus.available() < len) return false;
  for (uint8_t i = 0; i < len; i++) buf[i] = bus.read();
  return true;
}

bool mpu6050Init(uint8_t motorIdx) {
  // Check WHO_AM_I
  uint8_t whoAmI = 0;
  if (!mpu6050Read(motorIdx, MPU6050_REG_WHO_AM_I, &whoAmI, 1)) {
    Serial.printf("[MPU6050] Motor %d: I2C read failed\n", motorIdx + 1);
    return false;
  }
  if (whoAmI != 0x68 && whoAmI != 0x72) {
    Serial.printf("[MPU6050] Motor %d: unexpected WHO_AM_I=0x%02X\n", motorIdx + 1, whoAmI);
    return false;
  }
  // Wake up
  if (!mpu6050Write(motorIdx, MPU6050_REG_PWR_MGMT_1, 0x00)) return false;
  // ±2g range
  if (!mpu6050Write(motorIdx, MPU6050_REG_ACCEL_CONFIG, 0x00)) return false;
  delay(100);
  Serial.printf("[MPU6050] Motor %d: initialized OK (addr=0x%02X)\n", motorIdx + 1, MPU_ADDR[motorIdx]);
  return true;
}

bool mpu6050ReadAccel(uint8_t motorIdx, float& ax, float& ay, float& az) {
  uint8_t buf[6];
  if (!mpu6050Read(motorIdx, MPU6050_REG_ACCEL_XOUT_H, buf, 6)) return false;
  int16_t rawX = (int16_t)((buf[0] << 8) | buf[1]);
  int16_t rawY = (int16_t)((buf[2] << 8) | buf[3]);
  int16_t rawZ = (int16_t)((buf[4] << 8) | buf[5]);
  ax = rawX / MPU6050_ACCEL_SCALE_2G;
  ay = rawY / MPU6050_ACCEL_SCALE_2G;
  az = rawZ / MPU6050_ACCEL_SCALE_2G;
  // Basic sanity check
  if (isnan(ax) || isnan(ay) || isnan(az)) return false;
  if (fabsf(ax) > 4.0f || fabsf(ay) > 4.0f || fabsf(az) > 4.0f) return false;
  return true;
}

// =============================================================================
// ─── LM35 TEMPERATURE READING ─────────────────────────────────────────────────
// =============================================================================
// LM35: 10 mV/°C, Vref = 3.3V, 12-bit ADC (0–4095)
// Temp(°C) = (ADC * 3300 / 4095) / 10

bool readLM35(uint8_t motorIdx, float& tempC) {
  if (motorIdx > 2) return false;
  uint32_t adcSum = 0;
  const uint8_t OVERSAMPLES = 8;
  for (uint8_t i = 0; i < OVERSAMPLES; i++) {
    adcSum += analogRead(LM35_PIN[motorIdx]);
    delayMicroseconds(100);
  }
  float adcAvg = adcSum / (float)OVERSAMPLES;
  float millivolts = (adcAvg / 4095.0f) * 3300.0f;
  tempC = (millivolts / 10.0f) + LM35_OFFSET[motorIdx];
  // Sanity: LM35 operating range -55°C to 150°C; flag obvious faults
  if (tempC < -10.0f || tempC > 150.0f) return false;
  return true;
}

// =============================================================================
// ─── VIBRATION RMS/PEAK CALCULATION ───────────────────────────────────────────
// =============================================================================

void measureVibration(uint8_t motorIdx, float& rms, float& peak, float& ax, float& ay, float& az) {
  float sumSq = 0.0f;
  peak = 0.0f;
  uint16_t valid = 0;
  float lastAx = 0, lastAy = 0, lastAz = 0;

  for (uint16_t i = 0; i < VIBRATION_SAMPLES; i++) {
    float lax, lay, laz;
    if (mpu6050ReadAccel(motorIdx, lax, lay, laz)) {
      // Remove gravity component: dynamic acceleration magnitude
      float mag = sqrtf(lax * lax + lay * lay + laz * laz) - 1.0f; // subtract 1g
      if (mag < 0) mag = -mag; // rectify
      sumSq += mag * mag;
      if (mag > peak) peak = mag;
      lastAx = lax; lastAy = lay; lastAz = laz;
      valid++;
    }
    delayMicroseconds(500);
  }

  if (valid > 0) {
    rms = sqrtf(sumSq / valid);
    ax = lastAx; ay = lastAy; az = lastAz;
  } else {
    rms = -1.0f; peak = -1.0f;
    ax = 0; ay = 0; az = 0;
  }
}

// =============================================================================
// ─── HEALTH SCORE CALCULATION ─────────────────────────────────────────────────
// =============================================================================

float calcHealthScore(uint8_t motorIdx, const SensorReading& r) {
  if (!r.tempOk || !r.vibOk) return 0.0f;
  const MotorThresholds& th = THRESHOLDS[motorIdx];

  // Temperature score (0–50 points)
  float tempScore = 50.0f;
  if (r.temperature >= th.tempCritical) tempScore = 0.0f;
  else if (r.temperature >= th.tempWarning) {
    tempScore = 50.0f * (1.0f - (r.temperature - th.tempWarning) /
                (th.tempCritical - th.tempWarning)) * 0.5f;
  }

  // Vibration score (0–50 points)
  float vibScore = 50.0f;
  if (r.vibRms >= th.vibRmsCritical) vibScore = 0.0f;
  else if (r.vibRms >= th.vibRmsWarning) {
    vibScore = 50.0f * (1.0f - (r.vibRms - th.vibRmsWarning) /
               (th.vibRmsCritical - th.vibRmsWarning)) * 0.5f;
  }

  return constrain(tempScore + vibScore, 0.0f, 100.0f);
}

// =============================================================================
// ─── FAULT REASON GENERATOR ───────────────────────────────────────────────────
// =============================================================================

String buildFaultReason(uint8_t motorIdx, const SensorReading& r, MotorState state) {
  const MotorThresholds& th = THRESHOLDS[motorIdx];
  String reason = "";
  if (state == STATE_SENSOR_FAULT) {
    if (!r.tempOk && !r.vibOk) reason = "Both temperature and vibration sensors are reporting invalid or out-of-range readings.";
    else if (!r.tempOk) reason = "Temperature sensor (LM35) is reporting an invalid or out-of-range reading.";
    else reason = "Vibration sensor (MPU6050) is reporting an invalid or out-of-range reading.";
    return reason;
  }
  bool highTemp = r.tempOk && r.temperature >= th.tempWarning;
  bool highVib  = r.vibOk  && r.vibRms >= th.vibRmsWarning;
  bool highPeak = r.vibOk  && r.vibPeak >= th.vibPeakWarning;

  if (highTemp && highVib) {
    reason = "Simultaneous elevated temperature (" + String(r.temperature, 1) +
             "°C) and elevated vibration RMS (" + String(r.vibRms, 3) + " g). ";
    reason += "Possible causes: mechanical overload, bearing degradation, imbalance with friction.";
  } else if (highTemp) {
    reason = "Elevated temperature (" + String(r.temperature, 1) + "°C) exceeds " +
             String(state == STATE_CRITICAL ? "critical" : "warning") + " threshold (" +
             String(state == STATE_CRITICAL ? th.tempCritical : th.tempWarning, 1) + "°C). ";
    reason += "Possible causes: excessive load, insufficient cooling, high ambient temperature, friction in bearings or shaft.";
  } else if (highVib || highPeak) {
    reason = "Elevated vibration ";
    if (highVib) reason += "RMS=" + String(r.vibRms, 3) + " g ";
    if (highPeak) reason += "Peak=" + String(r.vibPeak, 3) + " g ";
    reason += "exceeds " + String(state == STATE_CRITICAL ? "critical" : "warning") + " threshold. ";
    reason += "Possible causes: loose mounting, mechanical imbalance, shaft misalignment, bearing wear, resonance.";
  }
  return reason;
}

String buildFaultEvidence(uint8_t motorIdx, const SensorReading& r) {
  String ev = "Measured: Temp=" + String(r.temperature, 1) + "°C, ";
  ev += "VibRMS=" + String(r.vibRms, 3) + "g, ";
  ev += "VibPeak=" + String(r.vibPeak, 3) + "g. ";
  const MotorThresholds& th = THRESHOLDS[motorIdx];
  ev += "Active thresholds (UNCALIBRATED): TempWarn=" + String(th.tempWarning, 1) +
        "°C, TempCrit=" + String(th.tempCritical, 1) +
        "°C, VibRMSWarn=" + String(th.vibRmsWarning, 3) +
        "g, VibRMSCrit=" + String(th.vibRmsCritical, 3) + "g.";
  return ev;
}

// =============================================================================
// ─── STATE MACHINE ────────────────────────────────────────────────────────────
// =============================================================================

void updateMotorState(uint8_t motorIdx) {
  MotorStatus& m = motors[motorIdx];
  SensorReading& r = m.reading;
  const MotorThresholds& th = THRESHOLDS[motorIdx];

  // If latched off, do not change state automatically
  if (m.latchedOff) return;

  // --- Determine new state ---
  MotorState newState = STATE_NORMAL;

  if (!r.tempOk || !r.vibOk) {
    newState = STATE_SENSOR_FAULT;
  } else {
    bool critTemp = r.temperature >= th.tempCritical;
    bool critVib  = r.vibRms >= th.vibRmsCritical || r.vibPeak >= th.vibPeakCritical;
    bool warnTemp = r.temperature >= th.tempWarning;
    bool warnVib  = r.vibRms >= th.vibRmsWarning || r.vibPeak >= th.vibPeakWarning;

    if (critTemp || critVib) {
      // Check persistence
      if (m.criticalStartMs == 0) {
        m.criticalStartMs = millis();
        newState = (m.state == STATE_WARNING) ? STATE_WARNING : STATE_NORMAL;
      } else if ((millis() - m.criticalStartMs) >= th.criticalPersistMs) {
        newState = STATE_CRITICAL;
      } else {
        newState = m.state; // keep existing while accumulating
      }
    } else {
      m.criticalStartMs = 0;
      if (warnTemp || warnVib) {
        if (m.warningStartMs == 0) m.warningStartMs = millis();
        if ((millis() - m.warningStartMs) >= th.warningPersistMs) {
          newState = STATE_WARNING;
        } else {
          newState = m.state;
        }
      } else {
        m.warningStartMs = 0;
        // Hysteresis: only return to normal if below thresholds by hysteresis margin
        if (m.state == STATE_WARNING) {
          bool clearTemp = !r.tempOk || r.temperature < (th.tempWarning - th.tempHysteresis);
          bool clearVib  = !r.vibOk  || (r.vibRms < (th.vibRmsWarning - th.vibHysteresis) &&
                                          r.vibPeak < (th.vibPeakWarning - th.vibHysteresis));
          newState = (clearTemp && clearVib) ? STATE_NORMAL : STATE_WARNING;
        } else {
          newState = STATE_NORMAL;
        }
      }
    }
  }

  // --- Apply state transitions ---
  if (newState != m.state) {
    m.prevState = m.state;
    m.state = newState;
    m.stateEnteredMs = millis();

    Serial.printf("[STATE] Motor %d: %d -> %d\n", motorIdx + 1, (int)m.prevState, (int)newState);

    if (newState == STATE_CRITICAL) {
      // SHUTDOWN motor immediately
      setRelay(motorIdx, false);
      m.latchedOff = true;
      m.incidentCount++;
      m.faultReason   = buildFaultReason(motorIdx, r, newState);
      m.faultEvidence = buildFaultEvidence(motorIdx, r);
      Serial.printf("[CRITICAL] Motor %d SHUTDOWN. Reason: %s\n", motorIdx + 1, m.faultReason.c_str());
    } else if (newState == STATE_WARNING) {
      m.faultReason   = buildFaultReason(motorIdx, r, newState);
      m.faultEvidence = buildFaultEvidence(motorIdx, r);
    } else if (newState == STATE_SENSOR_FAULT) {
      m.faultReason = buildFaultReason(motorIdx, r, newState);
    }
  }

  // Update health score
  m.healthScore = calcHealthScore(motorIdx, r);
}

// =============================================================================
// ─── SENSOR SAMPLING ──────────────────────────────────────────────────────────
// =============================================================================

void sampleMotor(uint8_t motorIdx) {
  SensorReading& r = motors[motorIdx].reading;
  r.timestamp = millis();

  // Temperature
  r.tempOk = readLM35(motorIdx, r.temperature);
  if (!r.tempOk) {
    r.temperature = -999.0f;
    Serial.printf("[LM35] Motor %d: read FAILED\n", motorIdx + 1);
  }

  // Vibration
  float rms, peak, ax, ay, az;
  measureVibration(motorIdx, rms, peak, ax, ay, az);
  r.vibOk  = (rms >= 0.0f);
  r.vibRms = r.vibOk ? rms  : -1.0f;
  r.vibPeak = r.vibOk ? peak : -1.0f;
  r.accelX  = ax; r.accelY = ay; r.accelZ = az;

  if (!r.vibOk) {
    Serial.printf("[MPU6050] Motor %d: read FAILED\n", motorIdx + 1);
  }

  Serial.printf("[SAMPLE] Motor %d: Temp=%.1f°C(%s) VibRMS=%.3fg VibPeak=%.3fg Health=%.0f State=%d\n",
                motorIdx + 1,
                r.temperature, r.tempOk ? "OK" : "FAULT",
                r.vibRms, r.vibPeak,
                motors[motorIdx].healthScore,
                (int)motors[motorIdx].state);
}

// =============================================================================
// ─── HTTP API — JSON ENDPOINT ──────────────────────────────────────────────────
// =============================================================================

void addCORSHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type");
  server.sendHeader("Cache-Control", "no-cache");
}

String stateToString(MotorState s) {
  switch (s) {
    case STATE_NORMAL:       return "NORMAL";
    case STATE_WARNING:      return "WARNING";
    case STATE_CRITICAL:     return "CRITICAL";
    case STATE_SENSOR_FAULT: return "SENSOR_FAULT";
    case STATE_LATCHED_OFF:  return "LATCHED_OFF";
    default:                 return "UNKNOWN";
  }
}

void handleGetStatus() {
  addCORSHeaders();
  accountRuntime();

  StaticJsonDocument<6144> doc;
  doc["firmware"] = "SmartPredict v1.0";
  doc["uptime_ms"] = millis();
  doc["wifi_connected"] = wifiConnected;
  doc["free_heap"] = ESP.getFreeHeap();

  JsonArray arr = doc.createNestedArray("motors");
  for (uint8_t i = 0; i < 3; i++) {
    JsonObject m = arr.createNestedObject();
    MotorStatus& ms = motors[i];
    m["id"]          = i + 1;
    m["runtime_hours"] = (double)runtimeMs[i] / 3600000.0;
    m["service_life_hours"] = SERVICE_LIFE_HOURS;
    m["remaining_hours"] = max(0.0, SERVICE_LIFE_HOURS - (double)runtimeMs[i] / 3600000.0);
    m["runtime_persistent"] = runtimePersistenceReady;
    m["state"]       = stateToString(ms.state);
    m["relay_on"]    = ms.relayOn;
    m["latched_off"] = ms.latchedOff;
    m["health"]      = (int)ms.healthScore;
    m["fault_ack"]   = ms.faultAck;
    m["incidents"]   = ms.incidentCount;
    m["fault_reason"]   = ms.faultReason;
    m["fault_evidence"] = ms.faultEvidence;
    m["state_ms"]    = millis() - ms.stateEnteredMs;

    JsonObject sens = m.createNestedObject("sensors");
    sens["temp_ok"]   = ms.reading.tempOk;
    sens["temp_c"]    = ms.reading.tempOk ? ms.reading.temperature : (float)-999.0;
    sens["vib_ok"]    = ms.reading.vibOk;
    sens["vib_rms"]   = ms.reading.vibOk ? ms.reading.vibRms : (float)-1.0;
    sens["vib_peak"]  = ms.reading.vibOk ? ms.reading.vibPeak : (float)-1.0;
    sens["accel_x"]   = ms.reading.accelX;
    sens["accel_y"]   = ms.reading.accelY;
    sens["accel_z"]   = ms.reading.accelZ;
    sens["timestamp"] = ms.reading.timestamp;

    JsonObject th = m.createNestedObject("thresholds");
    th["temp_warn"]     = THRESHOLDS[i].tempWarning;
    th["temp_crit"]     = THRESHOLDS[i].tempCritical;
    th["vib_rms_warn"]  = THRESHOLDS[i].vibRmsWarning;
    th["vib_rms_crit"]  = THRESHOLDS[i].vibRmsCritical;
    th["vib_peak_warn"] = THRESHOLDS[i].vibPeakWarning;
    th["vib_peak_crit"] = THRESHOLDS[i].vibPeakCritical;
    th["calibrated"]    = false; // Always false until user verifies
  }

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleResetMotor() {
  addCORSHeaders();
  if (!server.hasArg("motor")) {
    server.send(400, "application/json", "{\"error\":\"missing motor parameter\"}");
    return;
  }
  int motorIdx = server.arg("motor").toInt() - 1;
  if (motorIdx < 0 || motorIdx > 2) {
    server.send(400, "application/json", "{\"error\":\"invalid motor index (1-3)\"}");
    return;
  }
  MotorStatus& m = motors[motorIdx];

  // Safety check: only reset if sensor readings are now within normal range
  bool tempSafe = m.reading.tempOk && m.reading.temperature < (THRESHOLDS[motorIdx].tempWarning - THRESHOLDS[motorIdx].tempHysteresis);
  bool vibSafe  = m.reading.vibOk  && m.reading.vibRms < (THRESHOLDS[motorIdx].vibRmsWarning - THRESHOLDS[motorIdx].vibHysteresis);

  if (!tempSafe || !vibSafe) {
    String msg = "{\"error\":\"Reset denied. Conditions not safe: ";
    if (!tempSafe) msg += "Temp=" + String(m.reading.temperature, 1) + "°C ";
    if (!vibSafe)  msg += "VibRMS=" + String(m.reading.vibRms, 3) + "g";
    msg += "\"}";
    server.send(409, "application/json", msg);
    Serial.printf("[RESET] Motor %d reset DENIED — conditions not safe\n", motorIdx + 1);
    return;
  }

  m.latchedOff = false;
  m.state      = STATE_NORMAL;
  m.prevState  = STATE_LATCHED_OFF;
  m.faultAck   = false;
  m.faultReason   = "";
  m.faultEvidence = "";
  m.warningStartMs  = 0;
  m.criticalStartMs = 0;
  setRelay(motorIdx, true); // re-energize

  Serial.printf("[RESET] Motor %d reset by dashboard\n", motorIdx + 1);
  server.send(200, "application/json", "{\"ok\":true,\"motor\":" + String(motorIdx + 1) + "}");
}

void handleAckMotor() {
  addCORSHeaders();
  if (!server.hasArg("motor")) {
    server.send(400, "application/json", "{\"error\":\"missing motor parameter\"}");
    return;
  }
  int motorIdx = server.arg("motor").toInt() - 1;
  if (motorIdx < 0 || motorIdx > 2) {
    server.send(400, "application/json", "{\"error\":\"invalid motor (1-3)\"}");
    return;
  }
  motors[motorIdx].faultAck = true;
  Serial.printf("[ACK] Motor %d fault acknowledged\n", motorIdx + 1);
  server.send(200, "application/json", "{\"ok\":true}");
}

void handleDiagnostics() {
  addCORSHeaders();
  StaticJsonDocument<1024> doc;
  doc["chip_model"]  = ESP.getChipModel();
  doc["chip_rev"]    = ESP.getChipRevision();
  doc["cpu_freq_mhz"] = ESP.getCpuFreqMHz();
  doc["flash_size"]  = ESP.getFlashChipSize();
  doc["free_heap"]   = ESP.getFreeHeap();
  doc["uptime_ms"]   = millis();
  doc["wifi_ssid"]   = wifiConnected ? WiFi.SSID() : "";
  doc["wifi_rssi"]   = wifiConnected ? WiFi.RSSI() : 0;
  doc["ip_address"]  = wifiConnected ? WiFi.localIP().toString() : "";

  JsonArray buses = doc.createNestedArray("i2c_buses");
  JsonObject b1 = buses.createNestedObject();
  b1["bus"] = 1; b1["sda"] = I2C1_SDA; b1["scl"] = I2C1_SCL;
  JsonObject b2 = buses.createNestedObject();
  b2["bus"] = 2; b2["sda"] = I2C2_SDA; b2["scl"] = I2C2_SCL;

  String output;
  serializeJson(doc, output);
  server.send(200, "application/json", output);
}

void handleOptions() {
  addCORSHeaders();
  server.send(204);
}

void handleNotFound() {
  addCORSHeaders();
  server.send(404, "application/json", "{\"error\":\"not found\"}");
}

// =============================================================================
// ─── WI-FI CONNECTION ─────────────────────────────────────────────────────────
// =============================================================================

void connectWiFi() {
  Serial.printf("[WiFi] Connecting to %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && (millis() - start) < 15000) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.printf("[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());
    Serial.printf("[WiFi] Dashboard URL: http://%s/api/status\n", WiFi.localIP().toString().c_str());
  } else {
    wifiConnected = false;
    Serial.println("[WiFi] Connection FAILED. Running in local-only mode.");
    Serial.println("[WiFi] Motor protection is active regardless of Wi-Fi status.");
  }
}

// =============================================================================
// ─── SETUP ────────────────────────────────────────────────────────────────────
// =============================================================================

void setup() {
  Serial.begin(115200);
  delay(500);

  Serial.println("========================================");
  Serial.println("  SmartPredict v1.0 — Starting Up");
  Serial.println("========================================");
  Serial.println("IMPORTANT: All thresholds are UNCALIBRATED.");
  Serial.println("Verify calibration before using for real motor protection.");
  Serial.println("========================================");

  digitalWrite(BUZZER_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
  runtimePersistenceReady = runtimeStore.begin("motor-runtime", false);
  for (uint8_t i=0;i<3;i++) { char key[8]; snprintf(key,sizeof(key),"motor%u",i+1); runtimeMs[i] = runtimePersistenceReady ? runtimeStore.getULong64(key,0) : 0; }
  runtimeTick = millis();
  // --- Relay setup: safe state first (motors OFF) ---
  for (uint8_t i = 0; i < 3; i++) {
    pinMode(RELAY_PIN[i], OUTPUT);
    // Safe startup: all relays off (motors de-energized)
    digitalWrite(RELAY_PIN[i], RELAY_ACTIVE_LOW ? HIGH : LOW);
    Serial.printf("[RELAY] Motor %d relay pin %d set to SAFE (OFF) state\n", i + 1, RELAY_PIN[i]);
  }

  // --- ADC setup ---
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db); // 0–3.3V range

  // --- I2C Bus 1 ---
  I2C1.begin(I2C1_SDA, I2C1_SCL, 400000);
  Serial.printf("[I2C] Bus 1 initialized: SDA=%d SCL=%d\n", I2C1_SDA, I2C1_SCL);

  // --- I2C Bus 2 ---
  I2C2.begin(I2C2_SDA, I2C2_SCL, 400000);
  Serial.printf("[I2C] Bus 2 initialized: SDA=%d SCL=%d\n", I2C2_SDA, I2C2_SCL);

  // --- Initialize motor structures ---
  for (uint8_t i = 0; i < 3; i++) {
    motors[i].id            = i + 1;
    motors[i].state         = STATE_NORMAL;
    motors[i].prevState     = STATE_NORMAL;
    motors[i].relayOn       = false;
    motors[i].latchedOff    = false;
    motors[i].faultAck      = false;
    motors[i].healthScore   = 100.0f;
    motors[i].stateEnteredMs = millis();
    motors[i].warningStartMs = 0;
    motors[i].criticalStartMs = 0;
    motors[i].incidentCount  = 0;
    motors[i].faultReason    = "";
    motors[i].faultEvidence  = "";

    motors[i].reading.temperature = 0.0f;
    motors[i].reading.vibRms      = 0.0f;
    motors[i].reading.vibPeak     = 0.0f;
    motors[i].reading.tempOk      = false;
    motors[i].reading.vibOk       = false;
  }

  // --- Initialize MPU6050 sensors ---
  Serial.println("[MPU6050] Initializing sensors...");
  for (uint8_t i = 0; i < 3; i++) {
    bool ok = mpu6050Init(i);
    if (!ok) {
      motors[i].state = STATE_SENSOR_FAULT;
      motors[i].faultReason = "MPU6050 failed to initialize at startup.";
      Serial.printf("[MPU6050] Motor %d: INIT FAILED — sensor fault state\n", i + 1);
    }
  }

  // --- Wi-Fi ---
  connectWiFi();

  // --- HTTP server routes ---
  server.on("/api/status",      HTTP_GET,     handleGetStatus);
  server.on("/api/reset",       HTTP_GET,     handleResetMotor);
  server.on("/api/ack",         HTTP_GET,     handleAckMotor);
  server.on("/api/diagnostics", HTTP_GET,     handleDiagnostics);
  server.on("/api/status",      HTTP_OPTIONS, handleOptions);
  server.on("/api/reset",       HTTP_OPTIONS, handleOptions);
  server.on("/api/ack",         HTTP_OPTIONS, handleOptions);
  server.onNotFound(handleNotFound);

  if (wifiConnected) {
    server.begin();
    Serial.printf("[HTTP] Server started on port %d\n", HTTP_PORT);
  }

  // --- Safe startup: turn motors ON after sensor init if sensors OK ---
  // NOTE: Review this behavior for your application.
  // Some applications require manual reset before motor start.
  for (uint8_t i = 0; i < 3; i++) {
    if (motors[i].state != STATE_SENSOR_FAULT) {
      setRelay(i, true);
      Serial.printf("[STARTUP] Motor %d started\n", i + 1);
    } else {
      Serial.printf("[STARTUP] Motor %d NOT started (sensor fault)\n", i + 1);
    }
  }

  Serial.println("[READY] SmartPredict running.");
}

// =============================================================================
// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
// =============================================================================

void loop() {
  accountRuntime();
  if (millis() - runtimeSavedAt >= 60000) saveRuntime();
  const bool nowConnected = WiFi.status() == WL_CONNECTED;
  if (nowConnected && !wifiConnected) server.begin();
  wifiConnected = nowConnected;
  updateBuzzer();
  // Handle HTTP requests
  if (wifiConnected) {
    server.handleClient();
  }

  // Wi-Fi reconnect
  if (!wifiConnected && (millis() - lastWifiRetryMs > WIFI_RECONNECT_MS)) {
    lastWifiRetryMs = millis();
    Serial.println("[WiFi] Attempting reconnect...");
    if (WiFi.status() == WL_CONNECTED) {
      wifiConnected = true;
      server.begin();
      Serial.println("[WiFi] Reconnected.");
    } else {
      WiFi.reconnect();
    }
  }

  // Sensor sampling at interval
  if (millis() - lastSampleMs >= SAMPLE_INTERVAL_MS) {
    lastSampleMs = millis();
    for (uint8_t i = 0; i < 3; i++) {
      sampleMotor(i);
      updateMotorState(i);
      updateBuzzer();
    }
  }
}
// =============================================================================
// END OF FILE
// =============================================================================
