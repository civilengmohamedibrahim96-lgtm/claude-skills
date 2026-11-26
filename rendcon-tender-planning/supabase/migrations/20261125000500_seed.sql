-- Tags (ids are used by code: new, upd, qa, pp, un, urgent, sub)
insert into public.tags (id, name, color, sort, system) values
  ('new',    'New project',     '#EE6A1F', 1, true),
  ('upd',    'New updates',     '#B8860B', 2, true),
  ('qa',     'Queries answers', '#2F7D7A', 3, true),
  ('pp',     'Postponed',       '#8A8A85', 4, true),
  ('un',     'Unassigned',      '#111111', 5, true),
  ('urgent', 'Urgent',          '#C8321E', 6, true),
  ('sub',    'Submitted',       '#2E7D4F', 7, true)
on conflict (id) do nothing;

-- Tender team (study supervisors)
insert into public.tender_team (name, name_ar, type, sort) values
  ('Eng. Mina',            'مينا',       'private', 1),
  ('Eng. Merihan',         'ميريهان',    'private', 2),
  ('Eng. Mohamed Mustafa', 'محمد مصطفى', 'public',  3),
  ('Eng. Shreine',         'شيرين',      'public',  4)
on conflict (name) do nothing;

-- Settings
insert into public.settings (key, value) values
  ('mail',       '{"address": "", "subjectHint": "ورد الينا", "hourlyEnabled": true}'::jsonb),
  ('folders',    '{"rootUrl": ""}'::jsonb),
  ('mail_state', '{"lastRunAt": null}'::jsonb)
on conflict (key) do nothing;
