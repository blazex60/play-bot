CREATE TABLE IF NOT EXISTS track_analysis (
  video_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  duration_sec REAL,
  tail_shape TEXT,
  last_rms REAL,
  bpm REAL,
  bpm_confidence REAL,
  head_key TEXT,
  tail_key TEXT,
  harmonic_confidence REAL,
  vocal_confidence REAL,
  recommended_overlap_sec REAL,
  confidence REAL,
  payload_json TEXT NOT NULL,
  analyzed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_track_analysis_analyzed_at
  ON track_analysis(analyzed_at DESC);
