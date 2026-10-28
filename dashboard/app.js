/**
 * SmartPredict Dashboard — app.js
 * Complete client-side application with 3D motor visualization,
 * localStorage persistence, and ESP32 HTTP integration.
 *
 * IMPORTANT NOTES:
 * - Data is stored in browser localStorage only (single device, single browser).
 * - localStorage does NOT provide shared, permanent, or multi-device storage.
 * - Export JSON/CSV regularly to back up your history.
 * - In DEMO mode, readings are simulated and clearly labeled.
 * - LIVE mode polls the ESP32 HTTP endpoint directly.
 */

'use strict';

// ============================================================
// ─── CONFIGURATION ─────────────────────────────────────────
// ============================================================
const CONFIG_KEY = 'smartpredict_config';
const INCIDENTS_KEY = 'smartpredict_incidents_v2';
const READINGS_KEY  = 'smartpredict_readings_v2';
const ALERTS_KEY    = 'smartpredict_alerts_v2';

const DEFAULT_CONFIG = {
  esp32Url: 'http://192.168.1.100',     // Change to your ESP32 IP
  refreshInterval: 3000,                // ms
  chartRange: 20,                       // number of data points
  dataRetentionDays: 30,
  demoMode: true,                       // Start in demo mode until real device found
  thresholds: [
    { tempWarn: 60, tempCrit: 80, vibRmsWarn: 0.5, vibRmsCrit: 1.5, vibPeakWarn: 1.0, vibPeakCrit: 3.0 },
    { tempWarn: 60, tempCrit: 80, vibRmsWarn: 0.5, vibRmsCrit: 1.5, vibPeakWarn: 1.0, vibPeakCrit: 3.0 },
    { tempWarn: 60, tempCrit: 80, vibRmsWarn: 0.5, vibRmsCrit: 1.5, vibPeakWarn: 1.0, vibPeakCrit: 3.0 },
  ]
};

// ============================================================
// ─── APP STATE ──────────────────────────────────────────────
// ============================================================
let config = loadConfig();
let motorData = [null, null, null];
let incidents = loadIncidents();
let alerts = loadAlerts();
let readings = loadReadings();
let currentPage = 'overview';
let selectedMotor = 0;
let deviceOnline = false;
let lastSeenTime = null;
let pollInterval = null;
let demoTimers = [];
let alertBadgeCounts = { warn: 0, crit: 0 };

// Expose state globally on window for inline handlers & diagnostics
window.motorData = motorData;
window.config = config;
window.selectedMotor = selectedMotor;

// Demo simulation state
const demoState = [
  { temp: 32, vibRms: 0.12, vibPeak: 0.25, state: 'NORMAL', relay: true, health: 95, demoPhase: 0 },
  { temp: 28, vibRms: 0.09, vibPeak: 0.18, state: 'NORMAL', relay: true, health: 98, demoPhase: 1 },
  { temp: 41, vibRms: 0.20, vibPeak: 0.45, state: 'NORMAL', relay: true, health: 88, demoPhase: 2 },
];

// ============================================================
// ─── LOCALSTORAGE HELPERS ───────────────────────────────────
// ============================================================
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) throw Error("Invalid config");
    // Merge with defaults to handle schema updates
    return {
      ...DEFAULT_CONFIG,
      ...saved,
      demoMode: typeof saved.demoMode === 'boolean' ? saved.demoMode : true,
      esp32Url: typeof saved.esp32Url === 'string' ? saved.esp32Url : DEFAULT_CONFIG.esp32Url,
      thresholds: [0,1,2].map(i => ({...DEFAULT_CONFIG.thresholds[i], ...(saved.thresholds?.[i] || {})}))
    };
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig() {
  safeStore(CONFIG_KEY, JSON.stringify(config));
}

function loadIncidents() {
  try {
    const raw = localStorage.getItem(INCIDENTS_KEY + (config.demoMode ? '_demo' : '_hardware'));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(x => x && typeof x === "object") : [];
  } catch { return []; }
}

function saveIncidents() {
  safeStore(INCIDENTS_KEY + (config.demoMode ? '_demo' : '_hardware'), JSON.stringify(incidents));
}

function loadAlerts() {
  try {
    const raw = localStorage.getItem(ALERTS_KEY + (config.demoMode ? '_demo' : '_hardware'));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(x => x && typeof x === "object") : [];
  } catch { return []; }
}

function saveAlerts() {
  safeStore(ALERTS_KEY + (config.demoMode ? '_demo' : '_hardware'), JSON.stringify(alerts));
}

function loadReadings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(READINGS_KEY + (config.demoMode ? '_demo' : '_hardware')) || '{}');
    return Object.fromEntries([0,1,2].map(i => [i, Array.isArray(parsed?.[i]) ? parsed[i].filter(r => r && Number.isFinite(r.ts)).slice(-500) : []]));
  } catch { return {0:[],1:[],2:[]}; }
}

function saveReadings() {
  // Prune high-frequency readings older than retention window
  // But NEVER prune fault incidents
  const retentionMs = config.dataRetentionDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  const MAX_READINGS_PER_MOTOR = 500;
  for (let i = 0; i < 3; i++) {
    if (!readings[i]) readings[i] = [];
    // Keep only recent readings within retention
    readings[i] = readings[i].filter(r => r.ts > cutoff);
    // Also cap to max count
    if (readings[i].length > MAX_READINGS_PER_MOTOR) {
      readings[i] = readings[i].slice(readings[i].length - MAX_READINGS_PER_MOTOR);
    }
  }
  safeStore(READINGS_KEY + (config.demoMode ? '_demo' : '_hardware'), JSON.stringify(readings));
}

function generateId() {
  return 'INC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
}

// ============================================================
// ─── INCIDENT MANAGEMENT ────────────────────────────────────
// ============================================================
const INCIDENT_STATES = {};  // Track open incidents per motor: motorIdx -> incidentId

function openOrUpdateIncident(motorIdx, severity, reading, thresholds, faultReason, faultEvidence) {
  // Check for existing open incident for this motor + severity
  const existing = incidents.find(
    inc => inc.motorId === motorIdx + 1 && inc.severity === severity && !inc.endTime && !inc.resolved
  );

  if (existing) {
    // Update continuous readings
    existing.readings.push({
      ts: Date.now(),
      temp: reading.temp,
      vibRms: reading.vibRms,
      vibPeak: reading.vibPeak,
    });
    // Keep last 30 continuous readings
    if (existing.readings.length > 30) {
      existing.readings = existing.readings.slice(existing.readings.length - 30);
    }
    existing.lastUpdate = new Date().toISOString();
    saveIncidents();
    return existing.id;
  }

  // Create new incident
  const inc = {
    id: generateId(),
    motorId: motorIdx + 1,
    startTime: new Date().toISOString(),
    endTime: null,
    severity: severity,
    faultStatus: severity,
    temperature: reading.temp,
    vibRms: reading.vibRms,
    vibPeak: reading.vibPeak,
    thresholds: { ...thresholds },
    readings: [{ ts: Date.now(), temp: reading.temp, vibRms: reading.vibRms, vibPeak: reading.vibPeak }],
    faultReason: faultReason,
    faultEvidence: faultEvidence,
    possibleCauses: buildPossibleCauses(severity, reading, thresholds),
    relayShutdown: motorData[motorIdx]?.relayOn === false,
    shutdownConfirmed: motorData[motorIdx]?.relayOn === false,
    acknowledged: false,
    acknowledgedTime: null,
    techNotes: '',
    correctiveAction: '',
    resetTime: null,
    resolved: false,
    lastUpdate: new Date().toISOString(),
  };

  // Prepend (most recent first)
  incidents.unshift(inc);

  // Cap incidents to 200
  if (incidents.length > 200) incidents = incidents.slice(0, 200);
  saveIncidents();

  // Also push to alerts
  const alert = {
    id: 'ALT-' + Date.now().toString(36).toUpperCase(),
    incidentId: inc.id,
    motorId: motorIdx + 1,
    time: inc.startTime,
    severity: severity,
    temp: reading.temp,
    vibRms: reading.vibRms,
    vibPeak: reading.vibPeak,
    faultReason: faultReason,
    acknowledged: false,
  };
  alerts.unshift(alert);
  if (alerts.length > 300) alerts = alerts.slice(0, 300);
  saveAlerts();

  updateAlertBadge();
  showToast(`Motor ${motorIdx + 1}: ${severity} alert!`, severity === 'CRITICAL' ? 'error' : 'warn');
  return inc.id;
}

function closeIncident(motorIdx) {
  const open = incidents.find(
    inc => inc.motorId === motorIdx + 1 && !inc.endTime && !inc.resolved
  );
  if (open) {
    open.endTime = new Date().toISOString();
    saveIncidents();
  }
}

function buildPossibleCauses(severity, reading, thresholds) {
  const causes = [];
  if (reading.temp > thresholds.tempWarn) {
    causes.push('Excessive load causing motor heating');
    causes.push('Insufficient ventilation or blocked airflow');
    causes.push('Elevated ambient temperature');
    causes.push('High friction in bearings or shaft coupling');
    causes.push('Electrical issue causing increased current draw');
  }
  if (reading.vibRms > thresholds.vibRmsWarn || reading.vibPeak > thresholds.vibPeakWarn) {
    causes.push('Loose mechanical mounting or fasteners');
    causes.push('Rotating imbalance in shaft or load');
    causes.push('Shaft or coupling misalignment');
    causes.push('Bearing wear or damage');
    causes.push('Resonance with mounting structure');
  }
  return causes;
}

// ============================================================
// ─── 3D DIGITAL TWIN ENGINE (Three.js WebGL + 2.5D Fallback) ───
// ============================================================

// Color transformation helpers for Canvas 2D fallbacks
function lightenColor(col, factor) {
  if (!col || col.indexOf('#') !== 0) return col || '#334155';
  let num = parseInt(col.slice(1), 16);
  if (isNaN(num)) return col;
  let r = (num >> 16);
  let g = ((num >> 8) & 0x00FF);
  let b = (num & 0x0000FF);
  r = Math.min(255, Math.round(r + (255 - r) * factor));
  g = Math.min(255, Math.round(g + (255 - g) * factor));
  b = Math.min(255, Math.round(b + (255 - b) * factor));
  return `rgb(${r},${g},${b})`;
}

function darkenColor(col, factor) {
  if (!col || col.indexOf('#') !== 0) return col || '#0f172a';
  let num = parseInt(col.slice(1), 16);
  if (isNaN(num)) return col;
  let r = (num >> 16);
  let g = ((num >> 8) & 0x00FF);
  let b = (num & 0x0000FF);
  r = Math.max(0, Math.round(r * (1 - factor)));
  g = Math.max(0, Math.round(g * (1 - factor)));
  b = Math.max(0, Math.round(b * (1 - factor)));
  return `rgb(${r},${g},${b})`;
}

/**
 * Motor3D: Interactive 3D Industrial Induction Motor.
 * Uses hardware-accelerated Three.js WebGL when available,
 * with a high-definition Canvas 2.5D fallback.
 */
class Motor3D {
  constructor(canvas, motorIndex) {
    this.canvas = canvas;
    this.motorIndex = motorIndex;
    this.state = 'NORMAL';
    this.relayOn = false;
    this.vibRms = 0;
    this.targetRPM = 0;
    this.currentRPM = 0;
    this.vibrationAmp = 0;
    this.angle = 0;

    // Interactive Orbit
    this.isDragging = false;
    this.rotY = 0.55 + motorIndex * 0.15;
    this.rotX = 0.22;
    this.rotVelY = 0.004;
    this.rotVelX = 0;
    this.pulsate = 0;
    this.vibPhase = 0;
    this.lastTime = performance.now();
    this.rafId = null;

    if (window.THREE) {
      try {
        this.initThree();
      } catch (err) {
        console.warn('Three.js init failed, falling back to Canvas 2D:', err);
        this.fallbackToCanvas2D();
      }
    } else {
      this.initCanvas2D();
    }

    this.setupInteractivity();
    this.start();
  }

  initThree() {
    this.isThree = true;
    const rect = this.canvas.getBoundingClientRect();
    const W = Math.max(rect.width || 280, 240);
    const H = Math.max(rect.height || 200, 180);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, W / H, 0.1, 50);
    this.camera.position.set(0, 1.8, 6.4);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(W, H, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    // Studio Lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1.1);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
    this.keyLight.position.set(5, 8, 5);
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x00d4ff, 1.0);
    this.rimLight.position.set(-6, -2, -5);
    this.scene.add(this.rimLight);

    this.glowLight = new THREE.PointLight(0x00d4ff, 2.0, 7);
    this.glowLight.position.set(0, 0, 0);
    this.scene.add(this.glowLight);

    // Root Group (handles vibration jitter & user orbit rotation)
    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);

    this.statorGroup = new THREE.Group();
    this.rootGroup.add(this.statorGroup);

    this.rotorGroup = new THREE.Group();
    this.rootGroup.add(this.rotorGroup);

    this.buildThreeModel();
  }

  buildThreeModel() {
    // ── Cast iron stator body ──
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2563eb,
      emissive: 0x0f2d59,
      metalness: 0.2,
      roughness: 0.35,
    });

    this.chromeMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.45,
      roughness: 0.2,
    });

    this.finMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      emissive: 0x032840,
      metalness: 0.2,
      roughness: 0.4,
    });

    this.accentMat = new THREE.MeshStandardMaterial({
      color: 0x00d4ff,
      emissive: 0x00d4ff,
      emissiveIntensity: 0.85,
      metalness: 0.3,
      roughness: 0.2,
    });

    // 1. Stator Cylinder (horizontal orientation along X axis)
    const statorGeo = new THREE.CylinderGeometry(1.0, 1.0, 2.2, 32);
    statorGeo.rotateZ(Math.PI / 2);
    const statorMesh = new THREE.Mesh(statorGeo, this.bodyMat);
    this.statorGroup.add(statorMesh);

    // 2. Cooling Fins (14 longitudinal fins around stator)
    const finCount = 14;
    for (let i = 0; i < finCount; i++) {
      const angle = (i / finCount) * Math.PI * 2;
      // Skip bottom fins where mounting feet are placed
      if (angle > Math.PI * 0.7 && angle < Math.PI * 1.3) continue;
      const finGeo = new THREE.BoxGeometry(2.15, 0.22, 0.05);
      const fin = new THREE.Mesh(finGeo, this.finMat);
      fin.position.set(0, Math.cos(angle) * 1.05, Math.sin(angle) * 1.05);
      fin.rotation.x = angle;
      this.statorGroup.add(fin);
    }

    // 3. Front Bearing Shield
    const frontShieldGeo = new THREE.CylinderGeometry(1.04, 1.04, 0.25, 32);
    frontShieldGeo.rotateZ(Math.PI / 2);
    const frontShield = new THREE.Mesh(frontShieldGeo, this.bodyMat);
    frontShield.position.set(1.15, 0, 0);
    this.statorGroup.add(frontShield);

    // Bearing ring collar
    const collarGeo = new THREE.CylinderGeometry(0.55, 0.55, 0.2, 24);
    collarGeo.rotateZ(Math.PI / 2);
    const collar = new THREE.Mesh(collarGeo, this.chromeMat);
    collar.position.set(1.3, 0, 0);
    this.statorGroup.add(collar);

    // 4. Rear Cowl (Fan Cover)
    const cowlGeo = new THREE.CylinderGeometry(1.05, 1.05, 0.65, 32);
    cowlGeo.rotateZ(Math.PI / 2);
    const cowl = new THREE.Mesh(cowlGeo, this.finMat);
    cowl.position.set(-1.35, 0, 0);
    this.statorGroup.add(cowl);

    // Cowl grill cap
    const grillGeo = new THREE.CircleGeometry(1.04, 24);
    grillGeo.rotateY(-Math.PI / 2);
    const grill = new THREE.Mesh(grillGeo, new THREE.MeshBasicMaterial({ color: 0x0a1220 }));
    grill.position.set(-1.68, 0, 0);
    this.statorGroup.add(grill);

    // 5. Terminal Connection Box (on top)
    const termBoxGeo = new THREE.BoxGeometry(0.85, 0.45, 0.7);
    const termBox = new THREE.Mesh(termBoxGeo, this.bodyMat);
    termBox.position.set(0.1, 1.25, 0);
    this.statorGroup.add(termBox);

    // Terminal gland
    const glandGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.25, 16);
    const gland = new THREE.Mesh(glandGeo, this.chromeMat);
    gland.position.set(0.1, 1.25, 0.42);
    gland.rotateX(Math.PI / 2);
    this.statorGroup.add(gland);

    // 6. Mounting Base Feet
    const footMat = new THREE.MeshStandardMaterial({ color: 0x121d33, metalness: 0.5, roughness: 0.6 });
    const footFront = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.15, 2.3), footMat);
    footFront.position.set(0.7, -1.02, 0);
    this.statorGroup.add(footFront);

    const footRear = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.15, 2.3), footMat);
    footRear.position.set(-0.7, -1.02, 0);
    this.statorGroup.add(footRear);

    // Chrome bolts on feet
    const boltGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.08, 8);
    [-0.7, 0.7].forEach(bx => {
      [-0.95, 0.95].forEach(bz => {
        const bolt = new THREE.Mesh(boltGeo, this.chromeMat);
        bolt.position.set(bx, -0.92, bz);
        this.statorGroup.add(bolt);
      });
    });

    // 7. Sensor Rig: MPU6050 Vibration IMU + Pulsing Micro-LED
    const imuGeo = new THREE.BoxGeometry(0.2, 0.08, 0.22);
    const imu = new THREE.Mesh(imuGeo, new THREE.MeshStandardMaterial({ color: 0x054f77, metalness: 0.4 }));
    imu.position.set(1.15, 0.65, 0.6);
    this.statorGroup.add(imu);

    const ledGeo = new THREE.SphereGeometry(0.045, 12, 12);
    this.ledMesh = new THREE.Mesh(ledGeo, this.accentMat);
    this.ledMesh.position.set(1.15, 0.72, 0.6);
    this.statorGroup.add(this.ledMesh);

    // DS18B20 Temp Probe with conduit
    const probeGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.5, 12);
    probeGeo.rotateZ(Math.PI / 2);
    const probe = new THREE.Mesh(probeGeo, this.chromeMat);
    probe.position.set(-0.2, 0.9, -0.55);
    this.statorGroup.add(probe);

    // 8. Spinning Rotor Components (in rotorGroup)
    // Drive Shaft
    const shaftGeo = new THREE.CylinderGeometry(0.25, 0.25, 3.8, 24);
    shaftGeo.rotateZ(Math.PI / 2);
    const shaft = new THREE.Mesh(shaftGeo, this.chromeMat);
    shaft.position.set(0.4, 0, 0);
    this.rotorGroup.add(shaft);

    // Keyway slot on output shaft
    const keywayGeo = new THREE.BoxGeometry(0.65, 0.06, 0.07);
    const keyway = new THREE.Mesh(keywayGeo, new THREE.MeshBasicMaterial({ color: 0x111111 }));
    keyway.position.set(1.85, 0.24, 0);
    this.rotorGroup.add(keyway);

    // Internal Cooling Fan (inside rear cowl)
    const fanHubGeo = new THREE.CylinderGeometry(0.35, 0.35, 0.2, 16);
    fanHubGeo.rotateZ(Math.PI / 2);
    const fanHub = new THREE.Mesh(fanHubGeo, this.chromeMat);
    fanHub.position.set(-1.3, 0, 0);
    this.rotorGroup.add(fanHub);

    // 8 aerodynamic fan blades
    for (let i = 0; i < 8; i++) {
      const bAngle = (i / 8) * Math.PI * 2;
      const bladeGeo = new THREE.BoxGeometry(0.12, 0.6, 0.04);
      const blade = new THREE.Mesh(bladeGeo, this.accentMat);
      blade.position.set(-1.3, Math.cos(bAngle) * 0.55, Math.sin(bAngle) * 0.55);
      blade.rotation.x = bAngle + 0.35;
      this.rotorGroup.add(blade);
    }

    // 9. Holographic Pedestal Base Ring
    const pedRingGeo = new THREE.RingGeometry(1.6, 2.2, 32);
    pedRingGeo.rotateX(-Math.PI / 2);
    this.pedestalMesh = new THREE.Mesh(pedRingGeo, new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.25,
      wireframe: true,
    }));
    this.pedestalMesh.position.set(0, -1.08, 0);
    this.rootGroup.add(this.pedestalMesh);
  }

  fallbackToCanvas2D() {
    this.isThree = false;
    if (this.canvas && this.canvas.parentNode) {
      const newCanvas = this.canvas.cloneNode(false);
      this.canvas.parentNode.replaceChild(newCanvas, this.canvas);
      this.canvas = newCanvas;
    }
    this.initCanvas2D();
  }

  initCanvas2D() {
    this.isThree = false;
    this.ctx = this.canvas.getContext('2d');
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width || 280;
    this.canvas.height = rect.height || 200;
  }

  setupInteractivity() {
    let startX = 0, startY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      this.rotVelY = 0;
      this.rotVelX = 0;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;
      this.rotY += dx * 0.015;
      this.rotX = Math.max(-0.5, Math.min(0.8, this.rotX + dy * 0.015));
      this.rotVelY = dx * 0.005;
      this.rotVelX = dy * 0.005;
    });

    const stopDrag = () => { this.isDragging = false; };
    this.canvas.addEventListener('pointerup', stopDrag);
    this.canvas.addEventListener('pointercancel', stopDrag);
    this.canvas.addEventListener('pointerleave', stopDrag);

    if (window.ResizeObserver) {
      new ResizeObserver(() => this.resize()).observe(this.canvas);
    }
  }

  resize() {
    if (!this.isThree || !this.renderer || !this.camera) return;
    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (W > 30 && H > 30) {
      this.camera.aspect = W / H;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(W, H, false);
    }
  }

  setState(state, relayOn, vibRms) {
    this.state = state;
    this.relayOn = relayOn;
    this.vibRms = vibRms || 0;
    this.vibrationAmp = Math.min(this.vibRms * 8, 15);

    if (!relayOn || state === 'LATCHED_OFF' || state === 'CRITICAL') {
      this.targetRPM = 0;
    } else if (state === 'NORMAL') {
      this.targetRPM = 1800;
    } else if (state === 'WARNING') {
      this.targetRPM = 1450;
    } else if (state === 'SENSOR_FAULT') {
      this.targetRPM = 600;
    }

    if (!config.demoMode) this.targetRPM = relayOn && deviceOnline ? 360 : 0;
    // Hardware rotation indicates relay energization only, not measured speed.
    // Dynamic RPM chip in DOM
    const rpmTag = document.getElementById(`m${this.motorIndex}-rpm-tag`);
    if (rpmTag) {
      rpmTag.textContent = config.demoMode ? `${Math.round(this.targetRPM)} RPM · DEMO` : 'RPM unavailable · relay animation';
      rpmTag.style.color = state === 'CRITICAL' ? 'var(--danger)' : state === 'WARNING' ? 'var(--warning)' : 'var(--cyan)';
    }

    if (this.isThree) {
      const colorMap = {
        'NORMAL':       { body: 0x2563eb, accent: 0x00d4ff, glow: 0x00d4ff, emissive: 0x0f2d59 },
        'WARNING':      { body: 0xb45309, accent: 0xfbbf24, glow: 0xffb300, emissive: 0x451a03 },
        'CRITICAL':     { body: 0xb91c1c, accent: 0xf87171, glow: 0xff3d3d, emissive: 0x450a0a },
        'SENSOR_FAULT': { body: 0x7e22ce, accent: 0xc084fc, glow: 0xc084fc, emissive: 0x3b0764 },
        'LATCHED_OFF':  { body: 0x334155, accent: 0x64748b, glow: 0x475569, emissive: 0x0f172a },
      };
      const col = colorMap[state] || colorMap['NORMAL'];
      this.bodyMat.color.setHex(col.body);
      if (col.emissive && this.bodyMat.emissive) this.bodyMat.emissive.setHex(col.emissive);
      this.accentMat.color.setHex(col.accent);
      this.accentMat.emissive.setHex(col.accent);
      this.glowLight.color.setHex(col.glow);
      if (this.pedestalMesh) this.pedestalMesh.material.color.setHex(col.accent);
    }
  }

  draw(timestamp) {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
    this.lastTime = timestamp;

    // Smooth RPM transition
    const rpmDiff = this.targetRPM - this.currentRPM;
    this.currentRPM += rpmDiff * Math.min(dt * 3, 1);

    // Friction & idle rotation
    if (!this.isDragging) {
      this.rotY += this.rotVelY;
      this.rotX += this.rotVelX;
      this.rotVelY *= 0.95;
      this.rotVelX *= 0.95;

    }

    this.pulsate += dt * 3;

    if (this.isThree) {
      this.rootGroup.rotation.y = this.rotY;
      this.rootGroup.rotation.x = this.rotX;

      // Shaft & fan spin
      const spinDelta = (this.currentRPM / 60) * Math.PI * 2 * dt;
      this.rotorGroup.rotation.x += spinDelta;

      // Vibration Shake Physics
      this.vibPhase += dt * 45;
      if (this.vibrationAmp > 0 && this.relayOn) {
        this.rootGroup.position.x = Math.sin(this.vibPhase) * this.vibrationAmp * 0.018;
        this.rootGroup.position.y = Math.cos(this.vibPhase * 1.3) * this.vibrationAmp * 0.012;
      } else {
        this.rootGroup.position.x *= 0.85;
        this.rootGroup.position.y *= 0.85;
      }

      // Pulsing glow light & LED
      const pulseFactor = 0.8 + Math.sin(this.pulsate) * 0.25;
      this.glowLight.intensity = (this.state === 'CRITICAL' ? 3.5 : this.state === 'WARNING' ? 2.0 : 1.1) * pulseFactor;

      if (this.pedestalMesh) {
        this.pedestalMesh.rotation.z += dt * 0.4;
      }

      this.renderer.render(this.scene, this.camera);
    } else {
      this.drawCanvas2D(dt);
    }
  }

  drawCanvas2D(dt) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Vibration Shake
    this.vibPhase += dt * 45;
    let shakeX = 0, shakeY = 0;
    if (this.vibrationAmp > 0 && this.relayOn) {
      shakeX = Math.sin(this.vibPhase) * this.vibrationAmp * 0.3;
      shakeY = Math.cos(this.vibPhase * 1.3) * this.vibrationAmp * 0.2;
    }

    const cx = W / 2 + shakeX;
    const cy = H / 2 + shakeY;

    // Glowing Pedestal Reflection
    const pedGrad = ctx.createRadialGradient(cx, cy + 50, 5, cx, cy + 50, 75);
    const glowHex = this.state === 'CRITICAL' ? 'rgba(255,61,61,0.25)' : this.state === 'WARNING' ? 'rgba(255,179,0,0.2)' : 'rgba(0,212,255,0.18)';
    pedGrad.addColorStop(0, glowHex);
    pedGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = pedGrad;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 50, 85, 20, 0, 0, Math.PI * 2);
    ctx.fill();

    // Motor Stator Body
    const bodyW = 110, bodyH = 65;
    const bodyGrad = ctx.createLinearGradient(cx - bodyW / 2, cy - bodyH / 2, cx + bodyW / 2, cy + bodyH / 2);
    const bodyColor = this.state === 'CRITICAL' ? '#5a1212' : this.state === 'WARNING' ? '#543b07' : '#1a2e47';
    bodyGrad.addColorStop(0, lightenColor(bodyColor, 0.3));
    bodyGrad.addColorStop(0.5, bodyColor);
    bodyGrad.addColorStop(1, darkenColor(bodyColor, 0.4));
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.roundRect(cx - bodyW / 2, cy - bodyH / 2, bodyW, bodyH, 12);
    ctx.fill();

    // 8 Cooling Fins
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 2;
    for (let f = 1; f < 6; f++) {
      const fy = cy - bodyH / 2 + (bodyH / 6) * f;
      ctx.beginPath();
      ctx.moveTo(cx - bodyW / 2 + 10, fy);
      ctx.lineTo(cx + bodyW / 2 - 10, fy);
      ctx.stroke();
    }

    // Terminal Box
    ctx.fillStyle = darkenColor(bodyColor, 0.3);
    ctx.beginPath();
    ctx.roundRect(cx - 20, cy - bodyH / 2 - 14, 40, 16, 4);
    ctx.fill();

    // Drive Shaft (rotating)
    const shaftW = 44, shaftH = 14;
    const shaftX = cx + bodyW / 2;
    const shaftGrad = ctx.createLinearGradient(shaftX, cy - shaftH / 2, shaftX, cy + shaftH / 2);
    shaftGrad.addColorStop(0, '#e2e8f0');
    shaftGrad.addColorStop(0.5, '#94a3b8');
    shaftGrad.addColorStop(1, '#475569');
    ctx.fillStyle = shaftGrad;
    ctx.beginPath();
    ctx.roundRect(shaftX, cy - shaftH / 2, shaftW, shaftH, [0, 4, 4, 0]);
    ctx.fill();

    // Rotating Keyway
    this.angle += (this.currentRPM / 60) * 360 * dt;
    const keyRad = (this.angle * Math.PI) / 180;
    if (Math.cos(keyRad) > 0) {
      const keyY = cy + Math.sin(keyRad) * (shaftH / 2 - 2);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(shaftX + 8, keyY - 1.5, 18, 3);
    }

    // Rear Cowl & Spinning Fan Blades
    const cowlW = 20, cowlX = cx - bodyW / 2 - cowlW;
    ctx.fillStyle = darkenColor(bodyColor, 0.5);
    ctx.beginPath();
    ctx.roundRect(cowlX, cy - bodyH / 2 + 4, cowlW, bodyH - 8, [6, 0, 0, 6]);
    ctx.fill();

    // Status LED
    ctx.fillStyle = this.state === 'CRITICAL' ? '#ff3d3d' : this.state === 'WARNING' ? '#ffb300' : '#00d4ff';
    ctx.shadowColor = ctx.fillStyle;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(cx - bodyW / 2 + 18, cy - bodyH / 2 + 16, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  start() {
    const loop = (timestamp) => {
      this.draw(timestamp);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
  }
}

/**
 * DetailTwin3D: Hero 3D Digital Twin Viewer for Motor Detail Page.
 * Features: Orbit controls, Zoom, 4 Display Modes (Solid, Thermal, Wireframe, Exploded),
 * Hotspot Callouts, and live HUD telemetry sync.
 */
class DetailTwin3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.mode = 'solid'; // 'solid' | 'thermal' | 'wireframe' | 'exploded'
    this.currentMotorIdx = 0;
    this.rotY = 0.8;
    this.rotX = 0.3;
    this.zoom = 5.8;
    this.rotVelY = 0.003;
    this.rotVelX = 0;
    this.isDragging = false;
    this.tempC = 35;
    this.vibRms = 0.08;
    this.currentRPM = 0;
    this.targetRPM = 0;
    this.state = 'NORMAL';
    this.relayOn = true;
    this.explodeFactor = 0;
    this.targetExplode = 0;
    this.lastTime = performance.now();
    this.rafId = null;

    if (window.THREE) {
      try {
        this.initThree();
      } catch (e) {
        console.warn('DetailTwin3D init failed, falling back to Canvas 2D:', e);
        this.fallbackToCanvas2D();
      }
    } else {
      this.initCanvas2D();
    }
    this.setupInteractivity();
    this.start();
  }

  fallbackToCanvas2D() {
    this.isThree = false;
    if (this.canvas && this.canvas.parentNode) {
      const newCanvas = this.canvas.cloneNode(false);
      this.canvas.parentNode.replaceChild(newCanvas, this.canvas);
      this.canvas = newCanvas;
    }
    this.initCanvas2D();
  }

  initCanvas2D() {
    this.isThree = false;
    this.ctx = this.canvas.getContext('2d');
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width || 760;
    this.canvas.height = rect.height || 380;
  }

  initThree() {
    this.isThree = true;
    const rect = this.canvas.getBoundingClientRect();
    const W = Math.max(rect.width || 700, 400);
    const H = Math.max(rect.height || 360, 280);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 50);
    this.camera.position.set(0, 1.6, this.zoom);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance'
    });
    this.renderer.setSize(W, H, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    // Studio Lighting
    this.ambientLight = new THREE.AmbientLight(0xffffff, 1.15);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.3);
    this.keyLight.position.set(6, 10, 6);
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight(0x00d4ff, 1.0);
    this.rimLight.position.set(-8, -3, -6);
    this.scene.add(this.rimLight);

    this.glowLight = new THREE.PointLight(0x00d4ff, 2.2, 9);
    this.glowLight.position.set(0, 0, 0);
    this.scene.add(this.glowLight);

    // Root Group
    this.rootGroup = new THREE.Group();
    this.scene.add(this.rootGroup);

    // Sub-groups for exploded view assembly
    this.statorGroup = new THREE.Group();
    this.frontShieldGroup = new THREE.Group();
    this.rearCowlGroup = new THREE.Group();
    this.termBoxGroup = new THREE.Group();
    this.rotorGroup = new THREE.Group();

    this.rootGroup.add(this.statorGroup);
    this.rootGroup.add(this.frontShieldGroup);
    this.rootGroup.add(this.rearCowlGroup);
    this.rootGroup.add(this.termBoxGroup);
    this.rootGroup.add(this.rotorGroup);

    this.buildModel();
  }

  buildModel() {
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x2563eb,
      emissive: 0x0f2d59,
      metalness: 0.2,
      roughness: 0.35,
    });

    this.chromeMat = new THREE.MeshStandardMaterial({
      color: 0xe2e8f0,
      metalness: 0.45,
      roughness: 0.2,
    });

    this.finMat = new THREE.MeshStandardMaterial({
      color: 0x0284c7,
      emissive: 0x032840,
      metalness: 0.2,
      roughness: 0.4,
    });

    this.accentMat = new THREE.MeshStandardMaterial({
      color: 0x00d4ff,
      emissive: 0x00d4ff,
      emissiveIntensity: 0.85,
      metalness: 0.3,
      roughness: 0.2,
    });

    // 1. Stator Body
    const statorGeo = new THREE.CylinderGeometry(1.15, 1.15, 2.4, 36);
    statorGeo.rotateZ(Math.PI / 2);
    this.statorMesh = new THREE.Mesh(statorGeo, this.bodyMat);
    this.statorGroup.add(this.statorMesh);

    // 16 Symmetrical Cooling Fins
    const finCount = 16;
    for (let i = 0; i < finCount; i++) {
      const angle = (i / finCount) * Math.PI * 2;
      if (angle > Math.PI * 0.7 && angle < Math.PI * 1.3) continue;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.25, 0.06), this.finMat);
      fin.position.set(0, Math.cos(angle) * 1.2, Math.sin(angle) * 1.2);
      fin.rotation.x = angle;
      this.statorGroup.add(fin);
    }

    // 2. Front Bearing Shield Group
    const frontShieldGeo = new THREE.CylinderGeometry(1.18, 1.18, 0.28, 36);
    frontShieldGeo.rotateZ(Math.PI / 2);
    const frontShield = new THREE.Mesh(frontShieldGeo, this.bodyMat);
    this.frontShieldGroup.add(frontShield);

    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.22, 28).rotateZ(Math.PI / 2), this.chromeMat);
    collar.position.set(0.18, 0, 0);
    this.frontShieldGroup.add(collar);
    this.frontShieldGroup.position.set(1.28, 0, 0);

    // 3. Rear Cowl Group
    const cowlGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.7, 36).rotateZ(Math.PI / 2);
    const cowl = new THREE.Mesh(cowlGeo, this.finMat);
    this.rearCowlGroup.add(cowl);
    this.rearCowlGroup.position.set(-1.45, 0, 0);

    // 4. Terminal Box Group
    const termBox = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 0.8), this.bodyMat);
    this.termBoxGroup.add(termBox);
    this.termBoxGroup.position.set(0.1, 1.45, 0);

    // 5. Rotor Shaft Group
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 4.2, 28).rotateZ(Math.PI / 2), this.chromeMat);
    shaft.position.set(0.45, 0, 0);
    this.rotorGroup.add(shaft);

    // Keyway slot
    const keyway = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.08), new THREE.MeshBasicMaterial({ color: 0x111111 }));
    keyway.position.set(2.0, 0.26, 0);
    this.rotorGroup.add(keyway);

    // Fan Impeller inside rear cowl
    const fanHub = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.22, 20).rotateZ(Math.PI / 2), this.chromeMat);
    fanHub.position.set(-1.45, 0, 0);
    this.rotorGroup.add(fanHub);

    for (let i = 0; i < 8; i++) {
      const bAngle = (i / 8) * Math.PI * 2;
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.7, 0.05), this.accentMat);
      blade.position.set(-1.45, Math.cos(bAngle) * 0.65, Math.sin(bAngle) * 0.65);
      blade.rotation.x = bAngle + 0.35;
      this.rotorGroup.add(blade);
    }

    // 6. Grid Pedestal
    const pedGeo = new THREE.RingGeometry(1.8, 2.6, 40).rotateX(-Math.PI / 2);
    this.pedestalMesh = new THREE.Mesh(pedGeo, new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.3,
      wireframe: true,
    }));
    this.pedestalMesh.position.set(0, -1.2, 0);
    this.rootGroup.add(this.pedestalMesh);
  }

  setupInteractivity() {
    let startX = 0, startY = 0;
    this.canvas.addEventListener('pointerdown', (e) => {
      this.isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      this.rotVelY = 0;
      this.rotVelX = 0;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (_) {}
    });

    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;
      this.rotY += dx * 0.012;
      this.rotX = Math.max(-0.6, Math.min(0.9, this.rotX + dy * 0.012));
      this.rotVelY = dx * 0.003;
      this.rotVelX = dy * 0.003;
    });

    const stop = () => { this.isDragging = false; };
    this.canvas.addEventListener('pointerup', stop);
    this.canvas.addEventListener('pointercancel', stop);

    // Zoom on scroll
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom = Math.max(3.8, Math.min(9.5, this.zoom + e.deltaY * 0.005));
      if (this.camera) this.camera.position.z = this.zoom;
    }, { passive: false });

    // Mode Buttons
    document.querySelectorAll('.twin-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.twin-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.setMode(btn.dataset.mode);
      });
    });

    // Reset view button
    document.getElementById('btn-reset-view')?.addEventListener('click', () => {
      this.rotY = 0.8;
      this.rotX = 0.3;
      this.zoom = 5.8;
      this.rotVelY = 0.003;
      this.rotVelX = 0;
      if (this.camera) this.camera.position.set(0, 1.6, this.zoom);
    });

    // Hotspot clicks
    document.getElementById('hotspot-temp')?.addEventListener('click', () => {
      showToast('DS18B20 Temp Probe: Monitoring stator core thermal load.');
    });
    document.getElementById('hotspot-vib')?.addEventListener('click', () => {
      showToast('MPU6050 3-Axis IMU: Measuring mechanical bearing resonance.');
    });
    document.getElementById('hotspot-shaft')?.addEventListener('click', () => {
      showToast('Drive Shaft: Inspecting keyway coupling & angular alignment.');
    });
    document.getElementById('hotspot-fan')?.addEventListener('click', () => {
      showToast('Cooling Impeller: Airflow verification & cowl cleanliness.');
    });

    if (window.ResizeObserver) {
      new ResizeObserver(() => this.resize()).observe(this.canvas);
    }
  }

  resize() {
    if (!this.isThree || !this.renderer || !this.camera) return;
    const rect = this.canvas.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;
    if (W > 30 && H > 30) {
      this.camera.aspect = W / H;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(W, H, false);
    }
  }

  setMode(mode) {
    this.mode = mode;
    this.targetExplode = mode === 'exploded' ? 1.0 : 0.0;

    if (!this.isThree) return;

    if (mode === 'wireframe') {
      this.bodyMat.wireframe = true;
      this.bodyMat.transparent = true;
      this.bodyMat.opacity = 0.45;
      this.finMat.wireframe = true;
      this.finMat.transparent = true;
      this.finMat.opacity = 0.35;
    } else {
      this.bodyMat.wireframe = false;
      this.bodyMat.transparent = false;
      this.bodyMat.opacity = 1.0;
      this.finMat.wireframe = false;
      this.finMat.transparent = false;
      this.finMat.opacity = 1.0;
    }

    this.applyColorState();
  }

  applyColorState() {
    if (!this.isThree) return;

    if (this.mode === 'thermal') {
      // Temperature Heatmap: Blue/Cyan (30C) -> Amber (55C) -> Burning Red (80C)
      const tNorm = Math.max(0, Math.min(1, (this.tempC - 25) / 55));
      const hue = (0.58 - tNorm * 0.58) * 360;
      this.bodyMat.color.setHSL((0.58 - tNorm * 0.58), 0.9, 0.42);
      this.glowLight.color.setHSL((0.58 - tNorm * 0.58), 1.0, 0.5);
    } else {
      const colMap = {
        'NORMAL':       { body: 0x1e3352, accent: 0x00d4ff, glow: 0x00d4ff },
        'WARNING':      { body: 0x4a3500, accent: 0xffb300, glow: 0xffb300 },
        'CRITICAL':     { body: 0x5a1212, accent: 0xff3d3d, glow: 0xff3d3d },
        'SENSOR_FAULT': { body: 0x3d1a5a, accent: 0xc084fc, glow: 0xc084fc },
        'LATCHED_OFF':  { body: 0x222222, accent: 0x666666, glow: 0x444444 },
      };
      const col = colMap[this.state] || colMap['NORMAL'];
      this.bodyMat.color.setHex(col.body);
      this.accentMat.color.setHex(col.accent);
      this.accentMat.emissive.setHex(col.accent);
      this.glowLight.color.setHex(col.glow);
      if (this.pedestalMesh) this.pedestalMesh.material.color.setHex(col.accent);
    }
  }

  update(motor, motorIdx) {
    if (!motor) return;
    this.currentMotorIdx = motorIdx;
    this.state = motor.state;
    this.relayOn = motor.relayOn;
    this.tempC = motor.sensors.tempC ?? 0;
    this.vibRms = motor.sensors.vibRms ?? 0;

    if (!this.relayOn || this.state === 'CRITICAL' || this.state === 'LATCHED_OFF') {
      this.targetRPM = 0;
    } else if (this.state === 'NORMAL') {
      this.targetRPM = 1800;
    } else if (this.state === 'WARNING') {
      this.targetRPM = 1450;
    } else {
      this.targetRPM = 600;
    }

    if (!config.demoMode) this.targetRPM = this.relayOn && deviceOnline ? 360 : 0;
    // Update HUD overlay chips
    setText('twin-motor-title', `Motor ${motorIdx + 1} — Telemetry Augmented Twin`);
    setText('twin-hud-temp', motor.sensors.tempOk ? `${this.tempC.toFixed(1)} °C` : 'FAULT');
    setText('twin-hud-vib', motor.sensors.vibOk ? `${this.vibRms.toFixed(3)} g` : 'FAULT');
    setText('twin-hud-rpm', config.demoMode ? `${Math.round(this.targetRPM)} RPM · DEMO` : 'RPM unavailable');

    const relayEl = document.getElementById('twin-hud-relay');
    if (relayEl) {
      relayEl.textContent = this.relayOn ? 'ENERGIZED' : 'SHUT DOWN';
      relayEl.className = `hud-val ${this.relayOn ? 'relay-active' : ''}`;
    }

    this.applyColorState();
  }

  draw(timestamp) {
    const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
    this.lastTime = timestamp;

    // RPM transition
    const rpmDiff = this.targetRPM - this.currentRPM;
    this.currentRPM += rpmDiff * Math.min(dt * 3, 1);

    // Friction & idle rotation
    if (!this.isDragging) {
      this.rotY += this.rotVelY;
      this.rotX += this.rotVelX;
      this.rotVelY *= 0.96;
      this.rotVelX *= 0.96;

    }

    // Exploded view animation lerp
    this.explodeFactor += (this.targetExplode - this.explodeFactor) * Math.min(dt * 5, 1);

    if (this.isThree) {
      this.rootGroup.rotation.y = this.rotY;
      this.rootGroup.rotation.x = this.rotX;

      // Shaft & fan spin
      const spinDelta = (this.currentRPM / 60) * Math.PI * 2 * dt;
      this.rotorGroup.rotation.x += spinDelta;

      // Exploded Assembly offset
      this.frontShieldGroup.position.x = 1.28 + this.explodeFactor * 1.5;
      this.rearCowlGroup.position.x = -1.45 - this.explodeFactor * 1.6;
      this.termBoxGroup.position.y = 1.45 + this.explodeFactor * 0.9;
      this.rotorGroup.position.x = this.explodeFactor * 2.2;

      // Mechanical vibration displacement
      if (this.vibRms > 0.4 && this.relayOn) {
        const vibTime = timestamp * 0.04;
        this.rootGroup.position.x = Math.sin(vibTime) * this.vibRms * 0.03;
        this.rootGroup.position.y = Math.cos(vibTime * 1.4) * this.vibRms * 0.02;
      } else {
        this.rootGroup.position.x *= 0.85;
        this.rootGroup.position.y *= 0.85;
      }

      if (this.pedestalMesh) {
        this.pedestalMesh.rotation.z += dt * 0.3;
      }

      this.renderer.render(this.scene, this.camera);
    } else {
      this.drawCanvas2D(dt);
    }
  }

  drawCanvas2D(dt) {
    const ctx = this.ctx;
    if (!ctx) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Vibration shake
    let shakeX = 0, shakeY = 0;
    if (this.vibRms > 0.4 && this.relayOn) {
      const vibTime = performance.now() * 0.04;
      shakeX = Math.sin(vibTime) * this.vibRms * 1.5;
      shakeY = Math.cos(vibTime * 1.4) * this.vibRms * 1.0;
    }

    const cx = W / 2 + shakeX;
    const cy = H / 2 + shakeY;

    // Glowing Pedestal Grid & Hologram Rings
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 212, 255, 0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(cx, cy + 90, 160, 45, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0, 212, 255, 0.08)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 90, 210, 60, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Color computation based on state and mode
    let mainColor = '#1e3352';
    let accentColor = '#00d4ff';
    if (this.mode === 'thermal') {
      const tNorm = Math.max(0, Math.min(1, (this.tempC - 25) / 55));
      const hue = Math.round((0.58 - tNorm * 0.58) * 360);
      mainColor = `hsl(${hue}, 85%, 42%)`;
      accentColor = `hsl(${hue}, 100%, 55%)`;
    } else if (this.state === 'CRITICAL') {
      mainColor = '#5a1212';
      accentColor = '#ff3d3d';
    } else if (this.state === 'WARNING') {
      mainColor = '#4a3500';
      accentColor = '#ffb300';
    } else if (this.state === 'SENSOR_FAULT') {
      mainColor = '#3d1a5a';
      accentColor = '#c084fc';
    }

    const isWire = this.mode === 'wireframe';
    const exp = this.explodeFactor;

    // 1. Mounting Base Feet
    const footW = 160, footH = 14;
    ctx.fillStyle = isWire ? 'rgba(18,29,51,0.2)' : '#121d33';
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = isWire ? 1 : 0.5;
    ctx.beginPath();
    ctx.roundRect(cx - footW / 2, cy + 50, footW, footH, 4);
    if (!isWire) ctx.fill();
    ctx.stroke();

    // Chrome bolts
    [-60, 60].forEach(bx => {
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath();
      ctx.arc(cx + bx, cy + 57, 4, 0, Math.PI * 2);
      ctx.fill();
    });

    // 2. Rear Cowl (slides left in exploded mode)
    const cowlX = cx - 120 - exp * 90;
    const cowlW = 38, cowlH = 110;
    ctx.fillStyle = isWire ? 'rgba(20,32,51,0.2)' : darkenColor(mainColor, 0.4);
    ctx.beginPath();
    ctx.roundRect(cowlX, cy - cowlH / 2, cowlW, cowlH, [10, 0, 0, 10]);
    if (!isWire) ctx.fill();
    ctx.stroke();

    // Fan Impeller inside rear cowl (rotates with RPM)
    this.angle = (this.angle || 0) + (this.currentRPM / 60) * 360 * dt;
    ctx.save();
    ctx.translate(cowlX + cowlW / 2, cy);
    ctx.rotate((this.angle * Math.PI) / 180);
    ctx.fillStyle = accentColor;
    for (let b = 0; b < 6; b++) {
      ctx.rotate(Math.PI / 3);
      ctx.fillRect(-2, -32, 4, 28);
    }
    ctx.restore();

    // 3. Stator Body (Central cylindrical enclosure)
    const bodyW = 170, bodyH = 120;
    const bodyX = cx - bodyW / 2;
    const bodyY = cy - bodyH / 2;

    const bodyGrad = ctx.createLinearGradient(bodyX, bodyY, bodyX, bodyY + bodyH);
    if (this.mode === 'thermal') {
      bodyGrad.addColorStop(0, lightenColor(mainColor, 0.3));
      bodyGrad.addColorStop(0.5, mainColor);
      bodyGrad.addColorStop(1, darkenColor(mainColor, 0.4));
    } else {
      bodyGrad.addColorStop(0, '#243b5e');
      bodyGrad.addColorStop(0.5, '#17273f');
      bodyGrad.addColorStop(1, '#0e1929');
    }
    ctx.fillStyle = isWire ? 'rgba(30,51,82,0.15)' : bodyGrad;
    ctx.beginPath();
    ctx.roundRect(bodyX, bodyY, bodyW, bodyH, 14);
    if (!isWire) ctx.fill();
    ctx.strokeStyle = isWire ? accentColor : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = isWire ? 1.5 : 1;
    ctx.stroke();

    // 12 Longitudinal Cooling Fins
    ctx.strokeStyle = isWire ? accentColor : 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    for (let f = 1; f < 8; f++) {
      const fy = bodyY + (bodyH / 8) * f;
      ctx.beginPath();
      ctx.moveTo(bodyX + 8, fy);
      ctx.lineTo(bodyX + bodyW - 8, fy);
      ctx.stroke();
    }

    // Thermal Wave Rings in Thermal mode
    if (this.mode === 'thermal') {
      const waveRadius = 75 + Math.sin(performance.now() * 0.005) * 8;
      ctx.save();
      ctx.strokeStyle = accentColor;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(cx, cy, waveRadius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
      ctx.restore();
    }

    // 4. Internal Copper Rotor (visible in wireframe or exploded mode)
    if (isWire || exp > 0.05) {
      const rotorX = bodyX + 30 + exp * 120;
      const rotorW = 100, rotorH = 70;
      ctx.fillStyle = 'rgba(217, 119, 6, 0.55)'; // copper color
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(rotorX, cy - rotorH / 2, rotorW, rotorH, 8);
      ctx.fill();
      ctx.stroke();
      // Copper coil windings
      ctx.strokeStyle = '#fbbf24';
      for (let w = 1; w < 6; w++) {
        ctx.beginPath();
        ctx.moveTo(rotorX + (rotorW / 6) * w, cy - rotorH / 2 + 5);
        ctx.lineTo(rotorX + (rotorW / 6) * w, cy + rotorH / 2 - 5);
        ctx.stroke();
      }
    }

    // 5. Terminal Connection Box (lifts up in exploded mode)
    const termW = 60, termH = 26;
    const termY = bodyY - termH - exp * 45;
    ctx.fillStyle = isWire ? 'rgba(30,51,82,0.2)' : darkenColor(mainColor, 0.35);
    ctx.beginPath();
    ctx.roundRect(cx - termW / 2 + 5, termY, termW, termH, 4);
    if (!isWire) ctx.fill();
    ctx.strokeStyle = isWire ? accentColor : 'rgba(255,255,255,0.15)';
    ctx.stroke();

    // 6. Front Bearing Shield (slides right in exploded mode)
    const frontShieldX = bodyX + bodyW + exp * 90;
    const frontShieldW = 28, frontShieldH = 114;
    ctx.fillStyle = isWire ? 'rgba(30,51,82,0.2)' : lightenColor(mainColor, 0.15);
    ctx.beginPath();
    ctx.roundRect(frontShieldX, cy - frontShieldH / 2, frontShieldW, frontShieldH, [0, 8, 8, 0]);
    if (!isWire) ctx.fill();
    ctx.stroke();

    // 7. Drive Shaft (rotates with keyway)
    const shaftX = frontShieldX + frontShieldW;
    const shaftW = 65 + exp * 40;
    const shaftH = 22;
    const shaftGrad = ctx.createLinearGradient(shaftX, cy - shaftH / 2, shaftX, cy + shaftH / 2);
    shaftGrad.addColorStop(0, '#f1f5f9');
    shaftGrad.addColorStop(0.5, '#94a3b8');
    shaftGrad.addColorStop(1, '#475569');
    ctx.fillStyle = shaftGrad;
    ctx.beginPath();
    ctx.roundRect(shaftX, cy - shaftH / 2, shaftW, shaftH, [0, 5, 5, 0]);
    ctx.fill();

    // Keyway slot
    const keyRad = (this.angle * Math.PI) / 180;
    if (Math.cos(keyRad) > 0) {
      const keyY = cy + Math.sin(keyRad) * (shaftH / 2 - 3);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(shaftX + 12, keyY - 2, 28, 4);
    }

    // 8. Attached Sensor Micro-Hardware
    // DS18B20 Temp Probe
    ctx.fillStyle = '#cbd5e1';
    ctx.fillRect(cx - 20, bodyY - 8, 8, 12);
    // MPU6050 3-Axis IMU with Pulsing micro-LED
    ctx.fillStyle = '#0284c7';
    ctx.fillRect(cx + 35, bodyY + 12, 16, 12);
    ctx.fillStyle = accentColor;
    ctx.shadowColor = accentColor;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(cx + 43, bodyY + 18, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  start() {
    const loop = (timestamp) => {
      this.draw(timestamp);
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }
}

// Global 3D instances
const motor3DInstances = [null, null, null];
let detailTwinInstance = null;

// ============================================================
// ─── CHARTS (Chart.js) ─────────────────────────────────────
// ============================================================
let charts = {};

function createOrUpdateChart(canvasId, label, color, data, labels) {
  if (typeof Chart === 'undefined') return;
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;

  if (charts[canvasId]) {
    charts[canvasId].data.labels = labels;
    if (charts[canvasId].data.datasets && charts[canvasId].data.datasets[0]) {
      charts[canvasId].data.datasets[0].label = label;
      charts[canvasId].data.datasets[0].data = data;
      charts[canvasId].data.datasets[0].borderColor = color;
    }
    charts[canvasId].update('none');
    return;
  }

  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: label,
        data: data,
        borderColor: color,
        backgroundColor: color.replace(')', ', 0.08)').replace('rgb(', 'rgba(').replace('#', ''),
        borderWidth: 2,
        fill: true,
        tension: 0.4,
        pointRadius: 2,
        pointHoverRadius: 5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#0d1526',
          borderColor: 'rgba(0,212,255,0.2)',
          borderWidth: 1,
          titleColor: '#e8eef8',
          bodyColor: '#8fa8c8',
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0,212,255,0.04)', drawBorder: false },
          ticks: { color: '#4a6080', maxTicksLimit: 6, font: { family: 'JetBrains Mono', size: 10 } },
          border: { color: 'rgba(0,212,255,0.08)' }
        },
        y: {
          grid: { color: 'rgba(0,212,255,0.04)', drawBorder: false },
          ticks: { color: '#4a6080', font: { family: 'JetBrains Mono', size: 10 } },
          border: { color: 'rgba(0,212,255,0.08)' }
        }
      }
    }
  });
}

function getChartData(motorIdx, field) {
  const motorReadings = readings[motorIdx] || [];
  const slice = motorReadings.slice(-config.chartRange);
  return {
    labels: slice.map(r => new Date(r.ts).toLocaleTimeString()),
    data: slice.map(r => r[field] ?? 0)
  };
}

// ============================================================
// ─── DEMO MODE SIMULATION ───────────────────────────────────
// ============================================================
const DEMO_SCENARIOS = [
  // Normal operation
  (ds) => {
    ds.temp = 30 + Math.random() * 8;
    ds.vibRms = 0.08 + Math.random() * 0.06;
    ds.vibPeak = ds.vibRms * 2.2 + Math.random() * 0.05;
    ds.state = 'NORMAL'; ds.relay = true; ds.health = 90 + Math.random() * 10;
  },
  // Warming up
  (ds) => {
    ds.temp = 55 + Math.random() * 5 + Math.sin(Date.now() / 5000) * 5;
    ds.vibRms = 0.3 + Math.random() * 0.1;
    ds.vibPeak = ds.vibRms * 2 + Math.random() * 0.1;
    ds.state = ds.temp >= 60 ? 'WARNING' : 'NORMAL';
    ds.relay = true; ds.health = 65 - (ds.temp - 55) * 2;
  },
  // Vibration issue
  (ds) => {
    ds.temp = 40 + Math.random() * 5;
    ds.vibRms = 0.8 + Math.random() * 0.3;
    ds.vibPeak = ds.vibRms * 2.5 + Math.random() * 0.2;
    ds.state = ds.vibRms >= 1.5 ? 'CRITICAL' : 'WARNING';
    ds.relay = ds.state !== 'CRITICAL'; ds.health = 40 - (ds.vibRms - 0.5) * 20;
  },
];

let demoPhaseTimers = [0, 0, 0];
let demoCycleIndex  = [0, 0, 1];  // Each motor in different phase

function stepDemoSimulation() {
  for (let i = 0; i < 3; i++) {
    const ds = demoState[i];
    // Every ~15 seconds, cycle to next scenario
    demoPhaseTimers[i]++;
    if (demoPhaseTimers[i] > 5 * (i + 1) + 3) {
      demoPhaseTimers[i] = 0;
      demoCycleIndex[i] = (demoCycleIndex[i] + 1) % DEMO_SCENARIOS.length;
    }
    DEMO_SCENARIOS[demoCycleIndex[i]](ds);
    ds.temp = Math.max(20, ds.temp);
    ds.vibRms = Math.max(0.02, ds.vibRms);
    ds.vibPeak = Math.max(0.04, ds.vibPeak);
    ds.health = Math.max(0, Math.min(100, ds.health));
  }

  // Build fake motor data
  motorData = demoState.map((ds, i) => ({
    id: i + 1,
    state: ds.state,
    relayOn: ds.relay,
    latchedOff: ds.state === 'CRITICAL' || ds.state === 'LATCHED_OFF',
    health: Math.round(ds.health),
    faultAck: false,
    incidents: 0,
    faultReason: ds.state !== 'NORMAL' ? `DEMO: ${ds.state} condition simulated` : '',
    faultEvidence: '',
    stateMs: 1000,
    sensors: {
      tempOk: true,
      tempC: ds.temp,
      vibOk: true,
      vibRms: ds.vibRms,
      vibPeak: ds.vibPeak,
      accelX: ds.vibRms * 0.4,
      accelY: ds.vibRms * 0.3,
      accelZ: 1.0 + ds.vibRms * 0.1,
      timestamp: Date.now(),
    },
    thresholds: config.thresholds[i]
  }));

  processMotorData();
}

// ============================================================
// ─── LIVE ESP32 POLLING ─────────────────────────────────────
// ============================================================
let lastTelemetrySignature = '';
let lastTelemetryChange = 0;
let pollBusy = false;
let pollGeneration = 0;
async function pollESP32() {
  if (pollBusy || config.demoMode) return;
  pollBusy = true;
  const generation = pollGeneration;
  const url = `${config.esp32Url.replace(/\/$/, '')}/api/status`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (generation !== pollGeneration || config.demoMode) return;
    validateTelemetry(data);
    data.motors.sort((a,b) => a.id-b.id);
    const signature = data.motors.map(m => m.sensors.timestamp).join(',');
    if (signature === lastTelemetrySignature && Date.now() - lastTelemetryChange > Math.max(10000, config.refreshInterval * 3)) throw new Error('Stale sensor samples');
    if (signature !== lastTelemetrySignature) { lastTelemetrySignature = signature; lastTelemetryChange = Date.now(); }
    data.motors.sort((a,b) => a.id-b.id);

    deviceOnline = true;
    lastSeenTime = new Date();


    motorData = data.motors.map((m, i) => ({
      id: m.id,
      state: m.state,
      relayOn: m.relay_on,
      latchedOff: m.latched_off,
      health: m.health,
      faultAck: m.fault_ack,
      incidents: m.incidents,
      faultReason: m.fault_reason,
      faultEvidence: m.fault_evidence,
      stateMs: m.state_ms,
      sensors: {
        tempOk: m.sensors.temp_ok,
        tempC: m.sensors.temp_c,
        vibOk: m.sensors.vib_ok,
        vibRms: m.sensors.vib_rms,
        vibPeak: m.sensors.vib_peak,
        accelX: m.sensors.accel_x,
        accelY: m.sensors.accel_y,
        accelZ: m.sensors.accel_z,
        timestamp: m.sensors.timestamp,
      },
      thresholds: {
        tempWarn: m.thresholds.temp_warn,
        tempCrit: m.thresholds.temp_crit,
        vibRmsWarn: m.thresholds.vib_rms_warn,
        vibRmsCrit: m.thresholds.vib_rms_crit,
        vibPeakWarn: m.thresholds.vib_peak_warn,
        vibPeakCrit: m.thresholds.vib_peak_crit,
      }
    }));

    processMotorData();
    updateConnectionUI(true);

  } catch (err) {
    if (generation !== pollGeneration) return;
    deviceOnline = false;
    motorData = [null, null, null];
    window.motorData = motorData;
    updateOverviewPage();
    for (const model of [...motor3DInstances, detailTwinInstance]) {
      if (model) { model.targetRPM = 0; model.currentRPM = 0; model.relayOn = false; model.vibrationAmp = 0; }
    }
    renderReport();
    for (const id of ['twin-hud-relay','detail-accel-x','detail-accel-y','detail-accel-z','twin-hud-rpm','twin-hud-temp','twin-hud-vib','detail-state','detail-relay','detail-health','detail-temp-c','detail-vib-rms','detail-vib-peak']) setText(id, 'Disconnected');
    updateConnectionUI(false);
    setText('report-summary', 'HARDWARE disconnected: ' + err.message + '. Readings unavailable; retrying automatically.');
  } finally { pollBusy = false; }
}

function processMotorData() {
  window.motorData = motorData;
  // Store readings
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    if (!motorData[i]) continue;
    const s = motorData[i].sensors;
    if (!readings[i]) readings[i] = [];
    readings[i].push({
      mode: config.demoMode ? "DEMO" : "HARDWARE",
      state: motorData[i].state, relayOn: motorData[i].relayOn,
      ts: now,
      temp: s.tempOk ? s.tempC : null,
      vibRms: s.vibOk ? s.vibRms : null,
      vibPeak: s.vibOk ? s.vibPeak : null,
    });
    // Keep last 500
    if (readings[i].length > 500) readings[i] = readings[i].slice(-500);
  }
  saveReadings();
  renderReport();

  // Auto-create incidents for warnings/critical states
  for (let i = 0; i < 3; i++) {
    const m = motorData[i];
    if (!m) continue;
    const th = m.thresholds || config.thresholds[i] || DEFAULT_CONFIG.thresholds[i];
    const reading = { temp: m.sensors.tempC, vibRms: m.sensors.vibRms, vibPeak: m.sensors.vibPeak };

    if (m.state === 'CRITICAL' || m.state === 'WARNING' || m.state === 'SENSOR_FAULT') {
      openOrUpdateIncident(i, m.state, reading, th, m.faultReason, m.faultEvidence);
    } else if (m.state === 'NORMAL') {
      closeIncident(i);
    }
  }

  // Update UI
  updateOverviewPage();
  if (currentPage === 'motor-detail') updateMotorDetail(selectedMotor);
  if (currentPage === 'alerts') renderAlerts();
  if (currentPage === 'history') renderHistory();
}

// ============================================================
// ─── CONNECTION UI ──────────────────────────────────────────
// ============================================================
function updateConnectionUI(online) {
  const offlineBanner = document.getElementById('offline-banner');
  const demoBanner    = document.getElementById('demo-banner');
  const connDot       = document.getElementById('conn-dot');
  const connText      = document.getElementById('conn-text');
  const lastSeenEl    = document.getElementById('last-seen');

  if (lastSeenEl) lastSeenEl.textContent = lastSeenTime ? 'Last received: ' + lastSeenTime.toLocaleTimeString() : 'No hardware data received';
  if (config.demoMode) {
    offlineBanner?.classList.remove('visible');
    demoBanner?.classList.add('visible');
    if (connDot) { connDot.className = 'dot demo'; }
    if (connText) connText.textContent = 'DEMO MODE';
  } else if (online) {
    offlineBanner?.classList.remove('visible');
    demoBanner?.classList.remove('visible');
    if (connDot) { connDot.className = 'dot online'; }
    if (connText) connText.textContent = 'DEVICE ONLINE';
  } else {
    offlineBanner?.classList.add('visible');
    demoBanner?.classList.remove('visible');
    if (connDot) { connDot.className = 'dot offline'; }
    if (connText) connText.textContent = 'DEVICE OFFLINE';
    if (lastSeenEl && lastSeenTime) {
      lastSeenEl.textContent = 'Last seen: ' + lastSeenTime.toLocaleTimeString();
    }
  }
}

// ============================================================
// ─── OVERVIEW PAGE ──────────────────────────────────────────
// ============================================================
let overviewChartsInitialized = false;
let overviewCharts = {};

function initOverviewCharts() {
  if (overviewChartsInitialized) return;
  if (typeof Chart === 'undefined') return;

  const tempEl = document.getElementById('overview-chart-temp');
  const vibEl = document.getElementById('overview-chart-vib');
  const healthEl = document.getElementById('overview-chart-health');
  if (!tempEl || !vibEl || !healthEl) return;

  overviewChartsInitialized = true;

  const chartOpts = (ylabel) => ({
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    interaction: { intersect: false, mode: 'index' },
    plugins: {
      legend: {
        display: true,
        labels: { color: '#8fa8c8', font: { size: 11 } }
      },
      tooltip: {
        backgroundColor: '#0d1526',
        borderColor: 'rgba(0,212,255,0.2)',
        borderWidth: 1,
        titleColor: '#e8eef8',
        bodyColor: '#8fa8c8',
      }
    },
    scales: {
      x: {
        grid: { color: 'rgba(0,212,255,0.04)', drawBorder: false },
        ticks: { color: '#4a6080', maxTicksLimit: 5, font: { family: 'JetBrains Mono', size: 10 } },
        border: { color: 'rgba(0,212,255,0.08)' }
      },
      y: {
        title: { display: true, text: ylabel, color: '#4a6080', font: { size: 10 } },
        grid: { color: 'rgba(0,212,255,0.04)', drawBorder: false },
        ticks: { color: '#4a6080', font: { family: 'JetBrains Mono', size: 10 } },
        border: { color: 'rgba(0,212,255,0.08)' }
      }
    }
  });

  const colors = ['#00d4ff', '#ffb300', '#00e676'];

  try {
    overviewCharts.temp = new Chart(tempEl, {
      type: 'line',
      data: {
        labels: [],
        datasets: [0,1,2].map(i => ({
          label: `Motor ${i+1}`,
          data: [],
          borderColor: colors[i],
          backgroundColor: colors[i] + '15',
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointRadius: 2,
        }))
      },
      options: chartOpts('°C')
    });

    overviewCharts.vib = new Chart(vibEl, {
      type: 'line',
      data: {
        labels: [],
        datasets: [0,1,2].map(i => ({
          label: `Motor ${i+1}`,
          data: [],
          borderColor: colors[i],
          backgroundColor: colors[i] + '15',
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointRadius: 2,
        }))
      },
      options: chartOpts('g')
    });

    overviewCharts.health = new Chart(healthEl, {
      type: 'line',
      data: {
        labels: [],
        datasets: [0,1,2].map(i => ({
          label: `Motor ${i+1}`,
          data: [],
          borderColor: colors[i],
          backgroundColor: colors[i] + '15',
          borderWidth: 2,
          fill: false,
          tension: 0.4,
          pointRadius: 2,
        }))
      },
      options: { ...chartOpts('%'), scales: { ...chartOpts('%').scales, y: { ...chartOpts('%').scales.y, min: 0, max: 100 } } }
    });
  } catch (err) {
    console.warn('Overview charts init error:', err);
  }
}

function updateOverviewCharts() {
  if (typeof Chart === 'undefined') return;
  initOverviewCharts();
  if (!overviewCharts.temp || !overviewCharts.vib || !overviewCharts.health) return;
  if (!motorData[0] && !motorData[1] && !motorData[2]) return;

  const now = new Date().toLocaleTimeString();
  const chartsList = [overviewCharts.temp, overviewCharts.vib, overviewCharts.health];
  const getters = [
    i => motorData[i]?.sensors?.tempC ?? null,
    i => motorData[i]?.sensors?.vibRms ?? null,
    i => motorData[i]?.health ?? null,
  ];
  const maxPts = config ? config.chartRange : 20;

  try {
    chartsList.forEach((chart, ci) => {
      if (!chart) return;
      chart.data.labels.push(now);
      if (chart.data.labels.length > maxPts) chart.data.labels.shift();
      for (let i = 0; i < 3; i++) {
        chart.data.datasets[i].data.push(getters[ci](i));
        if (chart.data.datasets[i].data.length > maxPts) chart.data.datasets[i].data.shift();
      }
      chart.update('none');
    });
  } catch (err) {
    console.warn('Overview chart update error:', err);
  }
}

function updateOverviewPage() {
  updateSummaryStats();
  if (currentPage !== 'overview' && currentPage !== 'overview-init') return;

  updateSummaryStats();
  for (let i = 0; i < 3; i++) updateMotorCard(i);
  updateTopbarTime();
  updateOverviewCharts();
}

function updateSummaryStats() {
  let running = 0, warn = 0, crit = 0, fault = 0;
  for (let i = 0; i < 3; i++) {
    const m = motorData[i];
    if (!m) continue;
    if (m.relayOn) running++;
    if (m.state === 'WARNING') warn++;
    if (m.state === 'CRITICAL' || m.state === 'LATCHED_OFF') crit++;
    if (m.state === 'SENSOR_FAULT') fault++;
  }
  setText('stat-running', running);
  setText('stat-warnings', warn);
  setText('stat-critical', crit);
  setText('stat-faults', fault);

  // Update topbar Fleet Health Pill
  const healthPill = document.getElementById('sys-health-pill');
  const healthText = document.getElementById('sys-health-text');
  if (healthPill && healthText) {
    if (!motorData.some(Boolean)) {
      healthPill.className = 'system-health-pill';
      healthText.textContent = 'FLEET STATUS: DATA UNAVAILABLE';
    } else if (crit > 0) {
      healthPill.className = 'system-health-pill critical';
      healthText.textContent = `FLEET ALERT: ${crit} CRITICAL TRIP`;
    } else if (warn > 0) {
      healthPill.className = 'system-health-pill warning';
      healthText.textContent = `FLEET ATTENTION: ${warn} WARNING`;
    } else if (fault > 0) {
      healthPill.className = 'system-health-pill warning';
      healthText.textContent = `FLEET ATTENTION: ${fault} SENSOR FAULT`;
    } else {
      healthPill.className = 'system-health-pill healthy';
      healthText.textContent = 'FLEET STATUS: OPTIMAL';
    }
  }
}

function updateMotorCard(i) {
  const m = motorData[i];
  const card = document.getElementById(`motor-card-${i}`);
  if (!card) return;

  // Update card state class
  card.className = 'motor-card';
  if (m) {
    const stateClass = m.state.toLowerCase().replace('_', '-').replace('_', '-');
    card.classList.add(`state-${stateClass}`);
  }

  if (!m) {
    // No data yet
    setText(`m${i}-rpm-tag`, 'RPM unavailable');
    setText(`m${i}-relay-text`, 'RELAY UNKNOWN');
    const relayDot = document.getElementById(`m${i}-relay-dot`);
    if (relayDot) relayDot.className = 'relay-dot';
    setText(`m${i}-state-badge`, '—');
    setText(`m${i}-temp`, '—');
    setText(`m${i}-vibrms`, '—');
    setText(`m${i}-vibpeak`, '—');
    setText(`m${i}-health`, '—');
    setText(`m${i}-health-pct`, '—');
    setText(`m${i}-last-update`, 'No data');
    return;
  }

  // Status badge
  const badge = document.getElementById(`m${i}-state-badge`);
  if (badge) {
    badge.textContent = m.state.replace('_', ' ');
    const badgeMap = { NORMAL: 'normal', WARNING: 'warning', CRITICAL: 'critical', SENSOR_FAULT: 'sensor_fault', LATCHED_OFF: 'latched_off' };
    badge.className = `motor-status-badge badge-${badgeMap[m.state] || 'normal'}`;
  }

  // Metrics
  const s = m.sensors;
  const th = m.thresholds || config.thresholds[i] || DEFAULT_CONFIG.thresholds[i];

  const tempEl = document.getElementById(`m${i}-temp`);
  if (tempEl) {
    tempEl.textContent = s.tempOk ? s.tempC.toFixed(1) : 'FAULT';
    tempEl.className = 'metric-value' + (
      !s.tempOk ? ' fault' :
      s.tempC >= th.tempCrit ? ' crit' :
      s.tempC >= th.tempWarn ? ' warn' : ''
    );
  }

  const vibEl = document.getElementById(`m${i}-vibrms`);
  if (vibEl) {
    vibEl.textContent = s.vibOk ? s.vibRms.toFixed(3) : 'FAULT';
    vibEl.className = 'metric-value' + (
      !s.vibOk ? ' fault' :
      s.vibRms >= th.vibRmsCrit ? ' crit' :
      s.vibRms >= th.vibRmsWarn ? ' warn' : ''
    );
  }

  const peakEl = document.getElementById(`m${i}-vibpeak`);
  if (peakEl) {
    peakEl.textContent = s.vibOk ? s.vibPeak.toFixed(3) : 'FAULT';
    peakEl.className = 'metric-value' + (
      !s.vibOk ? ' fault' :
      s.vibPeak >= th.vibPeakCrit ? ' crit' :
      s.vibPeak >= th.vibPeakWarn ? ' warn' : ''
    );
  }

  // Mini threshold bars
  const tempBar = document.getElementById(`m${i}-temp-bar`);
  if (tempBar && s.tempOk) {
    const pct = Math.min(100, Math.max(8, (s.tempC / (th.tempCrit || 80)) * 100));
    tempBar.style.width = pct + '%';
    tempBar.style.background = s.tempC >= th.tempCrit ? 'var(--danger)' : s.tempC >= th.tempWarn ? 'var(--warning)' : 'var(--cyan)';
  }

  const vibBar = document.getElementById(`m${i}-vib-bar`);
  if (vibBar && s.vibOk) {
    const pct = Math.min(100, Math.max(8, (s.vibRms / (th.vibRmsCrit || 1.5)) * 100));
    vibBar.style.width = pct + '%';
    vibBar.style.background = s.vibRms >= th.vibRmsCrit ? 'var(--danger)' : s.vibRms >= th.vibRmsWarn ? 'var(--warning)' : 'var(--cyan)';
  }

  const peakBar = document.getElementById(`m${i}-peak-bar`);
  if (peakBar && s.vibOk) {
    const pct = Math.min(100, Math.max(8, (s.vibPeak / (th.vibPeakCrit || 3.0)) * 100));
    peakBar.style.width = pct + '%';
    peakBar.style.background = s.vibPeak >= th.vibPeakCrit ? 'var(--danger)' : s.vibPeak >= th.vibPeakWarn ? 'var(--warning)' : 'var(--cyan)';
  }

  setText(`m${i}-health`, m.health + '%');
  setText(`m${i}-health-pct`, m.health + '%');
  setText(`m${i}-last-update`, new Date(s.timestamp || Date.now()).toLocaleTimeString());

  // Relay indicator
  const relayDot = document.getElementById(`m${i}-relay-dot`);
  const relayText = document.getElementById(`m${i}-relay-text`);
  if (relayDot) relayDot.className = `relay-dot ${m.relayOn ? 'relay-on' : 'relay-off'}`;
  if (relayText) relayText.textContent = m.relayOn ? 'RELAY ON' : 'RELAY OFF';

  // Health bar
  const bar = document.getElementById(`m${i}-health-bar`);
  if (bar) {
    bar.style.width = m.health + '%';
    bar.style.background = healthColor(m.health);
  }

  // 3D motor state update
  if (motor3DInstances[i]) {
    motor3DInstances[i].setState(m.state, m.relayOn, s.vibRms || 0);
  }

  // Sensor connectivity
  const sensorEl = document.getElementById(`m${i}-sensors`);
  if (sensorEl) {
    const tempIcon = s.tempOk ? '🟢' : '🔴';
    const vibIcon  = s.vibOk  ? '🟢' : '🔴';
    sensorEl.textContent = `LM35 ${tempIcon} MPU6050 ${vibIcon}`;
  }
}

function healthColor(score) {
  if (score >= 70) return `hsl(${120 * (score - 70) / 30 + 60}, 80%, 45%)`;
  if (score >= 40) return 'hsl(38, 90%, 50%)';
  return 'hsl(0, 80%, 50%)';
}

// ============================================================
// ─── MOTOR DETAIL VIEW ──────────────────────────────────────
// ============================================================
function showMotorDetail(motorIdx) {
  selectedMotor = motorIdx;
  navigateTo('motor-detail');
  const titleEl = document.getElementById('detail-title');
  if (titleEl) titleEl.textContent = `Motor ${motorIdx + 1} Details`;
  updateMotorDetail(motorIdx);
}

function showPrevMotor() {
  const nextIdx = (selectedMotor - 1 + 3) % 3;
  showMotorDetail(nextIdx);
}

function showNextMotor() {
  const nextIdx = (selectedMotor + 1) % 3;
  showMotorDetail(nextIdx);
}

function updateMotorDetail(motorIdx) {
  const m = motorData[motorIdx];
  const detailContent = document.getElementById('detail-content');
  if (!detailContent) return;

  // Update tabs active state
  document.querySelectorAll('#page-motor-detail .tab-btn').forEach((btn, idx) => {
    btn.classList.toggle('active', idx === motorIdx);
  });

  // Update Hero 3D Digital Twin Viewer
  if (detailTwinInstance && m) {
    detailTwinInstance.update(m, motorIdx);
    setTimeout(() => detailTwinInstance.resize(), 50);
  }

  // Charts
  const tempChartData = getChartData(motorIdx, 'temp');
  const vibChartData  = getChartData(motorIdx, 'vibRms');
  createOrUpdateChart('detail-chart-temp', `Motor ${motorIdx + 1} Temperature °C`, '#ff6b6b', tempChartData.data, tempChartData.labels);
  createOrUpdateChart('detail-chart-vib',  `Motor ${motorIdx + 1} Vibration RMS g`, '#00d4ff', vibChartData.data, vibChartData.labels);

  // Readings panel
  if (!m) return;
  const s = m.sensors;
  const th = m.thresholds || config.thresholds[motorIdx] || DEFAULT_CONFIG.thresholds[motorIdx];

  setText(`detail-temp-c`, s.tempOk ? s.tempC.toFixed(2) + ' °C' : 'SENSOR FAULT');
  setText(`detail-vib-rms`, s.vibOk ? s.vibRms.toFixed(4) + ' g' : 'SENSOR FAULT');
  setText(`detail-vib-peak`, s.vibOk ? s.vibPeak.toFixed(4) + ' g' : 'SENSOR FAULT');
  setText(`detail-accel-x`, s.accelX?.toFixed(4) + ' g');
  setText(`detail-accel-y`, s.accelY?.toFixed(4) + ' g');
  setText(`detail-accel-z`, s.accelZ?.toFixed(4) + ' g');
  setText(`detail-health`, m.health + '%');
  setText(`detail-state`, m.state);
  setText(`detail-relay`, m.relayOn ? 'ENERGIZED' : 'DE-ENERGIZED');

  // Thresholds
  setText(`detail-th-tempwarn`, th.tempWarn + ' °C');
  setText(`detail-th-tempcrit`, th.tempCrit + ' °C');
  setText(`detail-th-vibwarn`, th.vibRmsWarn + ' g');
  setText(`detail-th-vibcrit`, th.vibRmsCrit + ' g');

  // Fault reason
  const faultEl = document.getElementById('detail-fault-reason');
  if (faultEl) {
    faultEl.textContent = m.faultReason || 'No active fault.';
    faultEl.style.display = m.faultReason ? 'block' : 'none';
  }

  // Motor incidents
  renderMotorIncidents(motorIdx);
}

function renderMotorIncidents(motorIdx) {
  const container = document.getElementById('detail-incidents');
  if (!container) return;
  const motorIncidents = incidents.filter(inc => inc.motorId === motorIdx + 1);
  if (!motorIncidents.length) {
    container.innerHTML = `<div class="empty-state"><span class="icon">✅</span>No incidents recorded for this motor.</div>`;
    return;
  }
  container.innerHTML = motorIncidents.slice(0, 10).map(inc => renderIncidentCard(inc)).join('');
  bindIncidentEvents(container);
}

// ============================================================
// ─── ALERT CENTER ───────────────────────────────────────────
// ============================================================
function renderAlerts() {
  const container = document.getElementById('alerts-container');
  if (!container) return;

  const motorFilter = document.getElementById('filter-motor')?.value || 'all';
  const sevFilter   = document.getElementById('filter-sev')?.value   || 'all';

  let filtered = [...alerts];
  if (motorFilter !== 'all') filtered = filtered.filter(a => a.motorId === parseInt(motorFilter));
  if (sevFilter   !== 'all') filtered = filtered.filter(a => a.severity === sevFilter);

  updateAlertBadge();

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><span class="icon">🔕</span>No alerts match the current filter.</div>`;
    return;
  }

  container.innerHTML = filtered.map(alert => `
    <div class="alert-item severity-${alert.severity} ${alert.acknowledged ? 'acknowledged' : ''}" data-alert-id="${alert.id}">
      <div class="alert-header">
        <div>
          <div class="alert-title">Motor ${alert.motorId} — ${alert.severity.replace('_',' ')}</div>
          <div class="alert-meta">${new Date(alert.time).toLocaleString()} &bull; ID: ${alert.id}</div>
        </div>
        <span class="severity-badge sev-${alert.severity}">${alert.severity.replace('_',' ')}</span>
      </div>
      <div class="alert-body">
        <b>Reason:</b> ${escapeHtml(alert.faultReason) || 'N/A'}<br>
        <b>Temp:</b> ${alert.temp?.toFixed(1) ?? 'N/A'} °C &bull;
        <b>Vib RMS:</b> ${alert.vibRms?.toFixed(3) ?? 'N/A'} g &bull;
        <b>Peak:</b> ${alert.vibPeak?.toFixed(3) ?? 'N/A'} g
      </div>
      <div class="alert-actions">
        ${!alert.acknowledged ? `<button class="btn btn-outline btn-sm" onclick="acknowledgeAlert('${alert.id}')">✓ Acknowledge</button>` : `<span class="text-muted text-xs">Acknowledged</span>`}
        <button class="btn btn-outline btn-sm" onclick="viewAlertIncident('${alert.incidentId}')">🔍 View Incident</button>
      </div>
    </div>
  `).join('');
}

function updateAlertBadge() {
  const unackCrit = alerts.filter(a => a.severity === 'CRITICAL' && !a.acknowledged).length;
  const unackWarn = alerts.filter(a => a.severity === 'WARNING'  && !a.acknowledged).length;

  const alertBadge = document.getElementById('nav-alert-badge');
  const histBadge  = document.getElementById('nav-hist-badge');
  if (alertBadge) {
    alertBadge.textContent = unackCrit + unackWarn;
    alertBadge.style.display = (unackCrit + unackWarn) > 0 ? 'inline' : 'none';
    alertBadge.className = `nav-badge ${unackCrit > 0 ? '' : 'warn'}`;
  }
  if (histBadge) {
    histBadge.textContent = incidents.filter(i => !i.acknowledged).length;
    histBadge.style.display = incidents.filter(i => !i.acknowledged).length > 0 ? 'inline' : 'none';
  }
}

function acknowledgeAlert(alertId) {
  const alert = alerts.find(a => a.id === alertId);
  if (alert) {
    alert.acknowledged = true;
    saveAlerts();
    // Also acknowledge related incident
    const inc = incidents.find(i => i.id === alert.incidentId);
    if (inc) { inc.acknowledged = true; inc.acknowledgedTime = new Date().toISOString(); saveIncidents(); }
    renderAlerts();
    showToast('Alert acknowledged', 'success');
  }
}

function viewAlertIncident(incidentId) {
  navigateTo('history');
  setTimeout(() => {
    const el = document.querySelector(`[data-incident-id="${incidentId}"] .incident-header`);
    if (el) { el.click(); el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  }, 300);
}

// ============================================================
// ─── FAILURE HISTORY ────────────────────────────────────────
// ============================================================
function renderHistory() {
  const container = document.getElementById('history-container');
  if (!container) return;

  const motorFilter = document.getElementById('hist-filter-motor')?.value || 'all';
  const sevFilter   = document.getElementById('hist-filter-sev')?.value   || 'all';
  const dateFilter  = document.getElementById('hist-filter-date')?.value  || '';

  let filtered = [...incidents];
  if (motorFilter !== 'all') filtered = filtered.filter(i => i.motorId === parseInt(motorFilter));
  if (sevFilter !== 'all')   filtered = filtered.filter(i => i.severity === sevFilter);
  if (dateFilter) {
    const d = new Date(dateFilter);
    filtered = filtered.filter(i => new Date(i.startTime).toDateString() === d.toDateString());
  }

  if (!filtered.length) {
    container.innerHTML = `<div class="empty-state"><span class="icon">📋</span>No incidents found. Motor health is excellent, or no faults have been recorded yet.</div>`;
    return;
  }

  container.innerHTML = `<div class="incident-list">${filtered.map(inc => renderIncidentCard(inc)).join('')}</div>`;
  bindIncidentEvents(container);
}

function renderIncidentCard(inc) {
  const sevClass = { WARNING: 'warning', CRITICAL: 'danger', SENSOR_FAULT: 'sensor-fault' }[inc.severity] || 'cyan';
  const isOpen = !inc.endTime && !inc.resolved;

  return `
  <div class="incident-card" data-incident-id="${inc.id}">
    <div class="incident-header" onclick="toggleIncident('${inc.id}')">
      <div class="incident-id mono">${inc.id}</div>
      <div class="incident-info">
        <div class="incident-title">Motor ${inc.motorId} — ${inc.severity.replace('_',' ')} ${isOpen ? '🔴 ACTIVE' : ''}</div>
        <div class="incident-time">${new Date(inc.startTime).toLocaleString()}${inc.endTime ? ` → ${new Date(inc.endTime).toLocaleString()}` : ' (ongoing)'}</div>
      </div>
      <div class="incident-badge-col">
        <span class="severity-badge sev-${inc.severity}">${inc.severity.replace('_',' ')}</span>
      </div>
      <div class="incident-ack">${inc.acknowledged ? '✓ Ack' : ''}</div>
      <div class="incident-chevron" id="chevron-${inc.id}">▶</div>
    </div>
    <div class="incident-body" id="body-${inc.id}">
      <div class="incident-section-title">📊 Evidence at Detection</div>
      <div class="evidence-row">
        <div class="evidence-item"><div class="evidence-label">Temperature</div><div class="evidence-val">${inc.temperature?.toFixed(1) ?? 'N/A'} °C</div></div>
        <div class="evidence-item"><div class="evidence-label">Vibration RMS</div><div class="evidence-val">${inc.vibRms?.toFixed(4) ?? 'N/A'} g</div></div>
        <div class="evidence-item"><div class="evidence-label">Vibration Peak</div><div class="evidence-val">${inc.vibPeak?.toFixed(4) ?? 'N/A'} g</div></div>
        <div class="evidence-item"><div class="evidence-label">Relay Shutdown</div><div class="evidence-val">${inc.relayShutdown ? '🔴 YES' : 'No'}</div></div>
      </div>
      <div class="incident-section-title">⚠️ Active Thresholds (${inc.thresholds?.calibrated === false ? 'UNCALIBRATED' : 'Set'})</div>
      <div class="evidence-box">
        Temp Warn: ${inc.thresholds?.tempWarn ?? '—'} °C | Temp Critical: ${inc.thresholds?.tempCrit ?? '—'} °C<br>
        Vib RMS Warn: ${inc.thresholds?.vibRmsWarn ?? '—'} g | Vib RMS Critical: ${inc.thresholds?.vibRmsCrit ?? '—'} g
      </div>
      <div class="incident-section-title">🔍 Observed Evidence</div>
      <div class="evidence-box">${escapeHtml(inc.faultEvidence) || '<em>No evidence string captured</em>'}</div>
      <div class="incident-section-title">❓ Possible Root Causes</div>
      <div class="evidence-box">
        <b>Observed:</b> ${escapeHtml(inc.faultReason) || 'N/A'}<br><br>
        <b>Possible causes (requires inspection to confirm):</b><br>
        ${(inc.possibleCauses || []).map(c => `• ${escapeHtml(c)}`).join('<br>') || 'None listed'}
        <br><br><em style="color:var(--text-muted);font-size:11px;">
        ⚠️ MPU6050 and LM35 readings provide observable evidence only. The exact mechanical root cause
        cannot be confirmed by sensors alone and requires physical inspection.</em>
      </div>
      <div class="incident-section-title">🔧 Maintenance</div>
      <textarea class="notes-input" id="notes-${inc.id}" placeholder="Add technician notes, inspection findings, corrective actions...">${escapeHtml(inc.techNotes || '')}</textarea>
      <div class="flex gap-sm mt-sm" style="flex-wrap:wrap;">
        <button class="btn btn-outline btn-sm" onclick="saveNotes('${inc.id}')">💾 Save Notes</button>
        ${!inc.acknowledged ? `<button class="btn btn-success btn-sm" onclick="acknowledgeIncident('${inc.id}')">✓ Acknowledge</button>` : `<span class="text-muted text-xs" style="padding:5px 0">✓ Ack: ${inc.acknowledgedTime ? new Date(inc.acknowledgedTime).toLocaleString() : 'Yes'}</span>`}
        ${!inc.resolved ? `<button class="btn btn-primary btn-sm" onclick="markResolved('${inc.id}')">✅ Mark Resolved</button>` : `<span class="text-success text-xs" style="padding:5px 0">✅ Resolved: ${inc.resetTime ? new Date(inc.resetTime).toLocaleString() : 'Yes'}</span>`}
      </div>
    </div>
  </div>`;
}

function bindIncidentEvents(container) {
  // Events are handled via onclick= inline for simplicity
}

function toggleIncident(id) {
  const body    = document.getElementById(`body-${id}`);
  const chevron = document.getElementById(`chevron-${id}`);
  const header  = body?.previousElementSibling;
  if (!body) return;
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  if (chevron) chevron.classList.toggle('open', !isOpen);
  if (header) header.classList.toggle('expanded', !isOpen);
}

function acknowledgeIncident(id) {
  const inc = incidents.find(i => i.id === id);
  if (inc) {
    inc.acknowledged = true;
    inc.acknowledgedTime = new Date().toISOString();
    saveIncidents();
    renderHistory();
    showToast('Incident acknowledged', 'success');
  }
}

function markResolved(id) {
  const inc = incidents.find(i => i.id === id);
  if (inc) {
    inc.resolved = true;
    inc.endTime = inc.endTime || new Date().toISOString();
    inc.resetTime = new Date().toISOString();
    inc.correctiveAction = document.getElementById(`notes-${id}`)?.value || inc.techNotes;
    saveIncidents();
    renderHistory();
    showToast('Incident marked resolved', 'success');
  }
}

function saveNotes(id) {
  const inc = incidents.find(i => i.id === id);
  const textarea = document.getElementById(`notes-${id}`);
  if (inc && textarea) {
    inc.techNotes = textarea.value;
    saveIncidents();
    showToast('Notes saved', 'success');
  }
}

// ============================================================
// ─── EXPORT / IMPORT ────────────────────────────────────────
// ============================================================
function exportJSON() {
  const data = {
    exportTime: new Date().toISOString(),
    schema: 'smartpredict-v2',
    mode: config.demoMode ? 'DEMO' : 'HARDWARE',
    incidents,
    alerts,
    config: { ...config, esp32Url: '[REDACTED]' }  // Don't export IP
  };
  downloadFile('smartpredict-history.json', JSON.stringify(data, null, 2), 'application/json');
  showToast('History exported as JSON', 'success');
}

function exportCSV() {
  const rows = [
    ['Mode','ID','MotorID','StartTime','EndTime','Severity','Temperature','VibRMS','VibPeak','Acknowledged','Resolved','FaultReason','TechNotes']
  ];
  for (const inc of incidents) {
    rows.push([
      config.demoMode ? 'DEMO' : 'HARDWARE', inc.id, inc.motorId,
      inc.startTime, inc.endTime || '',
      inc.severity,
      inc.temperature?.toFixed(2) ?? '',
      inc.vibRms?.toFixed(4) ?? '',
      inc.vibPeak?.toFixed(4) ?? '',
      inc.acknowledged ? 'Yes' : 'No',
      inc.resolved ? 'Yes' : 'No',
      `"${(inc.faultReason || '').replace(/"/g, '""')}"`,
      `"${(inc.techNotes || '').replace(/"/g, '""')}"`
    ]);
  }
  const csv = rows.map(r => r.join(',')).join('\n');
  downloadFile('smartpredict-history.csv', csv, 'text/csv');
  showToast('History exported as CSV', 'success');
}

function importJSON() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        if (data.mode !== (config.demoMode ? 'DEMO' : 'HARDWARE')) throw new Error('Backup mode does not match active mode');
        // Schema validation
        if (!data.schema || !data.schema.startsWith('smartpredict')) {
          showToast('Invalid file: not a SmartPredict backup', 'error');
          return;
        }
        if (!Array.isArray(data.incidents)) {
          showToast('Invalid file: missing incidents array', 'error');
          return;
        }
        if (!data.incidents.every(validIncident)) throw Error('Invalid incident records');
        if (!confirm(`Import ${data.incidents.length} incidents from ${new Date(data.exportTime).toLocaleString()}?\n\nThis will MERGE with existing history (not replace).`)) return;
        // Merge: add incidents not already present
        let added = 0;
        for (const inc of data.incidents) {
          if (!incidents.find(i => i.id === inc.id)) {
            incidents.push(inc);
            added++;
          }
        }
        incidents.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
        saveIncidents();
        renderHistory();
        showToast(`Imported ${added} new incidents`, 'success');
      } catch (err) {
        showToast('Failed to parse JSON: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
  };
  input.click();
}

function clearAllHistory() {
  const count = incidents.length;
  if (!confirm(`⚠️ WARNING: This will permanently delete ALL ${count} incident records from this browser.\n\nThis cannot be undone. Export a backup first!\n\nType "DELETE" to confirm...`)) return;
  const confirm2 = prompt('Type DELETE to confirm clearing all history:');
  if (confirm2 !== 'DELETE') {
    showToast('Clear cancelled', 'info');
    return;
  }
  incidents = [];
  alerts = [];
  saveIncidents();
  saveAlerts();
  renderHistory();
  renderAlerts();
  updateAlertBadge();
  showToast('All history cleared', 'warn');
}

function downloadFile(name, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// ─── SETTINGS ───────────────────────────────────────────────
// ============================================================
function renderSettings() {
  const urlInput = document.getElementById('setting-esp32-url');
  if (urlInput) urlInput.value = config.esp32Url;

  const intervalInput = document.getElementById('setting-interval');
  if (intervalInput) intervalInput.value = config.refreshInterval / 1000;

  const rangeInput = document.getElementById('setting-chart-range');
  if (rangeInput) rangeInput.value = config.chartRange;

  const retentionInput = document.getElementById('setting-retention');
  if (retentionInput) retentionInput.value = config.dataRetentionDays;

  const demoToggle = document.getElementById('setting-demo');
  if (demoToggle) demoToggle.checked = config.demoMode;

  // Per-motor thresholds
  for (let i = 0; i < 3; i++) {
    const th = config.thresholds[i];
    setInputVal(`th-${i}-tempwarn`, th.tempWarn);
    setInputVal(`th-${i}-tempcrit`, th.tempCrit);
    setInputVal(`th-${i}-vibrmswarn`, th.vibRmsWarn);
    setInputVal(`th-${i}-vibrmscrit`, th.vibRmsCrit);
    setInputVal(`th-${i}-vibpeakwarn`, th.vibPeakWarn);
    setInputVal(`th-${i}-vibpeakcrit`, th.vibPeakCrit);
  }
}

function saveSettings() {
  const candidate = document.getElementById('setting-esp32-url')?.value || config.esp32Url;
  try { const u = new URL(candidate); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw Error(); } catch { showToast('Enter a valid HTTP ESP32 address', 'error'); return; }
  config.esp32Url = document.getElementById('setting-esp32-url')?.value || config.esp32Url;
  config.refreshInterval = (parseFloat(document.getElementById('setting-interval')?.value) || 3) * 1000;
  config.chartRange = parseInt(document.getElementById('setting-chart-range')?.value) || 20;
  config.dataRetentionDays = parseInt(document.getElementById('setting-retention')?.value) || 30;
  config.demoMode = document.getElementById('setting-demo')?.checked ?? config.demoMode;

  for (let i = 0; i < 3; i++) {
    config.thresholds[i] = {
      tempWarn:    parseFloat(document.getElementById(`th-${i}-tempwarn`)?.value)    || 60,
      tempCrit:    parseFloat(document.getElementById(`th-${i}-tempcrit`)?.value)    || 80,
      vibRmsWarn:  parseFloat(document.getElementById(`th-${i}-vibrmswarn`)?.value)  || 0.5,
      vibRmsCrit:  parseFloat(document.getElementById(`th-${i}-vibrmscrit`)?.value)  || 1.5,
      vibPeakWarn: parseFloat(document.getElementById(`th-${i}-vibpeakwarn`)?.value) || 1.0,
      vibPeakCrit: parseFloat(document.getElementById(`th-${i}-vibpeakcrit`)?.value) || 3.0,
    };
  }

  saveConfig();
  restartPolling();
  showToast('Settings saved', 'success');
}

// ============================================================
// ─── NAVIGATION ─────────────────────────────────────────────
// ============================================================
function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');

  if (page === 'motor-detail') {
    const navMotorEl = document.getElementById(`nav-motor-${selectedMotor + 1}`);
    if (navMotorEl) navMotorEl.classList.add('active');
  } else {
    const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
    if (navEl) navEl.classList.add('active');
  }

  // Page-specific init
  try {
    if (page === 'overview')     updateOverviewPage();
    if (page === 'alerts')       renderAlerts();
    if (page === 'history')      renderHistory();
    if (page === 'settings')     renderSettings();
    if (page === 'motor-detail') updateMotorDetail(selectedMotor);
  } catch (err) {
    console.error('Page init error:', page, err);
  }

  // Update topbar title
  const titles = {
    'overview':     '🏭 Fleet Overview',
    'motor-detail': `🔧 Motor ${selectedMotor + 1} Digital Twin`,
    'alerts':       '🚨 Alert Center',
    'history':      '📋 Failure History',
    'settings':     '⚙️ Settings',
  };
  setText('topbar-page-title', titles[page] || 'SmartPredict');
}

// ============================================================
// ─── POLLING ────────────────────────────────────────────────
// ============================================================
function restartPolling() {
  pollGeneration++;
  lastTelemetrySignature = '';
  lastTelemetryChange = 0;
  for (const model of [...motor3DInstances, detailTwinInstance]) if (model) { model.targetRPM = 0; model.currentRPM = 0; }
  for (const id of ['twin-hud-relay','detail-accel-x','detail-accel-y','detail-accel-z','twin-hud-rpm','twin-hud-temp','twin-hud-vib','detail-state','detail-relay','detail-health','detail-temp-c','detail-vib-rms','detail-vib-peak']) setText(id, 'Awaiting data');
  motorData = [null, null, null];
  window.motorData = motorData;
  incidents = loadIncidents(); alerts = loadAlerts(); readings = loadReadings();
  deviceOnline = false;
  lastSeenTime = null;
  config.refreshInterval = Math.max(1000, Math.min(60000, Number(config.refreshInterval) || 3000));
  if (pollInterval) clearInterval(pollInterval);

  updateOverviewPage();
  renderReport();
  updateConnectionUI(false);
  updateAlertBadge();
  if (config.demoMode) {
    pollInterval = setInterval(() => {
      stepDemoSimulation();
      updateConnectionUI(false);
    }, config.refreshInterval);
    // Immediate first tick
    stepDemoSimulation();
    updateConnectionUI(false);
  } else {
    pollInterval = setInterval(pollESP32, config.refreshInterval);
    pollESP32();  // immediate
  }
}

// ============================================================
// ─── TOAST NOTIFICATIONS ────────────────────────────────────
// ============================================================
const toastIcons = { success: '✅', warn: '⚠️', error: '🔴', info: 'ℹ️' };
function showToast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${toastIcons[type] || 'ℹ️'}</span><span>${escapeHtml(msg)}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ============================================================
// ─── TOPBAR CLOCK ───────────────────────────────────────────
// ============================================================
function updateTopbarTime() {
  const el = document.getElementById('topbar-time');
  if (el) el.textContent = new Date().toLocaleString();
}

// ============================================================
// ─── HELPERS ────────────────────────────────────────────────
// ============================================================
function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setInputVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val;
}
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// ─── INITIALIZATION ─────────────────────────────────────────
// ============================================================
// Expose functions globally on window for inline handlers & diagnostics
window.motorData = motorData;
window.config = config;
window.selectedMotor = selectedMotor;
window.navigateTo = navigateTo;
window.showMotorDetail = showMotorDetail;
window.showPrevMotor = showPrevMotor;
window.showNextMotor = showNextMotor;
window.updateMotorDetail = updateMotorDetail;
window.exportJSON = exportJSON;
window.exportCSV = exportCSV;
window.importJSON = importJSON;
window.clearAllHistory = clearAllHistory;
window.saveSettings = saveSettings;
window.acknowledgeAlert = acknowledgeAlert;
window.viewAlertIncident = viewAlertIncident;
window.toggleIncident = toggleIncident;
window.saveNotes = saveNotes;
window.acknowledgeIncident = acknowledgeIncident;
window.markResolved = markResolved;

function initApp() {
  console.log('SmartPredict: initializing application...');

  // 1. Clock update & interval FIRST
  try {
    setInterval(updateTopbarTime, 1000);
    updateTopbarTime();
  } catch (err) { console.error('Clock error:', err); }

  // 2. Navigation events (all elements with [data-page])
  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      if (el.dataset.motor !== undefined) {
        selectedMotor = parseInt(el.dataset.motor, 10);
      }
      navigateTo(el.dataset.page);
    });
  });

  // 3. Motor card clicks on overview
  for (let i = 0; i < 3; i++) {
    const card = document.getElementById(`motor-card-${i}`);
    if (card) {
      card.addEventListener('click', () => showMotorDetail(i));
    }
  }

  // 4. Alert & History filter events
  ['filter-motor', 'filter-sev'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', renderAlerts);
  });
  ['hist-filter-motor', 'hist-filter-sev', 'hist-filter-date'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', renderHistory);
  });

  // 5. Action and export buttons
  document.getElementById('btn-export-json')?.addEventListener('click', exportJSON);
  document.getElementById('btn-export-csv')?.addEventListener('click', exportCSV);
  document.getElementById('btn-import-json')?.addEventListener('click', importJSON);
  document.getElementById('btn-clear-history')?.addEventListener('click', clearAllHistory);
  document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);


  // 6. Initialize 3D motor canvases FIRST so instances are ready when overview updates
  for (let i = 0; i < 3; i++) {
    try {
      const canvas = document.getElementById(`motor-canvas-${i}`);
      if (canvas) {
        motor3DInstances[i] = new Motor3D(canvas, i);
      }
    } catch (err) {
      console.warn(`Motor3D init error for motor ${i}:`, err);
    }
  }

  // 7. Initialize Hero 3D Digital Twin on Motor Detail Page safely
  try {
    const detailCanvas = document.getElementById('detail-twin-canvas');
    if (detailCanvas) {
      detailTwinInstance = new DetailTwin3D(detailCanvas);
    }
  } catch (err) {
    console.warn('DetailTwin3D init error:', err);
  }

  // 8. Start polling & live simulation so motorData is immediately populated
  try {
    restartPolling();
  } catch (err) { console.error('Polling error:', err); }

  // 9. Start on overview
  try {
    navigateTo('overview');
  } catch (err) { console.error('Navigate error:', err); }

  // 10. Update alert badges on startup
  try {
    updateAlertBadge();
  } catch (err) { console.error('Alert badge error:', err); }

  console.log('%c SmartPredict Dashboard v1.0 ', 'background:#00d4ff;color:#070d1a;font-weight:bold;font-size:14px;padding:4px 8px;border-radius:4px;');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initApp);
} else {
  initApp();
}


function validateTelemetry(data) {
  if (!data || !Array.isArray(data.motors) || data.motors.length !== 3) throw new Error('Expected three motors');
  const ids = new Set();
  for (const m of data.motors) {
    if (![1,2,3].includes(m.id) || ids.has(m.id)) throw new Error('Invalid motor IDs');
    ids.add(m.id);
    if (!['NORMAL','WARNING','CRITICAL','SENSOR_FAULT','LATCHED_OFF'].includes(m.state) || typeof m.relay_on !== 'boolean' || !m.sensors || !m.thresholds || !Number.isFinite(m.health) || m.health < 0 || m.health > 100) throw new Error('Invalid motor telemetry');
    const s = m.sensors;
    if (!Number.isFinite(s.timestamp) || s.timestamp < 0) throw new Error('Missing sensor timestamp');
    for (const axis of ['accel_x','accel_y','accel_z']) if (!Number.isFinite(s[axis])) s[axis] = null;
    for (const name of ['fault_reason','fault_evidence']) if (typeof m[name] !== 'string') m[name] = '';
    s.temp_ok = s.temp_ok === true && Number.isFinite(s.temp_c) && s.temp_c > -100 && s.temp_c < 200;
    s.vib_ok = s.vib_ok === true && Number.isFinite(s.vib_rms) && s.vib_rms >= 0 && Number.isFinite(s.vib_peak) && s.vib_peak >= 0;
  }
}
function renderReport() {
  const mode = config.demoMode ? 'DEMO — simulated' : 'HARDWARE';
  setText('report-summary', mode + ' · Updated ' + new Date().toLocaleTimeString() + '. Health is a threshold-based indicator, not a remaining-life prediction.');
  const el = document.getElementById('report-motors');
  if (!el) return;
  el.innerHTML = motorData.map((m,i) => m ? `<article><h3>Motor ${i+1}</h3><p>${escapeHtml(m.state)} · Health ${m.health}%</p><p>${m.relayOn ? 'Relay energized' : 'Relay off'} · RPM unavailable</p><p>${m.state === 'NORMAL' ? 'Maintenance: routine inspection; verify lubrication and mounting.' : 'Maintenance: inspect sensor connections, cooling, bearings and load before reset.'}</p><p>Life cycle: ${observedRunMinutes(i)} observed running minutes in retained samples. Remaining life unavailable. No rated-life model or lifetime counter is supplied by this hardware.</p></article>` : '<article>Awaiting hardware readings</article>').join('');
}
function exportTelemetry() {
  const rows = ['mode,motor,timestamp,state,relay_on,temperature_c,vibration_rms_g,vibration_peak_g'];
  Object.values(readings).forEach((samples,i) => (samples || []).forEach(r => rows.push([r.mode || (config.demoMode ? 'DEMO' : 'HARDWARE'),i+1,new Date(r.ts).toISOString(),r.state || '',r.relayOn ?? '',r.temp ?? '',r.vibRms ?? '',r.vibPeak ?? ''].join(','))));
  downloadFile('motor-telemetry.csv', rows.join('\n'), 'text/csv');
}

function safeStore(key, value) { try { localStorage.setItem(key,value); } catch { console.warn('Storage unavailable: export history before closing.'); } }

function observedRunMinutes(i) {
  const samples = readings[i] || [];
  let ms = 0;
  for (let n=1;n<samples.length;n++) {
    const gap=samples[n].ts-samples[n-1].ts;
    if (samples[n-1].relayOn && samples[n].relayOn && gap>0 && gap<=config.refreshInterval*2) ms+=gap;
  }
  return (ms/60000).toFixed(1);
}

function validIncident(x) {
 return x && typeof x.id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x.id) &&
 [1,2,3].includes(x.motorId) && ['WARNING','CRITICAL','SENSOR_FAULT'].includes(x.severity) &&
 Number.isFinite(Date.parse(x.startTime)) && Array.isArray(x.readings) &&
 ['temperature','vibRms','vibPeak'].every(k => x[k] == null || Number.isFinite(x[k])) &&
 ['faultReason','faultEvidence','possibleCauses','techNotes'].every(k => x[k] == null || typeof x[k] === 'string') &&
 (!x.thresholds || Object.values(x.thresholds).every(v => typeof v === 'boolean' || Number.isFinite(v)));
}
