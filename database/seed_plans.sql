INSERT INTO plans (code, name, description, features, sort_order)
VALUES
  ('STARTER',    'Starter',    '1 device, basic features',   '{"max_devices": 1,   "storage_gb": 2}'::jsonb,   1),
  ('GROWTH',     'Growth',     'Up to 3 devices',            '{"max_devices": 3,   "storage_gb": 5}'::jsonb,   2),
  ('PRO',        'Pro',        'Up to 10 devices',           '{"max_devices": 10,  "storage_gb": 20}'::jsonb,  3),
  ('ENTERPRISE', 'Enterprise', 'Unlimited devices',          '{"max_devices": 999, "storage_gb": 100}'::jsonb, 4)
ON CONFLICT (code) DO UPDATE SET
  name        = EXCLUDED.name,
  description = EXCLUDED.description,
  features    = EXCLUDED.features,
  sort_order  = EXCLUDED.sort_order;

SELECT code, name, features->>'max_devices' AS max_devices FROM plans ORDER BY sort_order;
