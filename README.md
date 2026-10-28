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
- Life-cycle report counts observed relay-on time from retained samples only (maximum 500 samples per motor); it is not lifetime operating hours. Remaining useful life cannot be estimated reliably without rated-life data and a validated degradation model.
- Maintenance suggestions are inspection guidance, not a diagnosis. Dashboard threshold settings do not reconfigure ESP32 protection thresholds.
- Hardware disconnection never switches automatically to demo. Repeated frozen sensor timestamps are rejected.
- Existing legacy unlabelled history is not loaded into the separated v2 stores. Backups must match the active mode.

## Verification
`node --check dashboard/app.js` checks syntax. Browser smoke tests: install Playwright in your test environment, start the HTTP server on port 8080, then run `node tests/dashboard.cjs` (Chromium path may need adjustment).

Validated here: demo startup, disconnected hardware, no automatic simulation fallback, invalid telemetry, sensor sentinel rejection, navigation and absence of uncaught browser errors. Physical ESP32/sensors, Arduino compilation and Windows launcher execution require your machine and were not verified here. Firmware GPIOs and control logic are preserved.

## Additional fixes and checks
CSV reading export now supports the stored reading structure. Offline fleet health shows data unavailable even while viewing motor details. Relay labels and acceleration readings clear on disconnect. Motor housing no longer auto-orbits; drag to inspect it. Threshold displays use firmware telemetry in hardware mode. Incident shutdown evidence uses reported relay state. Invalid backup records are rejected before import.

Expanded Chromium checks passed using mocked firmware-shaped HTTP responses: successful hardware reception, relay-off animation stop, stale-data rejection, reconnection, and CSV download. These are software tests, not physical hardware validation.
