-- Feedback Database Schema
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  sentiment TEXT,
  themes TEXT,
  urgency TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Create index on source for faster filtering
CREATE INDEX IF NOT EXISTS idx_feedback_source ON feedback(source);

-- Create index on created_at for time-based queries
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at);

-- Create index on sentiment for analytics
CREATE INDEX IF NOT EXISTS idx_feedback_sentiment ON feedback(sentiment);

-- Create index on urgency for filtering urgent items
CREATE INDEX IF NOT EXISTS idx_feedback_urgency ON feedback(urgency);

-- Optimize database performance (Cloudflare D1 best practice)
-- PRAGMA optimize collects statistics on tables and indices
-- This allows the query planner to generate the most efficient query plan
-- Recommended after creating indexes per Cloudflare docs
PRAGMA optimize;
