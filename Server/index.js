const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();

// ---------------------------------------------------------------------------
// Security & Middleware
// ---------------------------------------------------------------------------

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Global rate limiter: 200 requests per 15 min window per IP
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', globalLimiter);

// Strict rate limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts. Please wait and try again.' },
});

// ---------------------------------------------------------------------------
// Serve Static Frontend (dist directory)
// ---------------------------------------------------------------------------

const distDir = path.join(__dirname, '..', 'dist');
app.use(express.static(distDir, {
  maxAge: '1d',
  etag: true,
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// Serve PWA manifest
app.get('/manifest.json', (_req, res) => {
  res.json({
    name: 'Event Planner Pro',
    short_name: 'EventPro',
    description: 'Curated vendor discovery for beautiful events',
    start_url: '/',
    display: 'standalone',
    background_color: '#faf8f5',
    theme_color: '#d4b896',
    orientation: 'portrait',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ],
  });
});

// Serve a basic service worker
app.get('/sw.js', (_req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(`
const CACHE_NAME = 'eventpro-v1';
const ASSETS = ['/', '/index.html'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    )
  );
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
  `.trim());
});

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://localhost/eventplanner',
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('postgresql://')
    ? { rejectUnauthorized: false }
    : false,
});

// Auto-create tables on startup
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        subscription_tier VARCHAR(50) DEFAULT 'free',
        stripe_customer_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        type VARCHAR(50) NOT NULL,
        location VARCHAR(255) NOT NULL,
        date DATE NOT NULL,
        guests INTEGER,
        budget VARCHAR(50),
        categories JSONB,
        max_distance VARCHAR(50),
        min_rating DECIMAL(2,1),
        requirements TEXT,
        status VARCHAR(50) DEFAULT 'planning',
        progress INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS saved_vendors (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        vendor_name VARCHAR(255) NOT NULL,
        category VARCHAR(100) NOT NULL,
        location VARCHAR(255),
        rating DECIMAL(2,1),
        reviews INTEGER,
        price_range VARCHAR(50),
        contact VARCHAR(255),
        website VARCHAR(255),
        notes TEXT,
        place_id VARCHAR(255),
        contacted BOOLEAN DEFAULT false,
        booked BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        vendor_id INTEGER REFERENCES saved_vendors(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        type VARCHAR(100) NOT NULL,
        date DATE NOT NULL,
        time TIME NOT NULL,
        notes TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        reminder_sent BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS checklist_items (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        category VARCHAR(100),
        due_date DATE,
        completed BOOLEAN DEFAULT false,
        completed_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables initialized successfully');
  } catch (err) {
    console.warn('Database initialization skipped (tables may already exist):', err.message);
  }
}

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// ---------------------------------------------------------------------------
// Auth Middleware
// ---------------------------------------------------------------------------

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = decoded;
    next();
  });
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), database: 'connected' });
  } catch {
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), database: 'disconnected' });
  }
});

// ---------------------------------------------------------------------------
// AUTH Routes
// ---------------------------------------------------------------------------

app.post('/api/auth/signup', authLimiter, async (req, res) => {
  try {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING id, email, name, subscription_tier',
      [email.toLowerCase(), hashedPassword, name]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user });
  } catch (error) {
    console.error('Signup error:', error.message);
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, subscription_tier: user.subscription_tier },
    });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, name, subscription_tier, created_at FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// EVENT Routes
// ---------------------------------------------------------------------------

app.post('/api/events', authenticateToken, async (req, res) => {
  try {
    const { eventName, eventType, location, date, guests, budget, categories, maxDistance, minRating, requirements } = req.body;
    if (!eventName || !eventType || !location || !date) {
      return res.status(400).json({ error: 'Event name, type, location, and date are required' });
    }

    const result = await pool.query(
      `INSERT INTO events (user_id, name, type, location, date, guests, budget, categories, max_distance, min_rating, requirements)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [req.user.userId, eventName, eventType, location, date, guests || 0, budget, JSON.stringify(categories || []), maxDistance, minRating, requirements]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create event error:', error.message);
    res.status(500).json({ error: 'Failed to create event' });
  }
});

app.get('/api/events', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM events WHERE user_id = $1 ORDER BY date DESC',
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/events/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM events WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/events/:id', authenticateToken, async (req, res) => {
  try {
    const { name, type, location, date, guests, budget, status, progress } = req.body;
    const result = await pool.query(
      `UPDATE events SET
        name = COALESCE($1, name), type = COALESCE($2, type), location = COALESCE($3, location),
        date = COALESCE($4, date), guests = COALESCE($5, guests), budget = COALESCE($6, budget),
        status = COALESCE($7, status), progress = COALESCE($8, progress), updated_at = CURRENT_TIMESTAMP
       WHERE id = $9 AND user_id = $10 RETURNING *`,
      [name, type, location, date, guests, budget, status, progress, req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/events/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM events WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Event not found' });
    res.json({ message: 'Event deleted', id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// VENDOR Routes
// ---------------------------------------------------------------------------

app.post('/api/vendors/save', authenticateToken, async (req, res) => {
  try {
    const { eventId, vendorData } = req.body;
    if (!vendorData || !vendorData.name || !vendorData.category) {
      return res.status(400).json({ error: 'Vendor name and category are required' });
    }

    const result = await pool.query(
      `INSERT INTO saved_vendors
       (user_id, event_id, vendor_name, category, location, rating, reviews, price_range, contact, website, notes, place_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [
        req.user.userId, eventId || null, vendorData.name, vendorData.category,
        vendorData.location || '', vendorData.rating || null, vendorData.reviews || 0,
        vendorData.priceRange || '', vendorData.contact || '', vendorData.website || '',
        vendorData.notes || '', vendorData.placeId || null,
      ]
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Save vendor error:', error.message);
    res.status(500).json({ error: 'Failed to save vendor' });
  }
});

app.get('/api/vendors/saved', authenticateToken, async (req, res) => {
  try {
    const { eventId } = req.query;
    let query = 'SELECT * FROM saved_vendors WHERE user_id = $1';
    const params = [req.user.userId];

    if (eventId) {
      query += ' AND event_id = $2';
      params.push(eventId);
    }
    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/vendors/:id/notes', authenticateToken, async (req, res) => {
  try {
    const { notes } = req.body;
    const result = await pool.query(
      'UPDATE saved_vendors SET notes = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING *',
      [notes, req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/vendors/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM saved_vendors WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
    res.json({ message: 'Vendor removed', id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GOOGLE PLACES Vendor Search
// ---------------------------------------------------------------------------

const GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY;

const CATEGORY_SEARCH_TERMS = {
  venue: 'wedding venue event venue banquet hall',
  catering: 'catering service wedding caterer',
  photography: 'wedding photographer event photographer',
  videography: 'wedding videographer event videographer',
  music: 'wedding DJ live band music entertainment',
  florist: 'wedding florist flower arrangement',
  planner: 'wedding planner event coordinator',
  transport: 'wedding limousine transportation service',
  cake: 'wedding cake bakery custom cake',
};

app.post('/api/vendors/search', authenticateToken, async (req, res) => {
  try {
    const { location, categories, budget, minRating } = req.body;

    if (!GOOGLE_PLACES_API_KEY || GOOGLE_PLACES_API_KEY === 'your_google_places_key') {
      // Return curated sample vendors when no API key is configured
      return res.json(generateSampleVendors(location, categories, minRating));
    }

    const allResults = [];

    for (const category of (categories || ['venue'])) {
      const searchTerm = CATEGORY_SEARCH_TERMS[category] || category;
      const query = `${searchTerm} in ${location || 'San Francisco'}`;

      try {
        const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${GOOGLE_PLACES_API_KEY}`;
        const response = await fetch(url);
        const data = await response.json();

        if (data.results) {
          for (const place of data.results.slice(0, 5)) {
            if (minRating && place.rating < parseFloat(minRating)) continue;

            let priceRange = '$';
            if (place.price_level === 2) priceRange = '$$';
            else if (place.price_level === 3) priceRange = '$$$';
            else if (place.price_level >= 4) priceRange = '$$$$';

            allResults.push({
              name: place.name,
              category,
              location: place.formatted_address || location,
              rating: place.rating || 0,
              reviews: place.user_ratings_total || 0,
              priceRange,
              placeId: place.place_id,
              contact: '',
              website: '',
            });
          }
        }
      } catch (err) {
        console.warn(`Google Places search failed for ${category}:`, err.message);
      }
    }

    res.json(allResults);
  } catch (error) {
    console.error('Vendor search error:', error.message);
    res.status(500).json({ error: 'Vendor search failed' });
  }
});

// Fetch details for a specific place
app.get('/api/vendors/place/:placeId', authenticateToken, async (req, res) => {
  try {
    if (!GOOGLE_PLACES_API_KEY || GOOGLE_PLACES_API_KEY === 'your_google_places_key') {
      return res.status(400).json({ error: 'Google Places API key not configured' });
    }

    const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${req.params.placeId}&fields=name,formatted_address,formatted_phone_number,website,rating,reviews,opening_hours,photos,price_level&key=${GOOGLE_PLACES_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.result) {
      res.json({
        name: data.result.name,
        address: data.result.formatted_address,
        phone: data.result.formatted_phone_number || '',
        website: data.result.website || '',
        rating: data.result.rating || 0,
        reviews: (data.result.reviews || []).slice(0, 5).map(r => ({
          author: r.author_name,
          rating: r.rating,
          text: r.text,
          time: r.relative_time_description,
        })),
      });
    } else {
      res.status(404).json({ error: 'Place not found' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

function generateSampleVendors(location, categories, minRating) {
  const loc = location || 'San Francisco, CA';
  const vendors = [];
  const sampleData = {
    venue: [
      { name: 'Golden Gate Club', rating: 5.0, reviews: 248, priceRange: '$$$' },
      { name: 'The Conservatory', rating: 4.8, reviews: 182, priceRange: '$$$$' },
      { name: 'Bayview Estate', rating: 4.7, reviews: 135, priceRange: '$$$' },
    ],
    catering: [
      { name: 'On The Roll Catering', rating: 4.9, reviews: 312, priceRange: '$$' },
      { name: 'Farm & Table Co.', rating: 4.8, reviews: 198, priceRange: '$$$' },
      { name: 'Savory Events', rating: 4.6, reviews: 167, priceRange: '$$' },
    ],
    photography: [
      { name: 'Avery Wong Photography', rating: 5.0, reviews: 156, priceRange: '$$$' },
      { name: 'Light & Bloom Studio', rating: 4.9, reviews: 203, priceRange: '$$' },
      { name: 'Captured Moments', rating: 4.7, reviews: 124, priceRange: '$$' },
    ],
    videography: [
      { name: 'Cinematic Stories', rating: 4.9, reviews: 98, priceRange: '$$$' },
      { name: 'Frame by Frame Films', rating: 4.8, reviews: 87, priceRange: '$$' },
    ],
    music: [
      { name: 'Harmony Live Band', rating: 4.8, reviews: 145, priceRange: '$$' },
      { name: 'DJ Elara', rating: 4.9, reviews: 234, priceRange: '$$' },
    ],
    florist: [
      { name: 'Petal & Stem', rating: 5.0, reviews: 178, priceRange: '$$' },
      { name: 'Garden of Eve Florals', rating: 4.8, reviews: 142, priceRange: '$$$' },
    ],
    planner: [
      { name: 'Grace & Gather Events', rating: 5.0, reviews: 92, priceRange: '$$$' },
      { name: 'Elegant Affairs Co.', rating: 4.9, reviews: 116, priceRange: '$$$$' },
    ],
    transport: [
      { name: 'Premier Limousine', rating: 4.7, reviews: 201, priceRange: '$$' },
    ],
    cake: [
      { name: 'Sweet Layers Bakery', rating: 5.0, reviews: 267, priceRange: '$$' },
      { name: 'Flour & Fondant', rating: 4.8, reviews: 189, priceRange: '$$$' },
    ],
  };

  for (const cat of (categories || ['venue'])) {
    const items = sampleData[cat] || [];
    for (const item of items) {
      if (minRating && item.rating < parseFloat(minRating)) continue;
      vendors.push({ ...item, category: cat, location: loc, contact: '', website: '' });
    }
  }
  return vendors;
}

// ---------------------------------------------------------------------------
// APPOINTMENT Routes
// ---------------------------------------------------------------------------

app.post('/api/appointments', authenticateToken, async (req, res) => {
  try {
    const { vendorId, eventId, type, date, time, notes } = req.body;
    if (!type || !date || !time) {
      return res.status(400).json({ error: 'Type, date, and time are required' });
    }

    const result = await pool.query(
      `INSERT INTO appointments (user_id, vendor_id, event_id, type, date, time, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending') RETURNING *`,
      [req.user.userId, vendorId || null, eventId || null, type, date, time, notes || '']
    );
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Create appointment error:', error.message);
    res.status(500).json({ error: 'Failed to create appointment' });
  }
});

app.get('/api/appointments', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT a.*, sv.vendor_name, sv.category
       FROM appointments a
       LEFT JOIN saved_vendors sv ON a.vendor_id = sv.id
       WHERE a.user_id = $1
       ORDER BY a.date, a.time`,
      [req.user.userId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/appointments/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const result = await pool.query(
      'UPDATE appointments SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 AND user_id = $3 RETURNING *',
      [status, req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/appointments/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM appointments WHERE id = $1 AND user_id = $2 RETURNING id',
      [req.params.id, req.user.userId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ message: 'Appointment deleted', id: result.rows[0].id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// STRIPE Payment / Subscription Routes
// ---------------------------------------------------------------------------

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
let stripe = null;

if (STRIPE_SECRET_KEY && STRIPE_SECRET_KEY !== 'sk_test_your_stripe_key') {
  stripe = require('stripe')(STRIPE_SECRET_KEY);
}

const PRICE_MAP = {
  professional: 2900,   // $29 one-time per event
  premier: 9900,         // $99/year
};

app.post('/api/stripe/create-checkout-session', authenticateToken, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(400).json({ error: 'Stripe is not configured. Set STRIPE_SECRET_KEY in your environment.' });
    }

    const { plan } = req.body;
    if (!PRICE_MAP[plan]) {
      return res.status(400).json({ error: 'Invalid plan selected' });
    }

    const user = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.userId]);
    if (user.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    let customerId = user.rows[0].stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.rows[0].email,
        name: user.rows[0].name,
        metadata: { userId: String(req.user.userId) },
      });
      customerId = customer.id;
      await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, req.user.userId]);
    }

    const sessionParams = {
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Event Planner Pro - ${plan.charAt(0).toUpperCase() + plan.slice(1)}`,
            description: plan === 'premier' ? 'Annual subscription with unlimited events' : 'Professional plan per event',
          },
          unit_amount: PRICE_MAP[plan],
          ...(plan === 'premier' ? { recurring: { interval: 'year' } } : {}),
        },
        quantity: 1,
      }],
      mode: plan === 'premier' ? 'subscription' : 'payment',
      success_url: `${req.headers.origin || 'http://localhost:3001'}/?payment=success&plan=${plan}`,
      cancel_url: `${req.headers.origin || 'http://localhost:3001'}/?payment=cancelled`,
      metadata: { userId: String(req.user.userId), plan },
    };

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Stripe checkout error:', error.message);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(400).json({ error: 'Stripe not configured' });

  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  try {
    let event;
    if (endpointSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan;
        if (userId && plan) {
          await pool.query('UPDATE users SET subscription_tier = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [plan, userId]);
        }
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const customerId = sub.customer;
        await pool.query("UPDATE users SET subscription_tier = 'free', updated_at = CURRENT_TIMESTAMP WHERE stripe_customer_id = $1", [customerId]);
        break;
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.status(400).json({ error: 'Webhook processing failed' });
  }
});

app.get('/api/stripe/config', (_req, res) => {
  res.json({
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || null,
    configured: !!(stripe),
  });
});

// ---------------------------------------------------------------------------
// SPA Fallback: serve index.html for all non-API routes
// ---------------------------------------------------------------------------

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  res.sendFile(path.join(distDir, 'index.html'));
});

// ---------------------------------------------------------------------------
// Global Error Handler
// ---------------------------------------------------------------------------

app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3001;

async function start() {
  await initializeDatabase();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Event Planner Pro server running on port ${PORT}`);
    console.log(`Serving frontend from ${distDir}`);
    console.log(`Stripe: ${stripe ? 'configured' : 'not configured (demo mode)'}`);
    console.log(`Google Places: ${GOOGLE_PLACES_API_KEY && GOOGLE_PLACES_API_KEY !== 'your_google_places_key' ? 'configured' : 'using sample data'}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
