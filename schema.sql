CREATE TABLE IF NOT EXISTS assets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  r2_key TEXT NOT NULL UNIQUE,
  type TEXT,
  folder TEXT,
  tags TEXT,
  summary TEXT,
  uploaded_at TEXT,
  uploaded_by TEXT
);

CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder);
CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_uploaded_at ON assets(uploaded_at);

-- Notes pipeline: queue of short-form posts for X / Substack Notes
CREATE TABLE IF NOT EXISTS notes_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  body_x TEXT,
  body_substack TEXT,
  platforms TEXT NOT NULL DEFAULT 'x,substack',
  status TEXT NOT NULL DEFAULT 'draft',
  topic TEXT,
  scheduled_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  reviewed_at TEXT,
  reviewed_by TEXT,
  posted_at TEXT,
  post_urls TEXT,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_notes_status ON notes_queue(status);
CREATE INDEX IF NOT EXISTS idx_notes_scheduled ON notes_queue(scheduled_at);

-- Simple key/value settings (e.g. posting_paused kill switch)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
