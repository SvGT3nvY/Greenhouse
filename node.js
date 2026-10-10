require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

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

    let html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Greenhouse Dashboard</title>
        <meta http-equiv="refresh" content="10">
      </head>
      <body style="font-family: Arial, sans-serif; padding: 2rem; background: #f4f4f9;">
        <h1 style="color: #2c7a7b;">🌱 Greenhouse Dashboard</h1>
        <p>Live sensor data loaded via <b>greenhouseproject.me</b></p>
        <table style="width: 100%; max-width: 750px; border-collapse: collapse; background: white; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
          <tr style="background: #2c7a7b; color: white;">
            <th style="padding: 12px; text-align: left;">Time</th>
            <th style="padding: 12px; text-align: left;">Temp (°C)</th>
            <th style="padding: 12px; text-align: left;">Air Hum (%)</th>
            <th style="padding: 12px; text-align: left;">Soil Hum (%)</th>
          </tr>
    `;

    if (data && data.length > 0) {
      data.forEach(reading => {
        const timeStr = new Date(reading.created_at).toLocaleString('en-US', { timeZone: 'Asia/Manila' });
        const soil = reading.soil_moisture !== null && reading.soil_moisture !== undefined ? reading.soil_moisture : '--';
        
        html += `
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 10px;">${timeStr}</td>
            <td style="padding: 10px;">${reading.temperature}</td>
            <td style="padding: 10px;">${reading.humidity}</td>
            <td style="padding: 10px;">${soil}</td>
          </tr>
        `;
      });
    } else {
      html += `<tr><td colspan="4" style="padding: 15px;">No sensor readings found yet.</td></tr>`;
    }

    html += `</table></body></html>`;
    res.send(html);

  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// 2. Hardware API Endpoint
app.post('/api/sensor-data', async (req, res) => {
  if (!supabase) return res.status(500).json({ error: 'Supabase missing' });

  const { temperature, humidity, soil_moisture } = req.body;

  try {
    const payload = {};
    if (temperature !== undefined) payload.temperature = temperature;
    if (humidity !== undefined) payload.humidity = humidity;
    if (soil_moisture !== undefined) payload.soil_moisture = soil_moisture;

    const { data, error } = await supabase
      .from('sensor_readings')
      .insert([payload]);

    if (error) throw error;

    res.status(200).json({ message: 'Data saved', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
