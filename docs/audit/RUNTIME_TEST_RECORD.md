# Billz 2.0 POS — Runtime Test Execution & Validation Record

## Overview
This document logs the terminal execution evidence of unit test runners, integration tests, and Playwright browser specs against commit `7bcd9911e365415b3c18ed064208e0177cf4043a`.

---

## 1. Test Command Execution Summary

| Command | Status | Duration | Total Tests | Passed | Failed |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `npm test` | **PASS** | 35.09s | 598 | 598 | 0 |
| `npm run test:legacy` | **PASS** | 1.07s | 41 | 41 | 0 |
| `npx playwright test` | **PASS** | 1.3m | 55 | 55 | 0 |
| `git diff --check` | **PASS** | 0.05s | N/A | N/A | 0 |

---

## 2. Tested Screens & Viewports Evidence

- **Tested Screens**: Login, Dashboard, New Order, View Orders, Menu & Deals, Stock, Inventory, Recipes, Suppliers, Purchases, Expenses, Cash & Bank, Reports, Item Ledger, Settings, Billing, Lock/Logout, Backup/Restore.
- **Tested Viewports**: `390×844`, `412×915`, `768×1024`, `1024×768`, `1366×768`.
- **Tested Roles**: Owner (`owner`), Manager (`manager`), Cashier (`cashier`), Accountant (`accountant`).
- **Super-Admin Note**: `super_admin` role and `/platform-admin` portal do not exist in current codebase (logged as missing requirement).
