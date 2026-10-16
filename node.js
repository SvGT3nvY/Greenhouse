require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Allows reading form button clicks

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

// Global variables to track fan state
let fanMode = 'AUTO'; // 'AUTO' or 'MANUAL'
let fanManualState = false; // true = ON, false = OFF

// 1. Dashboard View
app.get('/', async (req, res) => {
  if (!supabase) return res.status(500).send("Supabase credentials missing.");

  try {
    const { data, error } = await supabase
      .from('sensor_readings')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    // Determine what the fan should currently be doing
    let currentTemp = (data && data.length > 0) ? data[0].temperature : 0;
    let actualFanState = false;
    if (fanMode === 'AUTO') {
      actualFanState = (currentTemp > 30.0);
    } else {
      actualFanState = fanManualState;
    }

    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Greenhouse Dashboard</title>
        <meta http-equiv="refresh" content="10">
      </head>
      <body style="font-family: Arial, sans-serif; padding: 2rem; background: #f4f4f9;">
        <h1 style="color: #2c7a7b;">🌱 Greenhouse Dashboard</h1>
        
        <!-- FAN CONTROL PANEL -->
        <div style="background: white; padding: 20px; max-width: 910px; margin-bottom: 20px; box-shadow: 0 2px 5px rgba(0,0,0,0.1); border-radius: 8px;">
          <h2 style="margin-top: 0;">⚙️ Fan Control Panel</h2>
          <p style="font-size: 18px;">Current Status: <b>${actualFanState ? '🟢 SPINNING (ON)' : '🔴 STOPPED (OFF)'}</b> | Mode: <b>${fanMode}</b></p>
          
          <form action="/api/set-fan" method="POST" style="display:inline;">
            <input type="hidden" name="mode" value="AUTO">
            <button type="submit" style="padding: 10px 15px; background: #2c7a7b; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; margin-right: 10px;">🤖 Set AUTO (Triggers at >30°C)</button>
          </form>
          <form action="/api/set-fan" method="POST" style="display:inline;">
            <input type="hidden" name="mode" value="MANUAL_ON">
            <button type="submit" style="padding: 10px 15px; background: #27ae60; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold; margin-right: 10px;">🟢 Force ON</button>
          </form>
          <form action="/api/set-fan" method="POST" style="display:inline;">
            <input type="hidden" name="mode" value="MANUAL_OFF">
            <button type="submit" style="padding: 10px 15px; background: #c0392b; color: white; border: none; cursor: pointer; border-radius: 4px; font-weight: bold;">🔴 Force OFF</button>
          </form>
        </div>

        <table style="width: 100%; max-width: 950px; border-collapse: collapse; background: white; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
          <tr style="background: #2c7a7b; color: white;">
            <th style="padding: 12px; text-align: left;">Time</th>
            <th style="padding: 12px; text-align: left;">Temp (°C)</th>
            <th style="padding: 12px; text-align: left;">Air Hum (%)</th>
            <th style="padding: 12px; text-align: left;">Soil Hum 1 (%)</th>
            <th style="padding: 12px; text-align: left;">Soil Hum 2 (%)</th>
            <th style="padding: 12px; text-align: left;">Water Level</th>
          </tr>
    `;

    if (data && data.length > 0) {
      data.forEach(reading => {
        const timeStr = new Date(reading.created_at).toLocaleString('en-US', { timeZone: 'Asia/Manila' });
        const soil = reading.soil_moisture !== null && reading.soil_moisture !== undefined ? reading.soil_moisture : '--';
        const soil2 = reading.soil_moisture_2 !== null && reading.soil_moisture_2 !== undefined ? reading.soil_moisture_2 : '--';
        const water = reading.water_level !== null && reading.water_level !== undefined ? reading.water_level : '--';
        
        html += `
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 10px;">${timeStr}</td>
            <td style="padding: 10px;">${reading.temperature}</td>
            <td style="padding: 10px;">${reading.humidity}</td>
            <td style="padding: 10px;">${soil}</td>
            <td style="padding: 10px;">${soil2}</td>
            <td style="padding: 10px;">${water}</td>
          </tr>
        `;
      });
    } else {
      html += `<tr><td colspan="6" style="padding: 15px;">No sensor readings found yet.</td></tr>`;
    }

    html += `</table></body></html>`;
    res.send(html);

  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// 2. Dashboard Button Handler
app.post('/api/set-fan', (req, res) => {
  const mode = req.body.mode;
  if (mode === 'AUTO') {
    fanMode = 'AUTO';
  } else if (mode === 'MANUAL_ON') {
    fanMode = 'MANUAL';
    fanManualState = true;
  } else if (mode === 'MANUAL_OFF') {
    fanMode = 'MANUAL';
    fanManualState = false;
  }
  res.redirect('/'); // Refresh the page to show the new state
});

// 3. Hardware API Endpoint
app.post('/api/sensor-data', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase missing' });

  const { temperature, humidity, soil_moisture, soil_moisture_2, water_level } = req.body;

  // Determine what the ESP32 fan should do based on mode
  let shouldFanBeOn = false;
  if (fanMode === 'AUTO') {
    shouldFanBeOn = (temperature > 30.0);
  } else {
    shouldFanBeOn = fanManualState;
  }

  try {
    const payload = {};
    if (temperature !== undefined) payload.temperature = temperature;
    if (humidity !== undefined) payload.humidity = humidity;
    if (soil_moisture !== undefined) payload.soil_moisture = soil_moisture;
    if (soil_moisture_2 !== undefined) payload.soil_moisture_2 = soil_moisture_2;
    if (water_level !== undefined) payload.water_level = water_level;

    const { data, error } = await supabase
      .from('sensor_readings')
      .insert([payload]);

    if (error) throw error;

    // Send the required fan state back to the ESP32
    res.status(200).json({ 
      message: 'Data saved', 
      fan_state: shouldFanBeOn ? 'ON' : 'OFF' 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
