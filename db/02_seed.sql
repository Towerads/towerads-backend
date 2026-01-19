INSERT INTO api_keys (api_key, user_id, status)
VALUES ('tower_test_123', 'user_1', 'active');

INSERT INTO placements (id, api_key, name, ad_type, status)
VALUES ('main', 'tower_test_123', 'Main', 'rewarded_video', 'active');

INSERT INTO mediation_config (placement_id, network, traffic_percentage, priority, status) VALUES
('main', 'tower', 70, 100, 'active'),
('main', 'telegram', 15, 90, 'active'),
('main', 'monetag', 10, 80, 'active'),
('main', 'yandex', 5, 70, 'active');

INSERT INTO ads (id, placement_id, ad_type, media_url, click_url, duration, priority, status)
VALUES (
  'ad_001',
  'main',
  'rewarded_video',
  'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
  'https://example.com',
  30,
  100,
  'active'
);
