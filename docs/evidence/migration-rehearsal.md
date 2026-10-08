# Staging verification report

- **kind**: migration tooling rehearsal (fictional exports, throwaway PostgreSQL)

**PASS 10 · FAIL 0 · SKIPPED 0**

| Status | ID | Check | Detail |
|---|---|---|---|
| PASS | M-01 | dry-run: nothing written; duplicates, invalid phones and ignored sheets reported | 2 error(s) reported; failed-rows CSV written without personal data |
| PASS | M-02 | validate: every constraint exercised in a transaction, then rolled back |  |
| PASS | M-03 | apply with a broken reference: the bad row and its dependents are rejected and reported; comparison and reconciliation flag the gap | run 2 PARTIAL; rejected: TradeIns:TI-FIX-000007, Inspections:INS-000050, Vouchers:VCH-000050, CollectionItems:CLI-0000050; reconciliation: SETTLEMENT_COUNT_MISMATCH, SETTLEMENT_TOTAL_MISMATCH, COLLECTION_NOTE_WITHOUT_LINES; compare flags it (mismatches 0, missing [{"sheet":"TradeIns","table":"trade_ins","exported":2,"inDatabase":1,"missing":1,"tableTotal":1},{"sheet":"Inspections","table":"inspections","exported":1,"inDatabase":0,"missing":1,"tableTotal":0},{"sheet":"Vouchers","table":"vouchers","exported":1,"inDatabase":0,"missing":1,"tableTotal":0},{"sheet":"CollectionItems","table":"collection_items","exported":1,"inDatabase":0,"missing":1,"tableTotal":0}]) |
| PASS | M-04 | after fixing the export, a new APPLY run adds only what was missing |  |
| PASS | M-05 | resume: a run killed mid-way continues from its checkpoints with no duplicates | killed run 4 at row 1000; resumed to 20000 rows; re-resume refused |
| PASS | M-06 | deterministic ID mapping: legacy ids kept; counters continue after them |  |
| PASS | M-07a | re-running apply is idempotent (nothing inserted twice) |  |
| PASS | M-07b | --resume with an unknown run id is refused clearly |  |
| PASS | M-07 | compare: counts, exact financial totals, orphans, invalid states, broken files | totals: trade-ins: customer value (billable)=0 diff, trade-ins: partner fees (billable)=0 diff, trade-ins: Qatar Mobile settlement value (billable)=0 diff, vouchers: live customer value=0 diff, vouchers: live partner fees=0 diff, settlements: total (all but cancelled)=0 diff, settlements: paid=0 diff, settlements: outstanding balance=0 diff, owed, not yet settled (collected, unclaimed)=0 diff, collections: expected amount=0 diff, collections: actual amount=0 diff; broken file refs: 1 (photos not migrated yet — expected) |
| PASS | M-08 | compare flags rows the import refused (dirty export) |  |
