-- Commission as a share of the partner's INVOICE (owner decision 2026-10-10, Carrefour -> QM invoices):
--   invoice = trade-in value / (1 - rate), fee = invoice - value     (1500 at 5% -> 1578.95)
-- New commission type INVOICE_PERCENTAGE beside PERCENTAGE (fee = value x rate) and FIXED.
-- Additive only: existing rules and trade-in snapshots are unchanged.

alter table public.commission_rules drop constraint if exists commission_rules_commission_type_check;
alter table public.commission_rules add constraint commission_rules_commission_type_check
  check (commission_type in ('PERCENTAGE', 'FIXED', 'INVOICE_PERCENTAGE'));
-- a share of an invoice must stay below 100% (the formula divides by 1 - rate)
alter table public.commission_rules add constraint commission_rules_invoice_share_check
  check (commission_type <> 'INVOICE_PERCENTAGE' or commission_value < 1);

alter table public.trade_ins drop constraint if exists trade_ins_commission_type_snapshot_check;
alter table public.trade_ins add constraint trade_ins_commission_type_snapshot_check
  check (commission_type_snapshot in ('PERCENTAGE', 'FIXED', 'INVOICE_PERCENTAGE'));
