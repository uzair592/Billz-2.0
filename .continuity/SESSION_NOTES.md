Branch fix/restore-history-compact-reports from main 998df24. Historical restore now imports the existing three-order reproduction fixture into PostgreSQL with transactional dedup/conflicts, read-only historical financial data, no repeated stock/KOT/ledger movements and durable tenant-local retry. Added compact operational headings/history toolbar, desktop keyboard/pointer bill resizing, one-row KDS, and six shared-data reporting views. Migration 028 required. All 706 local unit tests pass; local Postgres absent and Chromium download failed. GitHub CI verification pending; no merge or deployment performed. See docs/RESTORE_HISTORY_AND_WORKSPACE.md for financial reconciliation and batch limits.

Session Update:
- Fixed KDS ticket 500 error: corrected `rt.name` to `rt.table_number` in `src/server/pos/kitchen-service.mjs`.
- Fixed KOT cloud order registration and pricing computation in `src/client/legacy-cloud-adapter.mjs` and `Fast_Food_POS_Custom_Bill_Header_XXXL.html`.
- Implemented direct in-place order editing: clicking 'Edit Order' now opens the comprehensive inline edit modal immediately without any blocking alerts or cancellation prompts. Users can edit quantities, items, discounts, customer info, and table, and save directly via 'Save Changes'.
- Preserved all 706 unit tests passing.
