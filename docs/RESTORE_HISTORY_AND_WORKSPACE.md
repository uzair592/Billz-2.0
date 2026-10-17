# Historical bills and compact workspaces

Apply migration **028_historical_order_restore.sql** with the standard migration runner before deploying this change. Existing bills and migration checksums are unchanged.

## Restore behavior

The legacy JSON restore previously saved `pos_orders` only in browser storage. Managed View Orders and Reports read PostgreSQL, so those bills were absent there. After menu publication, restore now imports historical bills through an authenticated owner/manager endpoint. The repository reproduction backup contains three bills dated **2026-10-02**, totaling **PKR 3,047.00**. Use that date in Reports to see them; View Orders supports an unrestricted date range.

Historical imports preserve recorded prices, dates, quantities, costs and payment amounts. They receive collision-free server invoice numbers; the original number remains visible as provenance. Unknown or legacy-estimated costs are flagged incomplete, including the reproduction backup's zero-cost estimates. Profit based on these figures requires review.

Historical bills do **not** deduct stock again, generate kitchen tickets, or credit current cash/bank balances. Recorded payments appear in historical reporting without creating live ledger credits. Bank tenders without a verifiable account mapping are recorded as `other`, requiring reconciliation. Imported bills are read-only for cancellation, refunds and further payment collection; they must not move today's money or stock based solely on an old local backup. This release does not provide a financial reconciliation editor.

Imports use tenant RLS, authenticated branch context and a stable original ID/date key. Replaying a bill skips it; changed duplicates fail with a conflict rather than overwriting live records. An import batch is transactional. Backups exceeding 250 bills are sent in resumable batches; a later failure can leave earlier batches imported. **Retry Backup Sync** in the sidebar resumes safely. Pending restore records are stored only in that restaurant's local namespace. The control survives reloads and clears after successful completion. No credentials or tenant IDs from the backup are trusted.

A successful restore of historical bills does not restore the backup's expense/purchase ledger into live PostgreSQL. Those legacy records remain device-local; do not treat the import as a complete financial database recovery. Use the PostgreSQL backup/restore procedure for disaster recovery of the whole database.

## Workspaces

Headers are compact across operational screens. View Orders puts a smaller search and the existing edit/export actions together. Its search matches the shared history endpoint's customer name/phone behavior. KDS keeps New, Preparing and Ready in one row; narrower screens scroll within the board.

At desktop widths, drag the divider to the left of Current bill to widen it. Arrow keys adjust the width; Home or double-click resets it. The layout remembers a device-local width and clamps it to leave room for the menu. Mobile/tablet layouts keep their existing stacked behavior.

Reports has Overview, Bill Profit & Loss, Gross Profit, Net Profit, Payments & Order Types, and Sales Trends views. They share backend date/type/payment filters, pagination and existing PDF/XLSX/CSV exports. Operating expenses are deducted once per reporting period. Bills show gross contribution, not an invented allocation of restaurant expenses. If sales are filtered, net profit explicitly identifies the use of filtered sales against all period expenses. Existing server permissions and cost redaction remain enforced.

## Verification

Unit coverage checks the actual three-order fixture, invalid dates/totals, permissions/subscriptions, tenant changes and resize bounds. The PostgreSQL regression suite checks concurrent replay, rollback, shared reporting, isolation and blocked financial mutations. Browser coverage checks the actual restore control on the production server and visibility on a separate device, plus toolbar alignment, KDS lanes, report sections and pointer/keyboard resizing at laptop/tablet/phone sizes.

Physical printing and the actual hosting environment still require staging verification.
