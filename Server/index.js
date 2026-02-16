const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', message: 'Professional Events API is running!' });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head><title>Professional Events</title></head>
    <body style="font-family: Arial; text-align: center; padding: 50px;">
      <h1>Professional Events</h1>
      <p>Your event planning app is live!</p>
      <p><a href="/api/health">Check API Health</a></p>
    </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
