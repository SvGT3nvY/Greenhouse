require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// Safely initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
} else {
  console.error("WARNING: SUPABASE_URL or SUPABASE_KEY environment variables are missing!");
}

// Visual Dashboard Endpoint
app.get('/', async (req, res) => {
  if (!supabase) {
    return res.status(500).send("Server Error: Supabase credentials are not configured in Render Environment settings.");
  }

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
        <table style="width: 100%; max-width: 650px; border-collapse: collapse; background: white; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
          <tr style="background: #2c7a7b; color: white;">
            <th style="padding: 12px; text-align: left;">Time</th>
            <th style="padding: 12px; text-align: left;">Temp (°C)</th>
            <th style="padding: 12px; text-align: left;">Humidity (%)</th>
          </tr>
    `;

    if (data && data.length > 0) {
      data.forEach(reading => {
        html += `
          <tr style="border-bottom: 1px solid #ddd;">
            <td style="padding: 10px;">${new Date(reading.created_at).toLocaleString()}</td>
            <td style="padding: 10px;">${reading.temperature}</td>
            <td style="padding: 10px;">${reading.humidity}</td>
          </tr>
        `;
      });
    } else {
      html += `<tr><td colspan="3" style="padding: 15px;">No sensor readings found yet.</td></tr>`;
    }

    html += `</table></body></html>`;
    res.send(html);

  } catch (err) {
    res.status(500).send(`Error fetching greenhouse data: ${err.message || JSON.stringify(err)}`);
  }
});

// Hardware Sensor Endpoint
app.post('/api/sensor-data', async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: 'Supabase credentials missing' });
  }

  const { temperature, humidity } = req.body;

  if (temperature === undefined || humidity === undefined) {
    return res.status(400).json({ error: 'Missing temperature or humidity' });
  }

  try {
    const { data, error } = await supabase
      .from('sensor_readings')
      .insert([{ temperature, humidity }]);

    if (error) throw error;

    res.status(200).json({ message: 'Data saved successfully', data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
