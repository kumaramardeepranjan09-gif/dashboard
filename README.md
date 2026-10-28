# SmartPredict dashboard

## Start karne ke steps
1. ZIP extract karein. `dashboard` folder aur launcher files ko isi structure mein rakhein.
2. Windows: `start-dashboard.bat` double-click karein. Python available ho to Windows/macOS/Linux par project directory mein `python -m http.server 8080 --directory dashboard` run karein aur browser mein http://localhost:8080 kholein.
3. Pehle DEMO mode check karein. Settings mein demo checkbox simulated readings control karta hai.
4. Firmware ke Wi-Fi settings configure karein; Arduino IDE libraries, board selection aur existing GPIO wiring ke liye HARDWARE.md follow karein. Firmware file `firmware/SmartPredict_ESP32.ino` hai. GPIO mapping unchanged hai.
5. ESP32 aur computer ko same network par connect karein. Serial Monitor se ESP32 IP lein. Browser mein `http://ESP32-IP/api/status` check karein: three motors ka JSON aana chahiye.
6. Dashboard Settings mein ESP32 address enter karein, Demo disable karein, Save karein. Browser local-network permission maange to allow karein. HTTP dashboard use karein; HTTPS se HTTP hardware requests block ho sakti hain.
7. Temperature/vibration ko reference instruments se compare karein. Relay ON physical rotation ka proof nahi hai. Sensor unplug/disconnect test par unavailable/offline indication aur stopped visualization verify karein. Reconnect par polling automatically recover hoti hai.
8. Reports ke liye reading-history CSV aur incident JSON/CSV export karein. Demo aur hardware storage separate hai. Browser data clear karne se history delete hoti hai; regular exports rakhein.

## Reading interpretation
- Hardware firmware supplies temperature, vibration, relay state and threshold-based health.
- No RPM sensor is present. Hardware 3D movement is a clearly labelled relay-state animation, not measured shaft speed. Real variable-speed visualization needs a speed sensor and firmware telemetry extension.
- Service-life countdown uses cumulative ESP32 relay-on hours against a 200-hour budget. The separate observed-time summary covers retained browser samples only. Neither is a prediction of mechanical failure.
- Maintenance suggestions are inspection guidance, not a diagnosis. Dashboard threshold settings do not reconfigure ESP32 protection thresholds.
- Hardware disconnection never switches automatically to demo. Repeated frozen sensor timestamps are rejected.
- Existing legacy unlabelled history is not loaded into the separated v2 stores. Backups must match the active mode.

## Verification
`node --check dashboard/app.js` checks syntax. Browser smoke tests: install Playwright in your test environment, start the HTTP server on port 8080, then run `node tests/dashboard.cjs` (Chromium path may need adjustment).

Validated here: demo startup, disconnected hardware, no automatic simulation fallback, invalid telemetry, sensor sentinel rejection, navigation and absence of uncaught browser errors. Physical ESP32/sensors, Arduino compilation and Windows launcher execution require your machine and were not verified here. Firmware GPIOs and control logic are preserved.

## Additional fixes and checks
CSV reading export now supports the stored reading structure. Offline fleet health shows data unavailable even while viewing motor details. Relay labels and acceleration readings clear on disconnect. Motor housing no longer auto-orbits; drag to inspect it. Threshold displays use firmware telemetry in hardware mode. Incident shutdown evidence uses reported relay state. Invalid backup records are rejected before import.

Expanded Chromium checks passed using mocked firmware-shaped HTTP responses: successful hardware reception, relay-off animation stop, stale-data rejection, reconnection, and CSV download. These are software tests, not physical hardware validation.

## Reports, sound and hardware connection
Use **Generate Report / PDF** at the top of the dashboard, then **Print / Save as PDF**. The report includes the active mode, connection, latest readings, peak recorded temperature, observed run time, incidents and maintenance guidance. CSV exports the retained raw readings.

Click **Enable warning sound** once per browser session. A short alarm plays for new warning/failure states; click again to mute. Visual warnings remain active without sound. Demo alarms are labelled simulated. Browser/device volume and audio permission affect sound; the dashboard is not a replacement for ESP32 local protection.

Click **Connect real hardware** for the full connection checklist. Set Wi-Fi credentials in firmware, upload, read its IP from Serial Monitor at 115200 baud, verify `/api/status` in the same network, then enter that IP in Settings and disable Demo. No physical RPM measurement is available in the existing firmware.

## Your ESP32 and individual reports
The connection bar defaults to **http://10.104.199.236**. Connect your computer to the same network as the ESP32 and click **Connect hardware**. First verify `http://10.104.199.236/api/status` opens in that computer's browser. The cloud development machine cannot establish that your private-network ESP32 is reachable. If DHCP changes the IP, edit the address in the connection bar (or reserve its address in the router). **Disconnect** pauses monitoring only; it does not command the relay. **Demo** explicitly switches to simulated readings.

Each motor card and motor-detail screen has a **Motor report** button. The printable report and its CSV include only that selected motor. Failure reasons come from firmware plus reported threshold evidence; possible physical causes remain unconfirmed until inspected. Fleet reports remain available separately.

## Wiring (ESP32 classic DevKit / WROOM)
Disconnect motor power while wiring. Check the exact module pin labels; LM35 pin order varies with package. This wiring is for the existing small DC motor setup, not direct mains/three-phase switching. The 3D model is illustrative.

| Component | Motor 1 | Motor 2 | Motor 3 |
|---|---|---|---|
| Relay IN | GPIO25 | GPIO26 | GPIO27 |
| LM35 OUT | GPIO34 | GPIO35 | GPIO32 |
| MPU6050 SDA | GPIO21 | GPIO21 | GPIO16 |
| MPU6050 SCL | GPIO22 | GPIO22 | GPIO17 |
| MPU6050 AD0 | GND (0x68) | 3.3V (0x69) | GND (0x68) |

- MPU6050: use a module compatible with 3.3V supply/logic. VCC to its specified supply; pull-ups on SDA/SCL must go to 3.3V, never 5V. Sensor grounds to ESP32 GND.
- LM35: typical LM35 requires at least 4V supply; use regulated 5V where your exact part permits it. OUT to assigned ADC, GND to common GND. Verify output never exceeds ESP32 ADC limits (3.3V maximum). Do not connect 5V supply to an ADC pin.
- Relay module: use a 3.3V-compatible input module and its rated coil supply. Default firmware is active LOW. Verify polarity with motor power disconnected first. DC motor supply positive → rated fuse → relay COM; relay NO → motor positive; motor negative → motor supply negative. Use appropriate motor transient suppression. Follow your relay module's isolation/grounding requirements; never supply motors from an ESP32 GPIO or its 3.3V rail.

### Added physical buzzer
Firmware uses **GPIO23**, active HIGH, for an **active buzzer** (built-in oscillator). Passive piezo buzzers need a different tone driver.
1. GPIO23 → 1 kΩ resistor → base of a suitable NPN transistor (for example 2N2222; verify its pinout).
2. Emitter → GND. Add a 10 kΩ resistor from base to GND so it remains OFF during boot.
3. Collector → buzzer negative; buzzer positive → its rated supply (e.g. 5V for a 5V buzzer). Supply GND and ESP32 GND must be common.
4. For an inductive/magnetic buzzer, add a flyback diode across it: cathode to positive supply, anode to collector. Check transistor and diode current ratings for your buzzer.
5. Do not power the buzzer directly from GPIO23. Sound is asserted for CRITICAL, SENSOR_FAULT or LATCHED_OFF on any motor; ordinary WARNING remains a browser warning. It stops when all those fault states clear. Browser mute does not mute the physical buzzer.

## Firmware upload and real data checklist
1. Arduino IDE: install Espressif ESP32 board support and ArduinoJson 6.x. Select your exact ESP32 board and serial port. Preferences, WiFi, Wire and WebServer come with ESP32 support.
2. Open `firmware/SmartPredict_ESP32.ino` in an Arduino sketch folder named `SmartPredict_ESP32` (Arduino IDE may offer to create/move it). Set `WIFI_SSID` and `WIFI_PASSWORD` locally; do not commit credentials.
3. Check wiring with motor supply disconnected. Upload firmware. Serial Monitor: **115200 baud**. Note the assigned IP. The firmware does not force a static IP; reserve `10.104.199.236` in your router or update the dashboard if DHCP changes it.
4. On the same Wi-Fi, open `http://10.104.199.236/api/status`. Confirm three motors and changing `sensors.timestamp`, `temp_c`, `vib_rms`, plus `runtime_hours`, `service_life_hours` and `remaining_hours`.
5. Run `start-dashboard.bat`, or `python -m http.server 8080 --directory dashboard`. Open the local HTTP dashboard. Click **Connect hardware**. Allow local-network permission if prompted. Guest network isolation, VPNs, firewall rules and HTTPS-to-HTTP restrictions can prevent access.
6. With a controlled test setup, check sensor faults, relay shutdown and physical buzzer operation. Disconnect Wi-Fi: dashboard must show unavailable data, while local ESP32 protection and runtime accounting continue. Reconnect and verify recovery.

## 200-hour service-life countdown
Each motor begins with a **200-hour service budget**. Firmware counts relay-energized time, including periods when the browser is closed. Remaining hours = max(0, 200 − cumulative runtime hours). This measures energized time, not confirmed shaft rotation and not a predicted failure date.

Counters persist in ESP32 Preferences (NVS) once per minute and when a relay turns off. Sudden power loss may lose up to roughly one checkpoint interval. Flash erasure/replacing the ESP32 loses counters. Normal firmware upload without erasing NVS retains them. `runtime_persistent` in the API indicates whether NVS opened successfully. A new board starts at zero; existing historical runtime cannot be reconstructed. Demo time is simulated and separate. Countdown reaching zero does not automatically switch off a motor. Schedule maintenance when the budget is exhausted.

## Change thresholds
Actual protection thresholds are in **`THRESHOLDS[3]` in the firmware**. Rows correspond to motors 1, 2 and 3. Order:
`tempWarning, tempCritical, vibRmsWarning, vibRmsCritical, vibPeakWarning, vibPeakCritical, tempHysteresis, vibHysteresis, warningPersistMs, criticalPersistMs`.

Temperatures are °C, vibration is g, durations are milliseconds. Keep warning < critical and hysteresis positive. Calibrate against your motor and reference instruments. Edit the required row, upload firmware, then verify the returned `thresholds` object at `/api/status`. Hardware dashboard uses those values. Dashboard Settings thresholds configure demo behavior only; they do not write to the ESP32. Change `SERVICE_LIFE_HOURS` in firmware to change the service budget (this does not reset runtime). There is deliberately no automatic runtime reset or remote protection-threshold endpoint.

## Verification limits
Browser tests exercise firmware-shaped mock telemetry, faults, relay stop, stale detection, reconnect, reports and CSV. They cannot confirm electrical wiring, sensor calibration or your private-network reachability. The physical buzzer and newly added NVS counters need device validation. Arduino compilation must be checked with the selected board/toolchain before upload.
