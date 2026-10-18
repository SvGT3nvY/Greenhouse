require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// Global Variables
let fanMode = 'AUTO'; let fanManualState = false;
let pumpMode = 'AUTO'; let pumpManualState = false;
let lightMode = 'AUTO'; let lightManualState = false;

app.get('/', async (req, res) => {
  if (!supabase) return res.status(500).send("Supabase credentials missing.");

  try {
    // Fetch last 15 readings for the charts
    const { data, error } = await supabase
      .from('sensor_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(15);

    if (error) throw error;

    let currentTemp = (data && data.length > 0) ? data[0].temperature : 0;
    let currentSoil = (data && data.length > 0) ? data[0].soil_moisture : 100;
    let currentLight = (data && data.length > 0) ? data[0].light_level : 1000;

    // Auto-Logic Rules (Dry-run protection removed)
    let actualFanState = (fanMode === 'AUTO') ? (currentTemp > 30.0) : fanManualState;
    let actualPumpState = (pumpMode === 'AUTO') ? (currentSoil < 40) : pumpManualState;
    let actualLightState = (lightMode === 'AUTO') ? (currentLight < 500) : lightManualState;

    // Reverse data for the charts (oldest to newest left-to-right)
    let chartData = data ? [...data].reverse() : [];

    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Pro Greenhouse Dashboard</title>
        <meta http-equiv="refresh" content="30">
        <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        <style>
          body { font-family: Arial; padding: 2rem; background: #f4f4f9; }
          .panel { background: white; padding: 20px; max-width: 1050px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); border-radius: 8px; }
          .btn { padding: 10px; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; }
          .chart-container { display: flex; gap: 20px; max-width: 1050px; margin-bottom: 20px; }
          .chart-box { background: white; padding: 20px; flex: 1; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
          table { width: 100%; max-width: 1050px; border-collapse: collapse; background: white; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
          th { padding: 12px; text-align: left; background: #2c7a7b; color: white; }
          td { padding: 10px; border-bottom: 1px solid #ddd; }
        </style>
      </head>
      <body>
        <h1 style="color: #2c7a7b;">🌱 Professional Greenhouse Dashboard</h1>
        
        <!-- CHARTS SECTION -->
        <div class="chart-container">
          <div class="chart-box">
            <h3>Temperature & Humidity</h3>
            <canvas id="tempChart"></canvas>
          </div>
          <div class="chart-box">
            <h3>Soil Moisture & Light</h3>
            <canvas id="soilChart"></canvas>
          </div>
        </div>

        <!-- CONTROL PANELS -->
        <div class="panel">
          <h2 style="margin-top: 0;">💨 Fans (Relay 1 & 2)</h2>
          <p>Status: <b>${actualFanState ? '🟢 ON' : '🔴 OFF'}</b> | Mode: <b>${fanMode}</b></p>
          <form action="/api/set-fan" method="POST" style="display:inline;"><input type="hidden" name="mode" value="AUTO"><button type="submit" class="btn" style="background: #2c7a7b;">🤖 Set AUTO (>30.0°C)</button></form>
          <form action="/api/set-fan" method="POST" style="display:inline;"><input type="hidden" name="mode" value="MANUAL_ON"><button type="submit" class="btn" style="background: #27ae60;">🟢 Force ON</button></form>
          <form action="/api/set-fan" method="POST" style="display:inline;"><input type="hidden" name="mode" value="MANUAL_OFF"><button type="submit" class="btn" style="background: #c0392b;">🔴 Force OFF</button></form>
        </div>

        <div class="panel">
          <h2 style="margin-top: 0;">💧 Water Pump (Relay 3)</h2>
          <p>Status: <b>${actualPumpState ? '🟢 PUMPING' : '🔴 STOPPED'}</b> | Mode: <b>${pumpMode}</b></p>
          <form action="/api/set-pump" method="POST" style="display:inline;"><input type="hidden" name="mode" value="AUTO"><button type="submit" class="btn" style="background: #2980b9;">🤖 Set AUTO (Soil < 40%)</button></form>
          <form action="/api/set-pump" method="POST" style="display:inline;"><input type="hidden" name="mode" value="MANUAL_ON"><button type="submit" class="btn" style="background: #27ae60;">🟢 Force ON</button></form>
          <form action="/api/set-pump" method="POST" style="display:inline;"><input type="hidden" name="mode" value="MANUAL_OFF"><button type="submit" class="btn" style="background: #c0392b;">🔴 Force OFF</button></form>
        </div>

        <div class="panel">
          <h2 style="margin-top: 0;">💡 White LED Light (Relay 4)</h2>
          <p>Status: <b>${actualLightState ? '🟢 ON' : '🔴 OFF'}</b> | Mode: <b>${lightMode}</b></p>
          <form action="/api/set-light" method="POST" style="display:inline;"><input type="hidden" name="mode" value="AUTO"><button type="submit" class="btn" style="background: #8e44ad;">🤖 Set AUTO (Lux < 500)</button></form>
          <form action="/api/set-light" method="POST" style="display:inline;"><input type="hidden" name="mode" value="MANUAL_ON"><button type="submit" class="btn" style="background: #27ae60;">🟢 Force ON</button></form>
          <form action="/api/set-light" method="POST" style="display:inline;"><input type="hidden" name="mode" value="MANUAL_OFF"><button type="submit" class="btn" style="background: #c0392b;">🔴 Force OFF</button></form>
        </div>

        <!-- SENSOR DATA TABLE -->
        <table>
          <tr><th>Time</th><th>Temp (°C)</th><th>Hum (%)</th><th>Soil 1 (%)</th><th>Soil 2 (%)</th><th>Water Level</th><th>Light (lux)</th></tr>
    `;

    if (data && data.length > 0) {
      data.forEach(reading => {
        html += <tr><td>${new Date(reading.created_at).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila' })}</td><td>${reading.temperature}</td><td>${reading.humidity}</td><td>${reading.soil_moisture ?? '--'}</td><td>${reading.soil_moisture_2 ?? '--'}</td><td>${reading.water_level ?? '--'}</td><td>${reading.light_level ?? '--'}</td></tr>;
      });
    }

    html += `
        </table>
        <script>
          const rawData = ${JSON.stringify(chartData)};
          const labels = rawData.map(d => new Date(d.created_at).toLocaleTimeString('en-US', { timeZone: 'Asia/Manila', hour: '2-digit', minute:'2-digit' }));
          
          new Chart(document.getElementById('tempChart'), {
            type: 'line',
            data: {
              labels: labels,
              datasets: [
                { label: 'Temp (°C)', data: rawData.map(d => d.temperature), borderColor: '#e74c3c', tension: 0.3 },
                { label: 'Humidity (%)', data: rawData.map(d => d.humidity), borderColor: '#3498db', tension: 0.3 }
              ]
            }
          });

          new Chart(document.getElementById('soilChart'), {
            type: 'line',
            data: {
              labels: labels,
              datasets: [
                { label: 'Soil 1 (%)', data: rawData.map(d => d.soil_moisture), borderColor: '#8e44ad', tension: 0.3 },
                { label: 'Light (/10 lux)', data: rawData.map(d => (d.light_level/10)), borderColor: '#f1c40f', tension: 0.3 }
              ]
            }
          });
        </script>
      </body>
      </html>
    `;
    res.send(html);
  } catch (err) { res.status(500).send(Error: ${err.message}); }
});

// Button Handlers
app.post('/api/set-fan', (req, res) => { const m = req.body.mode; if(m==='AUTO') fanMode='AUTO'; else { fanMode='MANUAL'; fanManualState=(m==='MANUAL_ON'); } res.redirect('/'); });
app.post('/api/set-pump', (req, res) => { const m = req.body.mode; if(m==='AUTO') pumpMode='AUTO'; else { pumpMode='MANUAL'; pumpManualState=(m==='MANUAL_ON'); } res.redirect('/'); });
app.post('/api/set-light', (req, res) => { const m = req.body.mode; if(m==='AUTO') lightMode='AUTO'; else { lightMode='MANUAL'; lightManualState=(m==='MANUAL_ON'); } res.redirect('/'); });

// Hardware API Endpoint
app.post('/api/sensor-data', async (req, res) => {
  const { temperature, humidity, soil_moisture, soil_moisture_2, water_level, light_level } = req.body;

  let shouldFanBeOn = (fanMode === 'AUTO') ? (temperature > 30.0) : fanManualState;
  let shouldPumpBeOn = (pumpMode === 'AUTO') ? (soil_moisture < 40) : pumpManualState;
  let shouldLightBeOn = (lightMode === 'AUTO') ? (light_level < 500) : lightManualState;

  try {
    const payload = {};
    if (temperature !== undefined) payload.temperature = temperature;
    if (humidity !== undefined) payload.humidity = humidity;
    if (soil_moisture !== undefined) payload.soil_moisture = soil_moisture;
    if (soil_moisture_2 !== undefined) payload.soil_moisture_2 = soil_moisture_2;
    if (water_level !== undefined) payload.water_level = water_level;
    if (light_level !== undefined) payload.light_level = light_level;

    await supabase.from('sensor_readings').insert([payload]);

    res.status(200).json({ 
      fan_state: shouldFanBeOn ? 'ON' : 'OFF',
      pump_state: shouldPumpBeOn ? 'ON' : 'OFF',
      light_state: shouldLightBeOn ? 'ON' : 'OFF'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(Server running on port ${PORT}));
