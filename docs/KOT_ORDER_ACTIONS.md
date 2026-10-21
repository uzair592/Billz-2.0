# KOT and existing-order workflow

A KOT saves an unpaid order before queuing its kitchen print. It uses the real bill total, discount and charges; a failed save preserves the cart and retry identity and does not print a successful ticket. After confirmation the cart clears and Open Bill links to the saved invoice.

In View Orders, Take Payment records a cash or bank payment against the existing order. Smaller amounts leave a visible balance. The final payment completes the sale and deducts the saved recipe quantities once. A cashier can list active receiving accounts without seeing their balances. Received payments cannot be changed back to Unpaid; use the existing refund workflow.

Owners, managers and waiters with order-edit permission can change unpaid open orders, including served KOTs. Existing line prices and recipe/cost snapshots stay fixed; newly added menu items use server prices. Changed quantities produce ADD/REMOVE kitchen tickets. A version conflict asks the user to reopen the latest bill. Paid, completed and restored historical bills are protected from financial edits.

Cancel Order removes the order from active kitchen queues, refunds captured tenders and reverses only stock that was deducted. A blank optional reason is valid. The legacy Delete entry point uses this recorded cancellation; it does not erase the audit trail. Cashiers retain their existing payment permission and do not gain cancellation/edit permission.

Payment/edit retry payloads are stored per restaurant/order and reused after an uncertain network result, including reload. Fields remain locked until that attempt is confirmed or definitively refused. Server locks, payment retry validation and amendment audit keys prevent double recording and stale overwrites.

Deployment requires migration **029_order_amendment_retries.sql**, applied through the normal migration runner before the new application starts. It only adds retry fields/index to the existing tenant-protected audit table.

Verification covers unit/HTTP permissions and validation, static laptop/phone browser flows, real PostgreSQL concurrency and stock/ledger assertions, and the production browser KOT/edit/KDS/cashier-payment/cancellation journey at phone, tablet and laptop sizes. Physical printer delivery still depends on the browser/print queue and printer connection; these tests verify save-before-queue and the kitchen-only print payload.
