# Accounting Conventions & Financial Metrics

This document establishes the authoritative financial calculation rules and accounting conventions for **Billz 2.0 POS**.

---

## 1. Core Financial Formulas

### Gross Profit
$$\text{Gross Profit} = \text{Net Sales} - \text{COGS}$$

* **Net Sales**: Total sales revenue collected or recognized after deducting discounts, refunds, and returns (excluding tax where applicable).
* **COGS (Cost of Goods Sold)**: Authoritative direct cost allocated specifically to the goods and inventory items sold during the specified reporting period.

### Gross Profit Margin
$$\text{Gross Profit Margin (\%)} = \left( \frac{\text{Gross Profit}}{\text{Net Sales}} \right) \times 100$$

---

## 2. Inventory & COGS Valuation

1. **Authoritative COGS Allocation**: Cost of Goods Sold ($\text{COGS}$) must reflect the recorded unit purchase cost or weighted average cost at the time of sale.
2. **Exclusion of Operational Expenses**: Overhead, operational expenses, software subscriptions, rent, and utility costs must NOT be deducted from Gross Profit. They are categorized under Operating Expenses ($\text{OPEX}$) to compute Net Operating Profit:
$$\text{Net Operating Profit} = \text{Gross Profit} - \text{OPEX}$$

---

## 3. SaaS Subscription Accounting & Entitlements

1. **Currency & Precision**: All financial amounts in database schemas are stored as integer minor units (e.g. 500,000 minor units PKR = 5,000.00 PKR).
2. **UTC Timestamps**: All period coverage boundaries (`covered_from`, `covered_until`) are stored in UTC (`timestamptz`). UI presentation formats localized dates for display.
3. **Manual Subscriptions**: Manual subscription payments recorded by platform administrators transition through `pending` $\rightarrow$ `approved` or `rejected`. Renewal periods extend from the maximum of current entitlement expiration or payment coverage start date.
