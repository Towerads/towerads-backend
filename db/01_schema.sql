-- =========================
-- TowerAds database schema
-- =========================

-- 1. API keys
CREATE TABLE api_keys (
  api_key     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','inactive')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Placements
CREATE TABLE placements (
  id          TEXT NOT NULL,
  api_key     TEXT NOT NULL,
  name        TEXT NOT NULL,
  ad_type     TEXT NOT NULL CHECK (ad_type IN ('rewarded_video','interstitial')),
  status      TEXT NOT NULL CHECK (status IN ('active','paused')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, api_key),
  CONSTRAINT fk_placements_api_key
    FOREIGN KEY (api_key) REFERENCES api_keys(api_key)
);

-- 3. Mediation config
CREATE TABLE mediation_config (
  id                  BIGSERIAL PRIMARY KEY,
  placement_id        TEXT NOT NULL,
  network             TEXT NOT NULL CHECK (network IN ('tower','telegram','monetag','yandex')),
  traffic_percentage  INT NOT NULL CHECK (traffic_percentage BETWEEN 0 AND 100),
  priority            INT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('active','paused')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Ads
CREATE TABLE ads (
  id           TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL,
  ad_type      TEXT NOT NULL CHECK (ad_type IN ('rewarded_video','interstitial')),
  media_url    TEXT NOT NULL,
  click_url    TEXT NOT NULL,
  duration     INT NOT NULL,
  priority     INT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('active','paused')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Impressions
CREATE TABLE impressions (
  id           TEXT PRIMARY KEY,
  ad_id        TEXT,
  placement_id TEXT NOT NULL,
  user_ip      TEXT,
  device       TEXT,
  os           TEXT,
  status       TEXT NOT NULL CHECK (status IN ('requested','completed','clicked')),
  completed_at TIMESTAMPTZ,
  clicked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for performance
CREATE INDEX idx_mediation_lookup
  ON mediation_config (placement_id, network, status, priority DESC);

CREATE INDEX idx_ads_lookup
  ON ads (placement_id, ad_type, status, priority DESC);

CREATE INDEX idx_impressions_created
  ON impressions (created_at DESC);
