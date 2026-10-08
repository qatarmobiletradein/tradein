-- =====================================================================
-- 20261008000500_reference_data.sql
--
-- Configuration every environment needs before the first quote can be
-- made: the default grade ladder and the default inspection rules, copied
-- VERBATIM from 3.1 (00_Config.gs DEFAULT_GRADE_RULES and
-- DEFAULT_INSPECTION_RULES). Values marked NEEDS_APPROVAL in 3.1 keep that
-- note — they were proposals there and remain proposals here.
--
-- ON CONFLICT DO NOTHING: when production data is imported from Google
-- Sheets, the importer overwrites these rows with the live sheet values,
-- which are the source of truth.
-- =====================================================================

insert into public.grade_rules (id, grade_code, grade_name, percentage_of_base, min_score, display_order, is_terminal, active) values
  ('GRD-001', 'A', 'Excellent',  1.0000, 95, 1, false, true),
  ('GRD-002', 'B', 'Good',       0.7000, 80, 2, false, true),
  ('GRD-003', 'C', 'Fair',       0.5000, 60, 3, false, true),
  ('GRD-004', 'D', 'Repairable', 0.3000, 35, 4, false, true),
  ('GRD-005', 'R', 'Parts only', 0.0000,  0, 5, true,  true)
on conflict do nothing;

insert into public.inspection_rules
  (id, code, group_name, question, input_type, good_label, bad_label, score_impact, is_blocking, display_order, active, notes) values
  ('IRL-001','ACTIVATION_LOCK','Identity','Activation lock','LOCK','Unlocked','Locked',0,true,1,true,
   'A locked device cannot be resold, so it is refused outright.'),
  ('IRL-002','SCREEN_WORKS','Display','Screen','SWITCH','Works','Does not work',25,false,10,true,
   'Carried forward from the original screen weight.'),
  ('IRL-003','SCREEN_CRACK','Display','Screen crack','SWITCH','No crack','Cracked',18,false,11,true,
   'NEEDS_APPROVAL — new cosmetic question.'),
  ('IRL-004','SCREEN_SCRATCH','Display','Screen scratch','SWITCH','No scratch','Scratched',7,false,12,true,
   'NEEDS_APPROVAL — new cosmetic question.'),
  ('IRL-005','BODY_INTACT','Body','Body and frame','SWITCH','No major damage','Damaged',20,false,20,true,
   'Carried forward from the original body weight.'),
  ('IRL-006','BODY_DENT','Body','Dent','SWITCH','No dent','Dented',8,false,21,true,
   'NEEDS_APPROVAL — new cosmetic question.'),
  ('IRL-007','BODY_SCRATCH','Body','Body scratch','SWITCH','No scratch','Scratched',5,false,22,true,
   'NEEDS_APPROVAL — new cosmetic question.'),
  ('IRL-008','BACK_GLASS','Body','Back glass','SWITCH','Good','Damaged',10,false,23,true,
   'Carried forward from the original back-glass weight.'),
  ('IRL-009','DEVICE_POWERS_ON','Functions','Device powers on','SWITCH','Turns on','Does not turn on',40,false,29,true,
   'NEEDS_APPROVAL — new in V3, paired with the customer question.'),
  ('IRL-010','CAMERA_WORKS','Functions','Cameras','SWITCH','Work','Do not work',8,false,30,true,'Carried forward.'),
  ('IRL-011','BIOMETRIC_WORKS','Functions','Face or touch ID','SWITCH','Works','Does not work',6,false,31,true,'Carried forward.'),
  ('IRL-012','SPEAKER_WORKS','Functions','Speakers','SWITCH','Work','Do not work',5,false,32,true,'Carried forward.'),
  ('IRL-013','MIC_WORKS','Functions','Microphone','SWITCH','Works','Does not work',4,false,33,true,'Carried forward.'),
  ('IRL-014','BUTTONS_WORK','Functions','Buttons','SWITCH','Work','Do not work',4,false,34,true,'Carried forward.'),
  ('IRL-015','CHARGING_WORKS','Functions','Charging port','SWITCH','Works','Does not work',4,false,35,true,'Carried forward.'),
  ('IRL-016','WIFI_WORKS','Functions','Wi-Fi','SWITCH','Works','Does not work',2,false,36,true,'Carried forward.'),
  ('IRL-017','BLUETOOTH_WORKS','Functions','Bluetooth','SWITCH','Works','Does not work',2,false,37,true,'Carried forward.'),
  ('IRL-018','BATTERY_HEALTH','Battery','Battery health','PERCENTAGE','','',12,false,40,true,
   'Carried forward. Deduction scales with health — see BATTERY_BANDS.')
on conflict do nothing;

-- Make sure generated ids continue after the seeded ones.
insert into public.id_counters (scope, last_value) values ('GRD', 5), ('IRL', 18)
on conflict (scope) do update set last_value = greatest(public.id_counters.last_value, excluded.last_value);
