CREATE TABLE api_keys (
  api_key     TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active','inactive')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE placements (
  id          TEXT NOT NULL,
  api_key     TEXT NOT NULL REFERENCES api_keys(api_key),
  name        TEXT NOT NULL,
  ad_type     TEXT NOT NULL CHECK (ad_type IN ('rewarded_video','interstitial')),
  status      TEXT NOT NULL CHECK (status IN ('active','paused')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, api_key)
);

CREATE TABLE mediation_config (
  id                  BIGSERIAL PRIMARY KEY,
  placement_id        TEXT NOT NULL,
  network             TEXT NOT NULL,
  traffic_percentage  INT NOT NULL CHECK (traffic_percentage BETWEEN 0 AND 100),
  priority            INT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL CHECK (status IN ('active','paused')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ads (
  id           TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL,
  ad_type      TEXT NOT NULL CHECK (ad_type IN ('rewarded_video','interstitial')),
  media_url    TEXT NOT NULL,
  click_url    TEXT NOT NULL,
  duration     INT NOT NULL,
  priority     INT NOT NULL DEFAULT 0,
  status       TEXT NOT NULL CHECK (status IN ('active','paused')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

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

-- индексы (чтобы не тупило)
CREATE INDEX idx_mediation_lookup ON mediation_config (placement_id, network, status, priority DESC);
CREATE INDEX idx_ads_lookup ON ads (placement_id, ad_type, status, priority DESC);
CREATE INDEX idx_impressions_created ON impressions (created_at DESC);
