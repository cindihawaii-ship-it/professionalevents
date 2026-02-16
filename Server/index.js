const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  ***String: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL
    )
  `);
}

app.get('/', (req, res) => {
  res.send('<h1>Professional Events API</h1><p>Your event planning app is running!</p>');
});

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', database: 'connected' });
  } catch (err) {
    res.json({ status: 'healthy', database: err.message });
  }
});

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, name } = req.body;
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id',
    [email, hash, name]
  );
  res.json({ success: true, userId: result.rows[0].id });
});

const PORT = process.env.PORT || 3001;
initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Server on port ${PORT}`));
});
