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

## Reports, sound and hardware connection
Use **Generate Report / PDF** at the top of the dashboard, then **Print / Save as PDF**. The report includes the active mode, connection, latest readings, peak recorded temperature, observed run time, incidents and maintenance guidance. CSV exports the retained raw readings.

Click **Enable warning sound** once per browser session. A short alarm plays for new warning/failure states; click again to mute. Visual warnings remain active without sound. Demo alarms are labelled simulated. Browser/device volume and audio permission affect sound; the dashboard is not a replacement for ESP32 local protection.

Click **Connect real hardware** for the full connection checklist. Set Wi-Fi credentials in firmware, upload, read its IP from Serial Monitor at 115200 baud, verify `/api/status` in the same network, then enter that IP in Settings and disable Demo. No physical RPM measurement is available in the existing firmware.

## Your ESP32 and individual reports
The connection bar defaults to **http://10.104.199.236**. Connect your computer to the same network as the ESP32 and click **Connect hardware**. First verify `http://10.104.199.236/api/status` opens in that computer's browser. The cloud development machine cannot establish that your private-network ESP32 is reachable. If DHCP changes the IP, edit the address in the connection bar (or reserve its address in the router). **Disconnect** pauses monitoring only; it does not command the relay. **Demo** explicitly switches to simulated readings.

Each motor card and motor-detail screen has a **Motor report** button. The printable report and its CSV include only that selected motor. Failure reasons come from firmware plus reported threshold evidence; possible physical causes remain unconfirmed until inspected. Fleet reports remain available separately.
