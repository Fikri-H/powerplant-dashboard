// ==========================================
// KONFIGURASI GLOBAL MQTT & DEFAULT
// ==========================================
// Ambil konfigurasi tersimpan dari localStorage jika ada, atau gunakan default
const DEFAULT_MQTT_BROKER = "wss://broker.hivemq.com:8884/mqtt";
let MQTT_BROKER = localStorage.getItem('mqtt_broker') || DEFAULT_MQTT_BROKER;
let FETCH_INTERVAL = localStorage.getItem('mqtt_interval') || "Real-time MQTT";

const TOPIC_PREFIX = "hybrid_power_polines";

let client = null;

// Menampung SELURUH riwayat data (supaya mode Zoom bisa digeser/pan ke belakang)
const allHistory = {
    labels: [],
    voltage: [],
    current: [],
    temp: [],
    power: []
};

const MAX_DASHBOARD_POINTS = 12; // Titik data yang tampil di grafik kecil dashboard
const MAX_HISTORY_LIMIT = 1000;  // Batas riwayat simpan di memori browser

// Register Plugin Zoom Chart.js jika tersedia
if (typeof ChartZoom !== 'undefined') {
    Chart.register(ChartZoom);
}

document.addEventListener('DOMContentLoaded', () => {

    // --------------------------------------
    // 1. Navigation SPA Handler (Sidebar Menu)
    // --------------------------------------
    const navItems = document.querySelectorAll('.nav-item');
    const pageViews = document.querySelectorAll('.page-view');

    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const targetPage = item.getAttribute('data-page');

            navItems.forEach(nav => nav.classList.remove('active'));
            item.classList.add('active');

            pageViews.forEach(page => {
                page.classList.toggle('active', page.id === `page-${targetPage}`);
            });
        });
    });

    // --------------------------------------
    // 2. Real-Time Clock & Network (WiFi) Handler
    // --------------------------------------
    function updateClock() {
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        const options = { day: 'numeric', month: 'short', year: 'numeric' };
        const dateStr = now.toLocaleDateString('id-ID', options);

        const currentTimeEl = document.getElementById('current-time');
        const currentDateEl = document.getElementById('current-date');
        if (currentTimeEl) currentTimeEl.innerText = timeStr;
        if (currentDateEl) currentDateEl.innerText = dateStr;
    }
    setInterval(updateClock, 1000);
    updateClock();

    function updateWifiStatus() {
        const wifiBadge = document.getElementById('wifi-status-badge');
        if (!wifiBadge) return;

        if (navigator.onLine) {
            wifiBadge.style.backgroundColor = '#16a34a';
            wifiBadge.style.color = '#ffffff';
            wifiBadge.innerHTML = `<i class="fa-solid fa-wifi"></i> WiFi Active`;
        } else {
            wifiBadge.style.backgroundColor = '#dc2626';
            wifiBadge.style.color = '#ffffff';
            wifiBadge.innerHTML = `<i class="fa-solid fa-wifi"></i> WiFi Offline`;
        }
    }

    window.addEventListener('online', updateWifiStatus);
    window.addEventListener('offline', updateWifiStatus);
    updateWifiStatus();

    // --------------------------------------
    // 3. Setup Chart.js Instances
    // --------------------------------------
    const commonOptions = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
            x: { 
                grid: { color: 'rgba(255, 255, 255, 0.05)' }, 
                ticks: { color: '#62728d', font: { size: 9 } } 
            },
            y: { 
                grid: { color: 'rgba(255, 255, 255, 0.05)' }, 
                ticks: { color: '#62728d', font: { size: 9 } },
                beginAtZero: false 
            }
        }
    };

    // Gauge Chart (SOC)
    const gaugeCanvas = document.getElementById('socGauge');
    let socGauge = null;
    if (gaugeCanvas) {
        const ctxGauge = gaugeCanvas.getContext('2d');
        socGauge = new Chart(ctxGauge, {
            type: 'doughnut',
            data: {
                datasets: [{
                    data: [0, 100],
                    backgroundColor: ['#22c55e', '#1e293b'],
                    borderWidth: 0,
                    circumference: 240,
                    rotation: 240,
                    borderRadius: 10
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                cutout: '85%',
                plugins: { tooltip: { enabled: false } }
            }
        });
    }

    // Line Charts Generator
    const createLineChart = (canvasId, color) => {
        const canvas = document.getElementById(canvasId);
        if (!canvas) return null;
        return new Chart(canvas, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    data: [],
                    borderColor: color,
                    backgroundColor: color,
                    borderWidth: 1.5,
                    pointRadius: 3,
                    tension: 0.2
                }]
            },
            options: commonOptions
        });
    };

    const voltageChart = createLineChart('voltageChart', '#22c55e');
    const currentChart = createLineChart('currentChart', '#3b82f6');
    const tempChart    = createLineChart('tempChart', '#f97316');
    const powerChart   = createLineChart('powerChart', '#a855f7');

    function updateDashboardChart(chartObj, labelsArr, dataArr) {
        if (!chartObj) return;
        chartObj.data.labels = labelsArr.slice(-MAX_DASHBOARD_POINTS);
        chartObj.data.datasets[0].data = dataArr.slice(-MAX_DASHBOARD_POINTS);
        chartObj.update('none');
    }

    // --------------------------------------
    // 4. Modal Zoom & Pan Logic (Grip / Drag)
    // --------------------------------------
    const modalOverlay = document.getElementById('chartModal');
    const modalTitle = document.getElementById('modalChartTitle');
    const modalCanvas = document.getElementById('zoomedChart');
    let modalChartInstance = null;

    window.openZoomModal = function(chartKey) {
        const keyMap = {
            'voltage': { dataKey: 'voltage', title: 'Voltage History (V)', color: '#22c55e' },
            'current': { dataKey: 'current', title: 'Current History (A)', color: '#3b82f6' },
            'temp':    { dataKey: 'temp',    title: 'Temperature History (°C)', color: '#f97316' },
            'power':   { dataKey: 'power',   title: 'Power Output History (W)', color: '#a855f7' }
        };

        const target = keyMap[chartKey];
        if (!target || !modalOverlay) return;

        if (modalTitle) modalTitle.innerText = target.title;
        modalOverlay.classList.add('active');

        if (modalChartInstance) {
            modalChartInstance.destroy();
            modalChartInstance = null;
        }

        if (modalCanvas) {
            const ctx = modalCanvas.getContext('2d');
            modalChartInstance = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: [...allHistory.labels], // Seluruh jam riwayat
                    datasets: [{
                        label: target.title,
                        data: [...allHistory[target.dataKey]],
                        borderColor: target.color,
                        backgroundColor: target.color,
                        borderWidth: 2,
                        pointRadius: 4,
                        tension: 0.2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: commonOptions.scales,
                    plugins: {
                        legend: { display: false },
                        zoom: {
                            pan: {
                                enabled: true, // Izinkan Geser/Drag/Pan
                                mode: 'x'
                            },
                            zoom: {
                                wheel: { enabled: true },
                                pinch: { enabled: true },
                                mode: 'x'
                            }
                        }
                    }
                }
            });

            // Fokuskan tampilan ke titik data paling baru
            const totalPoints = allHistory.labels.length;
            if (totalPoints > MAX_DASHBOARD_POINTS) {
                modalChartInstance.zoomScale('x', { 
                    min: totalPoints - MAX_DASHBOARD_POINTS, 
                    max: totalPoints - 1 
                }, 'none');
            }
        }
    };

    window.closeZoomModal = function() {
        if (modalOverlay) modalOverlay.classList.remove('active');
        if (modalChartInstance) {
            modalChartInstance.destroy();
            modalChartInstance = null;
        }
    };

    // --------------------------------------
    // 5. Dynamic Cell Voltages Table Renderer
    // --------------------------------------
    function renderCellTable(cellsData) {
        const tbody = document.getElementById('cell-table-body');
        if (!tbody) return;

        if (!cellsData || cellsData.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-center text-gray">Tidak ada data cell.</td></tr>`;
            return;
        }

        let rowsHtml = '';
        cellsData.forEach((voltage, idx) => {
            const cellNum = idx + 1;
            const validVoltage = (voltage !== null && !isNaN(voltage));
            const displayV = validVoltage ? voltage.toFixed(3) : '--';
            
            let percentage = 0;
            if (validVoltage) {
                percentage = Math.min(Math.max(((voltage - 2.5) / (3.65 - 2.5)) * 100, 0), 100);
            }

            let statusBadge = `<span class="badge badge-dark">--</span>`;
            if (validVoltage) {
                if (voltage < 2.8) {
                    statusBadge = `<span class="badge" style="background: rgba(239, 68, 68, 0.2); color: #ef4444;">Low</span>`;
                } else if (voltage > 3.6) {
                    statusBadge = `<span class="badge" style="background: rgba(234, 179, 8, 0.2); color: #eab308;">High</span>`;
                } else {
                    statusBadge = `<span class="badge" style="background: rgba(34, 197, 94, 0.2); color: #22c55e;">Normal</span>`;
                }
            }

            rowsHtml += `
                <tr>
                    <td><strong>Cell ${cellNum}</strong></td>
                    <td><strong>${displayV} V</strong></td>
                    <td>
                        <div style="background: rgba(255,255,255,0.05); height: 8px; border-radius: 4px; overflow: hidden; width: 100%;">
                            <div style="background: #22c55e; width: ${percentage}%; height: 100%; border-radius: 4px; transition: width 0.3s;"></div>
                        </div>
                    </td>
                    <td>${statusBadge}</td>
                </tr>
            `;
        });

        tbody.innerHTML = rowsHtml;
    }

    // --------------------------------------
    // 6. History Logger & Telemetry Log Helper
    // --------------------------------------
    function appendTelemetryRow(totalV, curr, pwr, socVal, tmp) {
        const tbody = document.getElementById('history-log-tbody');
        if (!tbody) return;

        const firstRow = tbody.querySelector('tr');
        if (firstRow && firstRow.children.length === 1) {
            tbody.innerHTML = '';
        }

        const now = new Date();
        const timestamp = now.toLocaleDateString('id-ID') + ' ' + now.toTimeString().split(' ')[0];

        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${timestamp}</td>
            <td>${totalV !== null && !isNaN(totalV) ? totalV.toFixed(2) : '--'}</td>
            <td>${curr !== null && !isNaN(curr) ? curr.toFixed(2) : '--'}</td>
            <td>${pwr !== null && !isNaN(pwr) ? (pwr / 1000).toFixed(3) : '--'}</td>
            <td>${socVal !== null && !isNaN(socVal) ? socVal.toFixed(1) : '--'}</td>
            <td>${tmp !== null && !isNaN(tmp) ? tmp.toFixed(1) : '--'}</td>
        `;

        tbody.prepend(row);

        if (tbody.children.length > 100) {
            tbody.removeChild(tbody.lastChild);
        }
    }

    const btnClearLogs = document.getElementById('btn-clear-logs');
    if (btnClearLogs) {
        btnClearLogs.addEventListener('click', () => {
            const tbody = document.getElementById('history-log-tbody');
            if (tbody) {
                tbody.innerHTML = `<tr><td colspan="6" class="text-center text-gray">Log telah dibersihkan. Menunggu data telemetri baru...</td></tr>`;
            }
        });
    }

    const btnExportExcel = document.getElementById('btn-export-excel');
    if (btnExportExcel) {
        btnExportExcel.addEventListener('click', () => {
            const table = document.getElementById('telemetry-table');
            if (!table) return;

            if (typeof XLSX === 'undefined') {
                alert('Library SheetJS belum dimuat di HTML!');
                return;
            }

            const wb = XLSX.utils.table_to_book(table, { sheet: "Telemetry_Logs" });
            const now = new Date();
            const dateStr = now.toISOString().slice(0, 10);
            const fileName = `BMS_Telemetry_Log_${dateStr}.xlsx`;

            XLSX.writeFile(wb, fileName);
        });
    }

    // --------------------------------------
    // 7. MQTT Connection & Publisher Handler
    // --------------------------------------
    function initMQTTConnection() {
        const bmsBadge = document.getElementById('bms-status-badge');
        if (bmsBadge) {
            bmsBadge.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Connecting...`;
            bmsBadge.className = "badge badge-dark";
        }

        console.log("Connecting to MQTT broker:", MQTT_BROKER);

        const options = {
            clientId: 'polines_hybrid_client_' + Math.random().toString(16).substring(2, 8),
            clean: true,
            connectTimeout: 4000,
            reconnectPeriod: 5000,
        };

        client = mqtt.connect(MQTT_BROKER, options);

        client.on("connect", () => {
            console.log("Connected to MQTT Broker successfully!");
            if (bmsBadge) {
                bmsBadge.style.backgroundColor = '#16a34a';
                bmsBadge.style.color = '#ffffff';
                bmsBadge.innerHTML = `<i class="fa-solid fa-plug"></i> Connected`;
            }

            const topics = [
                `${TOPIC_PREFIX}/status`,
                `${TOPIC_PREFIX}/telemetry`,
                `${TOPIC_PREFIX}/cells`,
                `${TOPIC_PREFIX}/alarms`
            ];

            client.subscribe(topics, (err) => {
                if (!err) {
                    console.log("Subscribed to MQTT topics:", topics);
                } else {
                    console.error("MQTT Subscription failed:", err);
                }
            });
        });

        // Penanganan Pesan Masuk dengan proteksi string mentah
        client.on("message", (topic, payload) => {
            const payloadStr = payload.toString();
            let data = null;

            try {
                data = JSON.parse(payloadStr);
            } catch (e) {
                data = payloadStr; // Tangkap teks biasa (seperti "online") tanpa error
            }

            handleIncomingMQTTData(topic, data);
        });

        client.on("error", (err) => {
            console.error("MQTT Connection Error:", err);
            updateDisconnectedStatus(bmsBadge);
        });

        client.on("offline", () => {
            updateDisconnectedStatus(bmsBadge);
        });
    }

    function updateDisconnectedStatus(bmsBadge) {
        if (bmsBadge) {
            bmsBadge.style.backgroundColor = '#dc2626';
            bmsBadge.style.color = '#ffffff';
            bmsBadge.innerHTML = `<i class="fa-solid fa-plug-circle-xmark"></i> Disconnected`;
        }
    }

    function sendMQTTCommand(subTopic, turnOn) {
        if (client && client.connected) {
            const payload = JSON.stringify({ state: turnOn ? "ON" : "OFF" });
            client.publish(`${TOPIC_PREFIX}/command/${subTopic}`, payload, { qos: 0 }, (err) => {
                if (err) console.error(`Gagal mengirim perintah MQTT ke ${subTopic}:`, err);
            });
        } else {
            console.warn("MQTT belum terhubung! Perintah tidak dapat dikirim.");
        }
    }

    const bindSwitchEvent = (elementId, subTopicName) => {
        const toggleEl = document.getElementById(elementId);
        if (toggleEl) {
            toggleEl.addEventListener('change', (e) => {
                sendMQTTCommand(subTopicName, e.target.checked);
            });
        }
    };

    bindSwitchEvent('chg-mos-toggle', 'charging');
    bindSwitchEvent('dischg-mos-toggle', 'discharging');
    bindSwitchEvent('balance-toggle', 'balancer');

    // --------------------------------------
    // 8. Main Data Update Handler (From MQTT)
    // --------------------------------------
    function handleIncomingMQTTData(topic, data) {
        const now = new Date();
        const currentTimeStr = now.toTimeString().split(' ')[0];

        if (typeof data === 'string') {
            console.log(`Info teks dari topik [${topic}]:`, data);
            return;
        }

        if (topic.includes("telemetry") || topic.includes("status")) {
            const soc = data.soc ?? data.state_of_charge ?? 0;
            const totalVoltage = data.total_voltage ?? data.voltage ?? 0;
            const current = data.current ?? 0;
            const power = data.power ?? (totalVoltage * current);
            const capacity = data.capacity ?? data.capacity_remaining ?? 0;
            
            const maxV = data.max_cell_voltage ?? null;
            const minV = data.min_cell_voltage ?? null;
            const avgV = data.avg_cell_voltage ?? data.average_cell_voltage ?? null;
            const deltaV = data.delta_cell_voltage ?? null;
            const cycles = data.charging_cycles ?? null;
            const temp1 = data.temperature ?? data.temp ?? data.temperature_1 ?? 0;

            const chgState = data.chg_mos ?? data.charging ?? null;
            const dischgState = data.dischg_mos ?? data.discharging ?? null;
            const balState = data.balance_status ?? data.balancer ?? null;

            allHistory.labels.push(currentTimeStr);
            allHistory.voltage.push(totalVoltage || 0);
            allHistory.current.push(current || 0);
            allHistory.temp.push(temp1 || 0);
            allHistory.power.push(power || 0);

            if (allHistory.labels.length > MAX_HISTORY_LIMIT) {
                allHistory.labels.shift();
                allHistory.voltage.shift();
                allHistory.current.shift();
                allHistory.temp.shift();
                allHistory.power.shift();
            }

            updateDashboardChart(voltageChart, allHistory.labels, allHistory.voltage);
            updateDashboardChart(currentChart, allHistory.labels, allHistory.current);
            updateDashboardChart(tempChart, allHistory.labels, allHistory.temp);
            updateDashboardChart(powerChart, allHistory.labels, allHistory.power);

            const socEl = document.getElementById('soc-value');
            const socAlertEl = document.getElementById('soc-alert');
            if (soc !== null && !isNaN(soc)) {
                if (socEl) socEl.innerHTML = `${soc.toFixed(1)}<small>%</small>`;
                const isLow = soc <= 20;
                const gaugeColor = isLow ? '#ef4444' : '#22c55e';
                if (socGauge) {
                    socGauge.data.datasets[0].backgroundColor = [gaugeColor, '#1e293b'];
                    socGauge.data.datasets[0].data = [soc, 100 - soc];
                    socGauge.update();
                }
                if (socAlertEl) socAlertEl.style.display = isLow ? 'inline-flex' : 'none';
            }

            if (totalVoltage !== null && !isNaN(totalVoltage)) {
                const el = document.getElementById('total-voltage-val');
                if (el) el.innerHTML = `${totalVoltage.toFixed(1)} <small>V</small>`;
            }
            if (current !== null && !isNaN(current)) {
                const el = document.getElementById('current-val');
                if (el) el.innerHTML = `${current.toFixed(1)} <small>A</small>`;
            }
            if (capacity !== null && !isNaN(capacity)) {
                const el = document.getElementById('capacity-val');
                if (el) el.innerHTML = `${capacity.toFixed(1)} <small>Ah</small>`;
            }
            if (power !== null && !isNaN(power)) {
                const el = document.getElementById('power-val');
                if (el) el.innerText = `${(power / 1000).toFixed(2)} kW`;
            }

            appendTelemetryRow(totalVoltage, current, power, soc, temp1);

            const setInnerText = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.innerText = val;
            };
            if (maxV !== null && !isNaN(maxV)) setInnerText('max-v-val', `${maxV.toFixed(3)} V`);
            if (minV !== null && !isNaN(minV)) setInnerText('min-v-val', `${minV.toFixed(3)} V`);
            if (avgV !== null && !isNaN(avgV)) setInnerText('avg-v-val', `${avgV.toFixed(3)} V`);
            if (deltaV !== null && !isNaN(deltaV)) setInnerText('delta-v-val', `${deltaV.toFixed(3)} V`);
            if (cycles !== null && !isNaN(cycles)) setInnerText('cycles-val', `${cycles}`);

            const updateSwitch = (statusElId, toggleElId, state) => {
                const statusEl = document.getElementById(statusElId);
                const toggleEl = document.getElementById(toggleElId);
                if (statusEl && toggleEl && state !== null && state !== undefined) {
                    const isON = state === 'ON' || state === true || state === 1;
                    toggleEl.disabled = false;
                    toggleEl.checked = isON;
                    statusEl.innerText = isON ? 'ON' : 'OFF';
                    statusEl.className = isON ? 'text-green' : 'text-gray';
                }
            };
            updateSwitch('chg-mos-status', 'chg-mos-toggle', chgState);
            updateSwitch('dischg-mos-status', 'dischg-mos-toggle', dischgState);
            updateSwitch('balance-status', 'balance-toggle', balState);

        } 
        else if (topic.includes("cells")) {
            const cells = data.cells || data.cell_voltages || [
                data.cell_voltage_1, 
                data.cell_voltage_2, 
                data.cell_voltage_3, 
                data.cell_voltage_4
            ];
            renderCellTable(cells);
        } 
        else if (topic.includes("alarms")) {
            const alarmContainer = document.getElementById('alarm-container');
            const errorsText = data.errors || data.alarms || "";
            if (alarmContainer) {
                if (Array.isArray(errorsText)) {
                    if (errorsText.length === 0) {
                        alarmContainer.innerHTML = `<div class="alarm-item text-green"><i class="fa-solid fa-circle-check"></i> System Normal (No Alarms)</div>`;
                    } else {
                        alarmContainer.innerHTML = errorsText.map(err => `<div class="alarm-item text-red"><i class="fa-solid fa-triangle-exclamation"></i> ${err}</div>`).join('');
                    }
                } else {
                    if (errorsText === "" || errorsText === "OK" || errorsText === "[]") {
                        alarmContainer.innerHTML = `<div class="alarm-item text-green"><i class="fa-solid fa-circle-check"></i> System Normal (No Alarms)</div>`;
                    } else {
                        alarmContainer.innerHTML = `<div class="alarm-item text-red"><i class="fa-solid fa-triangle-exclamation"></i> ${errorsText}</div>`;
                    }
                }
            }
        }
    }

    // --------------------------------------
    // 9. Settings Handler (MQTT Broker Config)
    // --------------------------------------
    const inputEspHost = document.getElementById('setting-host');
    const inputFetchInterval = document.getElementById('setting-interval');
    const btnSaveSettings = document.getElementById('btn-save-settings');

    // Masukkan nilai saat ini ke form input pengaturan
    if (inputEspHost) inputEspHost.value = MQTT_BROKER;
    if (inputFetchInterval) inputFetchInterval.value = FETCH_INTERVAL;

    if (btnSaveSettings) {
        btnSaveSettings.addEventListener('click', () => {
            const newHost = inputEspHost ? inputEspHost.value.trim() : "";
            const newInterval = inputFetchInterval ? inputFetchInterval.value : "";

            if (newHost) {
                // Simpan ke localStorage
                localStorage.setItem('mqtt_broker', newHost);
                localStorage.setItem('mqtt_interval', newInterval);

                alert('Pengaturan MQTT berhasil disimpan! Halaman akan dimuat ulang untuk menerapkan koneksi baru.');
                
                // Refresh halaman agar koneksi terhubung ke broker baru secara otomatis
                location.reload();
            } else {
                alert('Host/Broker MQTT tidak boleh kosong!');
            }
        });
    }

    // Inisialisasi Jalankan Koneksi MQTT
    initMQTTConnection();
});
