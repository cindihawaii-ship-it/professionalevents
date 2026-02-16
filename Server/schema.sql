-- Professional Events Database Schema
-- This schema is auto-created by the server on startup
-- This file is for reference only

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

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_events_user_id ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_vendors_user_id ON saved_vendors(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_vendors_event_id ON saved_vendors(event_id);
CREATE INDEX IF NOT EXISTS idx_appointments_user_id ON appointments(user_id);
CREATE INDEX IF NOT EXISTS idx_appointments_vendor_id ON appointments(vendor_id);
CREATE INDEX IF NOT EXISTS idx_appointments_event_id ON appointments(event_id);
CREATE INDEX IF NOT EXISTS idx_checklist_items_event_id ON checklist_items(event_id);
