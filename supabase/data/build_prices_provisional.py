"""
Provisional master (Excellent-grade) trade-in prices, 2026-10-10 — an ESTIMATE, not market data.

The owner asked for starting prices to be filled in so the trade-in flow can be tested end to end.
No Qatar trade-in price list was available, so every value here comes from one transparent formula:

    base_price (QAR) = launch_price_usd(storage) x QAR_PER_USD x retention(brand_class, age_years)
    retention        = START[class] x YEARLY[class] ** age_years
    rounded to the nearest 10 QAR, never below FLOOR_QAR

- launch_price_usd: US launch list prices as I recall them (not re-checked against Apple/Samsung).
  For models released after mid-2026 I do not know the launch price, so they ASSUME the price of
  the predecessor (marked ASSUMED below). iPhone Duo has no predecessor: $1,999 is a guess.
- QAR_PER_USD = 4.0 approximates Qatar retail vs US list (the bank rate is 3.64; Qatar retail
  usually sits above it). Assumption.
- age_years: from the approximate release month to 2026-10-10.
- retention: Apple keeps value best, Samsung S-series less, foldables least. The curves are my
  judgement, NOT fitted to any market data.

The owner must review these in Admin -> Pricing before real customers are served.
Run:  python3 supabase/data/build_prices_provisional.py   (writes prices_provisional_2026-10-10.{json,sql})
"""
import json
import math
from datetime import date
from pathlib import Path

AS_OF = date(2026, 10, 10)
QAR_PER_USD = 4.0
FLOOR_QAR = 200
START = {'apple': 0.70, 'samsung_s': 0.60, 'fold': 0.55}
YEARLY = {'apple': 0.80, 'samsung_s': 0.75, 'fold': 0.70}

# (brand, model, class, release (y, m), {storage: launch USD}, assumed?)
MODELS = [
    ('Apple', 'iPhone 13 mini', 'apple', (2021, 9), {'128GB': 699, '256GB': 799, '512GB': 999}, False),
    ('Apple', 'iPhone 13', 'apple', (2021, 9), {'128GB': 799, '256GB': 899, '512GB': 1099}, False),
    ('Apple', 'iPhone 13 Pro', 'apple', (2021, 9), {'128GB': 999, '256GB': 1099, '512GB': 1299, '1TB': 1499}, False),
    ('Apple', 'iPhone 13 Pro Max', 'apple', (2021, 9), {'128GB': 1099, '256GB': 1199, '512GB': 1399, '1TB': 1599}, False),
    ('Apple', 'iPhone 14', 'apple', (2022, 9), {'128GB': 799, '256GB': 899, '512GB': 1099}, False),
    ('Apple', 'iPhone 14 Plus', 'apple', (2022, 10), {'128GB': 899, '256GB': 999, '512GB': 1199}, False),
    ('Apple', 'iPhone 14 Pro', 'apple', (2022, 9), {'128GB': 999, '256GB': 1099, '512GB': 1299, '1TB': 1499}, False),
    ('Apple', 'iPhone 14 Pro Max', 'apple', (2022, 9), {'128GB': 1099, '256GB': 1199, '512GB': 1399, '1TB': 1599}, False),
    ('Apple', 'iPhone 15', 'apple', (2023, 9), {'128GB': 799, '256GB': 899, '512GB': 1099}, False),
    ('Apple', 'iPhone 15 Plus', 'apple', (2023, 9), {'128GB': 899, '256GB': 999, '512GB': 1199}, False),
    ('Apple', 'iPhone 15 Pro', 'apple', (2023, 9), {'128GB': 999, '256GB': 1099, '512GB': 1299, '1TB': 1499}, False),
    ('Apple', 'iPhone 15 Pro Max', 'apple', (2023, 9), {'256GB': 1199, '512GB': 1399, '1TB': 1599}, False),
    ('Apple', 'iPhone 16', 'apple', (2024, 9), {'128GB': 799, '256GB': 899, '512GB': 1099}, False),
    ('Apple', 'iPhone 16 Plus', 'apple', (2024, 9), {'128GB': 899, '256GB': 999, '512GB': 1199}, False),
    ('Apple', 'iPhone 16 Pro', 'apple', (2024, 9), {'128GB': 999, '256GB': 1099, '512GB': 1299, '1TB': 1499}, False),
    ('Apple', 'iPhone 16 Pro Max', 'apple', (2024, 9), {'256GB': 1199, '512GB': 1399, '1TB': 1599}, False),
    ('Apple', 'iPhone 16e', 'apple', (2025, 2), {'128GB': 599, '256GB': 699, '512GB': 899}, False),
    ('Apple', 'iPhone 17', 'apple', (2025, 9), {'256GB': 799, '512GB': 999}, False),
    ('Apple', 'iPhone Air', 'apple', (2025, 9), {'256GB': 999, '512GB': 1199, '1TB': 1399}, False),
    ('Apple', 'iPhone 17 Pro', 'apple', (2025, 9), {'256GB': 1099, '512GB': 1299, '1TB': 1499}, False),
    ('Apple', 'iPhone 17 Pro Max', 'apple', (2025, 9), {'256GB': 1199, '512GB': 1399, '1TB': 1599, '2TB': 1999}, False),
    ('Apple', 'iPhone 17e', 'apple', (2026, 3), {'256GB': 599, '512GB': 799}, True),          # ASSUMED (16e-like)
    ('Apple', 'iPhone 18 Pro', 'apple', (2026, 9), {'256GB': 1099, '512GB': 1299, '1TB': 1499, '2TB': 1899}, True),  # ASSUMED = 17 Pro
    ('Apple', 'iPhone 18 Pro Max', 'apple', (2026, 9), {'256GB': 1199, '512GB': 1399, '1TB': 1599, '2TB': 1999}, True),  # ASSUMED = 17 Pro Max
    ('Apple', 'iPhone Duo', 'apple', (2026, 9), {'256GB': 1999, '512GB': 2199, '1TB': 2399, '2TB': 2799}, True),  # GUESS, no predecessor
    ('Samsung', 'Galaxy S22', 'samsung_s', (2022, 2), {'128GB': 799, '256GB': 849}, False),
    ('Samsung', 'Galaxy S22+', 'samsung_s', (2022, 2), {'128GB': 999, '256GB': 1049}, False),
    ('Samsung', 'Galaxy S22 Ultra', 'samsung_s', (2022, 2), {'128GB': 1199, '256GB': 1299, '512GB': 1399, '1TB': 1599}, False),
    ('Samsung', 'Galaxy S23', 'samsung_s', (2023, 2), {'128GB': 799, '256GB': 859}, False),
    ('Samsung', 'Galaxy S23+', 'samsung_s', (2023, 2), {'256GB': 999, '512GB': 1119}, False),
    ('Samsung', 'Galaxy S23 Ultra', 'samsung_s', (2023, 2), {'256GB': 1199, '512GB': 1379, '1TB': 1619}, False),
    ('Samsung', 'Galaxy S24', 'samsung_s', (2024, 1), {'128GB': 799, '256GB': 859}, False),
    ('Samsung', 'Galaxy S24+', 'samsung_s', (2024, 1), {'256GB': 999, '512GB': 1119}, False),
    ('Samsung', 'Galaxy S24 Ultra', 'samsung_s', (2024, 1), {'256GB': 1299, '512GB': 1419, '1TB': 1659}, False),
    ('Samsung', 'Galaxy S25', 'samsung_s', (2025, 2), {'128GB': 799, '256GB': 859, '512GB': 979}, False),
    ('Samsung', 'Galaxy S25+', 'samsung_s', (2025, 2), {'256GB': 999, '512GB': 1119}, False),
    ('Samsung', 'Galaxy S25 Ultra', 'samsung_s', (2025, 2), {'256GB': 1299, '512GB': 1419, '1TB': 1659}, False),
    ('Samsung', 'Galaxy S26', 'samsung_s', (2026, 3), {'256GB': 859, '512GB': 979}, True),     # ASSUMED = S25
    ('Samsung', 'Galaxy S26+', 'samsung_s', (2026, 3), {'256GB': 999, '512GB': 1119}, True),   # ASSUMED = S25+
    ('Samsung', 'Galaxy S26 Ultra', 'samsung_s', (2026, 3), {'256GB': 1299, '512GB': 1419, '1TB': 1659}, True),  # ASSUMED
    ('Samsung', 'Galaxy Z Fold5', 'fold', (2023, 8), {'256GB': 1799, '512GB': 1919, '1TB': 2159}, False),
    ('Samsung', 'Galaxy Z Flip5', 'fold', (2023, 8), {'256GB': 999, '512GB': 1119}, False),
    ('Samsung', 'Galaxy Z Fold6', 'fold', (2024, 7), {'256GB': 1899, '512GB': 2019, '1TB': 2259}, False),
    ('Samsung', 'Galaxy Z Flip6', 'fold', (2024, 7), {'256GB': 1099, '512GB': 1219}, False),
    ('Samsung', 'Galaxy Z Fold7', 'fold', (2025, 7), {'256GB': 1999, '512GB': 2119, '1TB': 2419}, False),
    ('Samsung', 'Galaxy Z Flip7', 'fold', (2025, 7), {'256GB': 1099, '512GB': 1219}, False),
    ('Samsung', 'Galaxy Z Fold8', 'fold', (2026, 7), {'256GB': 1999, '512GB': 2119, '1TB': 2419}, True),  # ASSUMED = Fold7
    ('Samsung', 'Galaxy Z Flip8', 'fold', (2026, 7), {'256GB': 1099, '512GB': 1219}, True),             # ASSUMED = Flip7
]


def age_years(y: int, m: int) -> float:
    return max(0.0, ((AS_OF.year - y) * 12 + (AS_OF.month - m)) / 12)


def price(usd: int, cls: str, age: float) -> int:
    value = usd * QAR_PER_USD * START[cls] * YEARLY[cls] ** age
    return max(FLOOR_QAR, int(round(value / 10.0)) * 10)


rows = []
for brand, model, cls, (y, m), storages, assumed in MODELS:
    age = age_years(y, m)
    last = -1
    for storage, usd in storages.items():
        qar = price(usd, cls, age)
        assert qar > last, f'{model} {storage}: price must rise with storage'
        last = qar
        rows.append({'brand': brand, 'model': model, 'storage': storage, 'base_price': qar,
                     'launch_usd': usd, 'age_years': round(age, 2), 'class': cls, 'launch_price_assumed': assumed})

out = Path(__file__).with_name('prices_provisional_2026-10-10.json')
out.write_text(json.dumps(rows, indent=1) + '\n')

NOTE = "Provisional estimate (Claude, 2026-10-10) - NOT market-verified; owner to review in Admin > Pricing."
values = ',\n    '.join(
    "('{b}', '{m}', '{s}', {p}, '{n}')".format(
        b=r['brand'], m=r['model'].replace("'", "''"), s=r['storage'], p=r['base_price'],
        n=NOTE + (' Launch price ASSUMED (model newer than my data).' if r['launch_price_assumed'] else ''))
    for r in rows)
sql = f"""-- Provisional master prices (Excellent grade = 100% of base), generated by build_prices_provisional.py.
-- ESTIMATES, not market data. Idempotent: a variant that already has an active master price is left alone.
do $$
declare r record; v text; p text; n_ins int := 0; n_skip int := 0; n_missing int := 0;
begin
  for r in select * from (values
    {values}
  ) as t(brand, model, storage, base_price, note) loop
    select pv.id, pv.product_id into v, p from public.product_variants pv
      join public.products pr on pr.id = pv.product_id join public.brands b on b.id = pr.brand_id
     where lower(b.name) = lower(r.brand) and lower(btrim(pr.model)) = lower(r.model) and lower(pv.storage) = lower(r.storage);
    if v is null then n_missing := n_missing + 1; continue; end if;
    if exists (select 1 from public.master_prices m where m.variant_id = v and m.active) then n_skip := n_skip + 1; continue; end if;
    insert into public.master_prices (id, product_id, variant_id, base_price, currency, effective_from, active, created_by, updated_by, notes)
      values ('MPR-' || lpad(app.next_counter('MPR', 0)::text, 6, '0'), p, v, r.base_price, 'QAR', now(), true, 'SYSTEM', 'SYSTEM', r.note);
    n_ins := n_ins + 1;
  end loop;
  if n_missing > 0 then raise exception '% price rows did not match a catalogue variant', n_missing; end if;
  insert into public.audit_logs (actor_id, actor_name, actor_role, action, object_type, object_id, details)
    values ('SYSTEM', 'Operator (owner request)', 'SYSTEM', 'BASE_PRICE_SET', 'CATALOGUE', 'prices_provisional_2026-10-10',
      jsonb_build_object('inserted', n_ins, 'skipped', n_skip, 'provisional', true,
                         'note', 'Claude estimates from a formula; not market-verified'));
  raise notice 'inserted=% skipped=%', n_ins, n_skip;
end $$;
"""
out.with_suffix('.sql').write_text(sql)
print(len(rows), 'rows')
