const express = require('express');
const app = express();
app.use(express.json()); // Allows server to read JSON from ESP32

app.post('/api/sensor-data', async (req, res) => {
    const { temperature, humidity } = req.body;
    
    // Logic to insert temperature & humidity into your PostgreSQL database goes here
    
    console.log(`Received: Temp ${temperature}, Hum ${humidity}`);
    res.status(200).send("Data saved successfully!");
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Server is running!");
});
