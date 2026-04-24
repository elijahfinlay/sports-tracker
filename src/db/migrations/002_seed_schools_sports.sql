-- Seed the 4 covered schools
INSERT OR IGNORE INTO schools (osaa_id, name, classification, mascot) VALUES
  (72,  'Roseburg',   '6A', 'Indians'),
  (9,   'Sutherlin',  '3A', 'Bulldogs'),
  (174, 'Glide',      '3A', 'Wildcats'),
  (258, 'Oakland',    '2A', 'Oakers');

-- Seed OSAA-sanctioned sports
INSERT OR IGNORE INTO sports (osaa_slug, name, season) VALUES
  ('fbl', 'Football',         'fall'),
  ('vbl', 'Volleyball',       'fall'),
  ('scb', 'Boys Soccer',      'fall'),
  ('scg', 'Girls Soccer',     'fall'),
  ('txc', 'Boys Cross Country','fall'),
  ('twc', 'Girls Cross Country','fall'),
  ('bbx', 'Boys Basketball',  'winter'),
  ('gbx', 'Girls Basketball', 'winter'),
  ('swm', 'Swimming',         'winter'),
  ('wre', 'Wrestling',        'winter'),
  ('bbl', 'Baseball',         'spring'),
  ('sbl', 'Softball',         'spring'),
  ('gob', 'Boys Golf',        'spring'),
  ('gol', 'Girls Golf',       'spring'),
  ('tfb', 'Boys Track & Field','spring'),
  ('tfg', 'Girls Track & Field','spring'),
  ('ten', 'Boys Tennis',      'spring'),
  ('tng', 'Girls Tennis',     'spring'),
  ('lab', 'Boys Lacrosse',    'spring'),
  ('lag', 'Girls Lacrosse',   'spring');
