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
          <form action="/api/set-pump" method="POST" style="display:inline;"><input type="hidden" name="mode" value="MANUAL_OFF"><button type="submit" class="btn" style="background: #c0392b;">🔴 Force OFF</button></
