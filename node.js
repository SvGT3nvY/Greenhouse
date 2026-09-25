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

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running!");
});
