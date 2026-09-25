const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Connect to Supabase using Render's environment variable
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.post('/api/sensor-data', async (req, res) => {
  const { temperature, humidity } = req.body;

  try {
    // Insert data into a table named sensor_readings
    await pool.query(
      'INSERT INTO sensor_readings (temperature, humidity) VALUES ($1, $2)',
      [temperature, humidity]
    );
    console.log(`Saved: Temp ${temperature}°C, Hum ${humidity}%`);
    res.status(200).send("Data saved to Supabase successfully!");
  } catch (err) {
    console.error("Database Error:", err);
    res.status(500).send("Failed to save data");
  }
});

// This tells the server what to show when someone visits the home page in a browser
app.get('/', async (req, res) => {
  try {
    // Fetch the 10 most recent readings from Supabase
    const { data, error } = await supabase
      .from('sensor_readings') // Make sure this matches your actual table name!
      .select('*')
      .order('created_at', { ascending: false })
      .limit(10);

    if (error) throw error;

    // Build a simple HTML webpage to display the data
    let html = `
      <body style="font-family: Arial, sans-serif; padding: 2rem; background: #f4f4f9;">
        <h1 style="color: #2c7a7b;">🌱 Greenhouse Dashboard</h1>
        <p>Live sensor data routed through greenhouseproject.me</p>
        <table style="width: 100%; max-width: 600px; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.2);">
          <tr style="background: #2c7a7b; color: white;">
            <th style="padding: 10px; text-align: left;">Time</th>
            <th style="padding: 10px; text-align: left;">Temp (°C)</th>
            <th style="padding: 10px; text-align: left;">Humidity (%)</th>
          </tr>
    `;

    // Add each reading as a row in the table
    data.forEach(reading => {
      html += `
        <tr style="border-bottom: 1px solid #ddd;">
          <td style="padding: 10px;">${new Date(reading.created_at).toLocaleString()}</td>
          <td style="padding: 10px;">${reading.temperature}</td>
          <td style="padding: 10px;">${reading.humidity}</td>
        </tr>
      `;
    });

    html += `</table></body>`;
    
    res.send(html);

  } catch (err) {
    res.status(500).send("Error fetching greenhouse data");
  }
});


app.listen(process.env.PORT || 3000, () => {
  console.log("Server running!");
});
