# POS HTML injection audit

Scope: the shipped POS HTML and all `src/client/` modules. After Group 4 removed the license UI, the HTML has 182 `innerHTML` assignments; the modules add 22. All 204 locations are inventoried below. Line numbers refer to this revision; use the enclosing function and target when subsequent edits shift them. This is a source review plus regression coverage, not a guarantee against every possible future payload.

The existing shared `escapeHtmlForExport` encodes `& < > " '`; `escapeHtml` is its alias. Data is encoded at the HTML boundary, never in storage or `textContent`. `htmlJsValue` serializes a JavaScript value with JSON before HTML encoding; surrounding single quotes were removed from brand/stock handlers. Direct `setAttribute` handlers use JSON serialization alone. `safeCssColor` restricts dynamic colors to hex or named colors. Partial quote-only encoding in input values was replaced with the shared encoder. Existing image blobs are generated locally from validated raster data, not arbitrary HTML/SVG or external URLs.

## Changes by renderer

| Function | Newly protected interpolations | Fields/examples |
| --- | ---: | --- |
| `buildTableOptionsHtml` | 2 | `n`; `n` |
| `calculateAndRenderBusinessReports` | 8 | `item.qty`; `item.qty`; `pct`; `h.hour`; `h.count` |
| `calculateCartTotal` | 1 | `formatRs(remaining)` |
| `conditional HTML` | 2 | `data.flavors.join(", ")`; `data.flavors.join(", ")` |
| `enterEditOrderMode` | 5 | `buildTableOptionsHtml(order.tableNumber &#124;&#124; 1)`; `buildHallOptionsHtml(order.hall)`; `order.amountReceived != null ? order.amountReceived : ""`; `order.deliveryCharges &#124;&#124; 0`; `order.discountValue &#124;&#124; 0` |
| `exportBillWiseProfitToPDF` | 1 | `new Date().toLocaleString()` |
| `exportExpenseHistoryToExcel` | 6 | `e.date`; `e.amount &#124;&#124; 0`; `h`; `new Date().toLocaleString()`; `filtered.length` |
| `exportExpenseHistoryToPDF` | 5 | `e.date`; `e.amount &#124;&#124; 0`; `new Date().toLocaleString()`; `filtered.length`; `totalAmount` |
| `exportExpensesReportTabToPDF` | 1 | `new Date().toLocaleString()` |
| `exportIngredientUsageToPDF` | 1 | `new Date().toLocaleString()` |
| `exportItemLedgerToPDF` | 21 | `c.icon`; `c.label`; `Math.round(c.sales).toLocaleString()`; `Math.round(c.cost).toLocaleString()`; `Math.round(c.sales - c.cost).toLocaleString()` |
| `exportOrdersHistoryToExcel` | 22 | `o.id`; `o.date`; `o.time ? formatTime12Hour(o.time) : ""`; `o.orderType === "Dine-In" && o.tableNumber ? o.tableNumber : ""`; `o.subtotal &#124;&#124; 0` |
| `exportOrdersHistoryToPDF` | 14 | `o.id`; `o.date`; `o.time ? formatTime12Hour(o.time) : ""`; `o.totalBill &#124;&#124; 0`; `displayStatus` |
| `exportPurchaseReportToPDF` | 1 | `new Date().toLocaleString()` |
| `exportStockValuationToPDF` | 1 | `new Date().toLocaleString()` |
| `filterDealComponentDropdown` | 4 | `m.id`; `m.itemNumber ?? m.id`; `m.price`; `document.getElementById("deal-component-search-input").value` |
| `filterEditAddItemDropdown` | 3 | `m.itemNumber ?? m.id`; `m.price`; `searchInput.value` |
| `openCancelOrderModal` | 13 | `cartItem.qty`; `displayAmount`; `displayAmount`; `unitLabel`; `size` |
| `openCostFieldsModal` | 1 | `checked` |
| `populateCustomerReceiptSlip` | 3 | `item.originalPrice`; `item.price`; `item.qty` |
| `populateEditPaymentAccounts` | 1 | `account.id` |
| `populateExpenseLedgerDestinations` | 1 | `account.id` |
| `populateIceCreamFlavorSelect` | 4 | `f`; `f`; `s`; `s` |
| `populateIceCreamNameSelect` | 2 | `n`; `n` |
| `populateIceCreamStockFilterOptions` | 6 | `n`; `n`; `f`; `f`; `s` |
| `populateKitchenReceiptSlip` | 3 | `extra.qty`; `unitLabel`; `item.qty` |
| `populateLedgerMovementDestinations` | 1 | `a.id` |
| `populatePaymentBankAccounts` | 1 | `account.id` |
| `populateSoftDrinkBrandSelect` | 2 | `b`; `b` |
| `populateSoftDrinkFlavorSelect` | 4 | `f`; `f`; `s`; `s` |
| `populateSoftDrinkStockFilterOptions` | 6 | `b`; `b`; `f`; `f`; `s` |
| `renderAdditionalCharges` | 5 | `index`; `index`; `charge.value`; `index`; `index` |
| `renderBillWiseProfitReport` | 10 | `o.id`; `o.date`; `o.time &#124;&#124; ""`; `o.orderType`; `o.paymentMethod &#124;&#124; "Cash"` |
| `renderCart` | 8 | `item.price`; `formatRs(MoneyEngine.calculate({items:[item]}).total)`; `priceClass`; `noteClass`; `extra.qty` |
| `renderCartExtrasModalList` | 5 | `extra.qty`; `unitLabel`; `idx`; `cartExtrasModalTargetId`; `idx` |
| `renderCashBankScreen` | 4 | `index`; `index`; `index`; `index` |
| `renderCategoryOffersCheckboxList` | 1 | `discountLabel` |
| `renderDashboardLowStockList` | 6 | `qtyLabel`; `minLabel`; `displayUnits`; `threshold`; `Math.round(displayGrams).toLocaleString()` |
| `renderDealComponentsList` | 2 | `comp.qty`; `comp.itemId` |
| `renderEditAdditionalCharges` | 5 | `index`; `index`; `charge.value`; `index`; `index` |
| `renderEditHistoryModalList` | 2 | `o.id`; `o.id` |
| `renderEditItemsList` | 9 | `extra.qty`; `unitLabel`; `idx`; `exIdx`; `idx` |
| `renderEditOrderExtrasModalList` | 5 | `extra.qty`; `unitLabel`; `idx`; `editOrderExtrasTargetIdx`; `idx` |
| `renderExpenseBreakdownModal` | 1 | `e.label` |
| `renderExpenseHistory` | 7 | `color`; `label`; `formatRs(totalsByField[key])`; `e.date`; `label` |
| `renderExpensesReportTab` | 6 | `amt.toLocaleString()`; `pct`; `idx + 1`; `e.date`; `e.time &#124;&#124; ""` |
| `renderFoodGridOrderingUI` | 9 | `soldCount`; `imgElId`; `menuImageObjectUrlCache[item.id] &#124;&#124; ""`; `item.price`; `effectivePrice` |
| `renderHallsList` | 3 | `idx`; `idx`; `idx` |
| `renderIceCreamNameTable` | 1 | `data.sizes.map((s) => s + "g").join(", ")` |
| `renderIceCreamPurchaseHistory` | 6 | `emptyMsg`; `rowClass`; `p.date`; `p.time &#124;&#124; ""`; `weightDisplay` |
| `renderIceCreamStockRows` | 5 | `msg`; `stockDisplay`; `btoa(key)`; `ic.sellPrice &#124;&#124; 0`; `threshold` |
| `renderIngredientStockCards` | 6 | `minLabel`; `showWeightFirst ? piecesText : weightText`; `def.color`; `stockColor`; `mainDisplay` |
| `renderIngredientUsageReportTab` | 5 | `idx + 1`; `r.type`; `r.rateDisplay`; `r.consumedDisplay`; `pct` |
| `renderItemLedger` | 5 | `c.icon`; `c.label`; `Math.round(c.sales).toLocaleString()`; `Math.round(split.delivery).toLocaleString()`; `r.itemNumber` |
| `renderItemSalesLookup` | 4 | `queryInput.value`; `m.itemNumber ?? m.id`; `m.category`; `totalQty` |
| `renderLedgerRows` | 2 | `openingDate &#124;&#124; "Opening"`; `row.orderId` |
| `renderManagementMenuTable` | 5 | `item.price`; `item.offerPrice`; `item.price`; `catPrice`; `discountLabel` |
| `renderManualRecipeFields` | 4 | `unitLabel`; `unitLabel`; `cells[i]`; `cells[i + 1] &#124;&#124; '<div style="flex:1;"></div>'` |
| `renderMaterialBreakdownModal` | 3 | `e.icon`; `e.label`; `qtyDisplay` |
| `renderOrdersHistory` | 3 | `editCount`; `editCount`; `order.totalBill` |
| `renderPurchaseReportTab` | 7 | `idx + 1`; `p.date`; `p.time &#124;&#124; ""`; `p.type`; `p.qtyDisplay` |
| `renderSalesChannelBreakdownTable` | 14 | `c.color`; `c.icon`; `c.label`; `Math.round(c.sales).toLocaleString()`; `c.color` |
| `renderSoftDrinkBrandTable` | 1 | `data.sizes.join(", ")` |
| `renderSoftDrinkPurchaseHistory` | 6 | `emptyMsg`; `rowClass`; `p.date`; `p.time &#124;&#124; ""`; `p.unitsPurchased` |
| `renderSoftDrinkStockRows` | 5 | `msg`; `sd.stockUnits`; `btoa(key)`; `sd.sellPrice &#124;&#124; 0`; `threshold` |
| `renderStockItemTable` | 3 | `unitLabel(def.buyUnit)`; `unitLabel(def.sellUnit)`; `weightNote` |
| `renderStockPurchaseHistory` | 6 | `emptyMsg`; `p.date`; `p.time &#124;&#124; ""`; `qtyDisplay`; `p.amountPaid` |
| `renderStockThresholdSettingsRows` | 6 | `def.color`; `inputValue`; `step`; `unitLabel`; `def.color` |
| `renderStockValuationReportTab` | 4 | `idx + 1`; `s.group`; `s.qtyDisplay`; `s.rateDisplay` |
| `renderUnmeasurableStockWarning` | 2 | `b.usedBy.length`; `broken.length` |
| `showOrderInvoiceDetailsView` | 13 | `pillClass`; `item.originalPrice`; `extra.qty`; `unitLabel`; `item.qty` |
| `startAdjustStock` | 3 | `ingredient`; `current`; `unitShort` |
| `updateCartExtraCostPreview` | 1 | `perUnitNote` |
| `updateEditOrderExtraCostPreview` | 1 | `perUnitNote` |

Numeric arithmetic, `.toFixed()` output, literal status/class/color choices, and markup assembled only from encoded leaves remain unchanged. These are listed as retained safe paths below. Trusted composites are internal variables, not server-supplied HTML: cart/receipt names, badges, report rows, dropdown options and warning blocks encode their data in the builder before assignment. `renderManagementCategoryTable` already builds nodes with `textContent`.

## Every HTML sink

| Location | Enclosing function | Target | Treatment |
| --- | --- | --- | --- |
| HTML:13138 | `cloudRenderState` | `select.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:14700 | `renderLedgerRows` | `target.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:14707 | `renderCashBankScreen` | `cards.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:14714 | `renderCashBankScreen` | `accountCards.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:14745 | `renderCashBankScreen` | `panel.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:14751 | `renderCashBankScreen` | `panel.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:14773 | `populateLedgerMovementDestinations` | `select.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:14797 | `transferLedgerFunds` | `from.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:14797 | `transferLedgerFunds` | `to.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:15539 | `populateDineInTableSelect` | `select.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:15561 | `populateHallSelect` | `select.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:15605 | `renderHallsList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:15608 | `renderHallsList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:15732 | `setPaymentStatus` | `document.getElementById("balance-preview").innerHTML` | Retained: clear existing DOM; no data. |
| HTML:15755 | `populatePaymentBankAccounts` | `select.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:15806 | `renderCart` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:15811 | `renderCart` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:15861 | `renderCart` | `row.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:15976 | `populateCartExtraIngredientSelect` | `select.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:16024 | `updateCartExtraCostPreview` | `document.getElementById("cart-extra-cost-preview").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16106 | `renderCartExtrasModalList` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16112 | `renderCartExtrasModalList` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16151 | `renderAdditionalCharges` | `rows.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:16157 | `renderAdditionalCharges` | `row.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16187 | `renderAdditionalChargeSummary` | `target.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:16245 | `calculateCartTotal` | `balancePreview.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16247 | `calculateCartTotal` | `balancePreview.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16250 | `calculateCartTotal` | `balancePreview.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:16648 | `populateCustomerReceiptSlip` | `printCharges.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16661 | `populateCustomerReceiptSlip` | `printTbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:16673 | `populateCustomerReceiptSlip` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:16719 | `populateKitchenReceiptSlip` | `kTbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:16730 | `populateKitchenReceiptSlip` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:17611 | `openStockUnitSetup` | `overlay.innerHTML` | Retained: constant markup/text only. |
| HTML:17855 | `openCancelOrderModal` | `document.getElementById("cancel-order-modal-content").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:18271 | `submitOrder` | `document.getElementById("balance-preview").innerHTML` | Retained: clear existing DOM; no data. |
| HTML:18327 | `renderPinDots` | `display.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:18770 | `<listener>` | `t.innerHTML` | Retained: constant markup/text only. |
| HTML:18790 | `showBootFailure` | `document.getElementById("boot-splash-text").innerHTML` | Retained: constant markup/text only. |
| HTML:19122 | `renderFoodGridOrderingUI` | `grid.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:19243 | `renderFoodGridOrderingUI` | `card.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:19632 | `renderCategoryOffersCheckboxList` | `list.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:19648 | `renderCategoryOffersCheckboxList` | `row.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:19751 | `renderManagementMenuTable` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:19792 | `renderManagementMenuTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:19882 | `renderManagementMenuTable` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:19899 | `populateFormCategoryDropdown` | `select.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:19962 | `populateManagementCategoryFilter` | `select.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:20190 | `filterDealComponentDropdown` | `list.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:20277 | `renderDealComponentsList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:20281 | `renderDealComponentsList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:20346 | `renderManualRecipeFields` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:20510 | `openCostFieldsModal` | `list.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21197 | `toggleDashboardAmounts` | `btn.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:21242 | `renderDashboardLowStockList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21315 | `renderDashboardLowStockList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21401 | `renderUnmeasurableStockWarning` | `box.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:21405 | `renderUnmeasurableStockWarning` | `box.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21477 | `renderIngredientStockCards` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21706 | `renderStockThresholdSettingsRows` | `weightContainer.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21711 | `renderStockThresholdSettingsRows` | `pieceContainer.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21827 | `startAdjustStock` | `display.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:21937 | `populateStockIngredientSelect` | `select.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:22394 | `renderStockPurchaseHistory` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:22414 | `renderStockPurchaseHistory` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:22446 | `renderStockPurchaseHistory` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:22486 | `renderStockHistoryIngredientFilterOptions` | `container.innerHTML` | Retained: constant markup/text only. |
| HTML:22493 | `renderStockHistoryIngredientFilterOptions` | `container.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:22863 | `renderStockItemTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:22866 | `renderStockItemTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:22907 | `populateSoftDrinkBrandSelect` | `select.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:22927 | `populateSoftDrinkFlavorSelect` | `flavorSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:22933 | `populateSoftDrinkFlavorSelect` | `sizeSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:22978 | `addSoftDrinkBrandFlavorField` | `row.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:22994 | `addSoftDrinkBrandSizeField` | `row.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:23008 | `resetSoftDrinkBrandForm` | `document.getElementById("softdrink-brand-flavor-fields").innerHTML` | Retained: clear existing DOM; no data. |
| HTML:23011 | `resetSoftDrinkBrandForm` | `document.getElementById("softdrink-brand-size-fields").innerHTML` | Retained: clear existing DOM; no data. |
| HTML:23041 | `startEditSoftDrinkBrand` | `flavorContainer.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:23051 | `startEditSoftDrinkBrand` | `sizeContainer.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:23204 | `renderSoftDrinkBrandTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23208 | `renderSoftDrinkBrandTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23568 | `populateSoftDrinkStockFilterOptions` | `brandSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23571 | `populateSoftDrinkStockFilterOptions` | `flavorSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23574 | `populateSoftDrinkStockFilterOptions` | `sizeSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23644 | `renderSoftDrinkStockRows` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23648 | `renderSoftDrinkStockRows` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23720 | `renderSoftDrinkPurchaseHistory` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23729 | `renderSoftDrinkPurchaseHistory` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23811 | `populateIceCreamNameSelect` | `select.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23825 | `populateIceCreamFlavorSelect` | `flavorSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23831 | `populateIceCreamFlavorSelect` | `sizeSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:23874 | `addIceCreamNameFlavorField` | `row.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:23890 | `addIceCreamNameSizeField` | `row.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:23905 | `resetIceCreamNameForm` | `document.getElementById("icecream-name-flavor-fields").innerHTML` | Retained: clear existing DOM; no data. |
| HTML:23908 | `resetIceCreamNameForm` | `document.getElementById("icecream-name-size-fields").innerHTML` | Retained: clear existing DOM; no data. |
| HTML:23936 | `startEditIceCreamName` | `flavorContainer.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:23946 | `startEditIceCreamName` | `sizeContainer.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:24089 | `renderIceCreamNameTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24093 | `renderIceCreamNameTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24431 | `populateIceCreamStockFilterOptions` | `nameSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24434 | `populateIceCreamStockFilterOptions` | `flavorSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24437 | `populateIceCreamStockFilterOptions` | `sizeSelect.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24505 | `renderIceCreamStockRows` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24509 | `renderIceCreamStockRows` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24587 | `renderIceCreamPurchaseHistory` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24596 | `renderIceCreamPurchaseHistory` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:24876 | `renderExpenseFieldTable` | `tbody.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:24905 | `populateExpenseFieldSelect` | `select.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:24956 | `populateExpenseFieldFilter` | `select.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:25318 | `populateExpenseLedgerDestinations` | `select.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:25489 | `exportExpenseHistoryToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:25550 | `renderExpenseHistory` | `breakdownContainer.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:25578 | `renderExpenseHistory` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:25746 | `renderItemSalesLookup` | `resultBox.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:25767 | `renderItemSalesLookup` | `resultBox.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:25771 | `renderItemSalesLookup` | `resultBox.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26004 | `renderSalesChannelBreakdownTable` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26393 | `renderItemLedger` | `channelSplitEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26414 | `renderItemLedger` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:26420 | `renderItemLedger` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26605 | `renderMaterialBreakdownModal` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26639 | `renderMaterialBreakdownModal` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26719 | `renderExpenseBreakdownModal` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26739 | `renderExpenseBreakdownModal` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:26881 | `exportItemLedgerToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27122 | `calculateAndRenderBusinessReports` | `topItemsTbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27123 | `calculateAndRenderBusinessReports` | `topItemsGraphBox.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27131 | `calculateAndRenderBusinessReports` | `topItemsTbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27132 | `calculateAndRenderBusinessReports` | `topItemsGraphBox.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27137 | `calculateAndRenderBusinessReports` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27144 | `calculateAndRenderBusinessReports` | `barRow.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27157 | `calculateAndRenderBusinessReports` | `peakHoursTbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27158 | `calculateAndRenderBusinessReports` | `peakHoursGraphBox.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27166 | `calculateAndRenderBusinessReports` | `peakHoursTbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27167 | `calculateAndRenderBusinessReports` | `peakHoursGraphBox.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27172 | `calculateAndRenderBusinessReports` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27179 | `calculateAndRenderBusinessReports` | `barRow.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27229 | `populateReportExpenseCategoryDropdown` | `select.innerHTML` | Retained: constant markup/text only. |
| HTML:27271 | `renderBillWiseProfitReport` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27274 | `renderBillWiseProfitReport` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27293 | `renderBillWiseProfitReport` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27358 | `renderExpensesReportTab` | `progBox.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27361 | `renderExpensesReportTab` | `progBox.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27370 | `renderExpensesReportTab` | `row.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27387 | `renderExpensesReportTab` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27389 | `renderExpensesReportTab` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27395 | `renderExpensesReportTab` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27484 | `renderPurchaseReportTab` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27486 | `renderPurchaseReportTab` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27490 | `renderPurchaseReportTab` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27610 | `renderStockValuationReportTab` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27612 | `renderStockValuationReportTab` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27620 | `renderStockValuationReportTab` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27765 | `renderIngredientUsageReportTab` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:27767 | `renderIngredientUsageReportTab` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27772 | `renderIngredientUsageReportTab` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27843 | `exportBillWiseProfitToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27896 | `exportExpensesReportTabToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27941 | `exportPurchaseReportToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:27987 | `exportStockValuationToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:28034 | `exportIngredientUsageToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:28864 | `renderManagementCategoryTable` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:29416 | `exportOrdersHistoryToPDF` | `document.getElementById("print-orders-report").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:29460 | `renderOrdersHistory` | `tbody.innerHTML` | Retained: clear existing DOM; no data. |
| HTML:29492 | `renderOrdersHistory` | `tbody.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:29574 | `renderOrdersHistory` | `tr.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:29656 | `toggleSalesVisibility` | `btn.innerHTML` | Retained: constant markup/text only. |
| HTML:29658 | `toggleSalesVisibility` | `btn.innerHTML` | Retained: constant markup/text only. |
| HTML:29723 | `showOrderInvoiceDetailsView` | `modalContent.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30300 | `renderEditHistoryModalList` | `body.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30319 | `renderEditHistoryModalList` | `body.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30387 | `enterEditOrderMode` | `modalContent.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30552 | `populateEditPaymentAccounts` | `select.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30559 | `renderEditAdditionalCharges` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30592 | `renderEditItemsList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30596 | `renderEditItemsList` | `container.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30686 | `filterEditAddItemDropdown` | `list.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30798 | `populateEditOrderExtraIngredientSelect` | `select.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |
| HTML:30842 | `updateEditOrderExtraCostPreview` | `document.getElementById("edit-order-extra-cost-preview").innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30938 | `renderEditOrderExtrasModalList` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:30944 | `renderEditOrderExtrasModalList` | `listEl.innerHTML` | Encoded data in this renderer/builder; retained literal/numeric/composite markup. |
| HTML:31032 | `recalcEditTotals` | `editChargesSummary.innerHTML` | Retained: existing encoder, numeric formatting, literal status choices or encoded composite. |

## Every module sink

The real browser journey also caught a supplier dialog being moved out of the document into a detached node. Its creation flow now leaves the dialog attached; the test explicitly checks visibility before submitting.

Module UIs already use `textContent`, encoded HTML text, DOM-created options, and event listeners. No module data-field changes were necessary.

| Location | Target | Existing protection |
| --- | --- | --- |
| `src/client/billing-ui.mjs:130` | `container..innerHTML` | escapeHtml for plan names, codes, currency, IDs and payment references; numeric money; constant empty-state markup. |
| `src/client/billing-ui.mjs:140` | `container..innerHTML` | escapeHtml for plan names, codes, currency, IDs and payment references; numeric money; constant empty-state markup. |
| `src/client/billing-ui.mjs:160` | `container..innerHTML` | escapeHtml for plan names, codes, currency, IDs and payment references; numeric money; constant empty-state markup. |
| `src/client/billing-ui.mjs:163` | `container..innerHTML` | escapeHtml for plan names, codes, currency, IDs and payment references; numeric money; constant empty-state markup. |
| `src/client/billing-ui.mjs:199` | `container..innerHTML` | escapeHtml for plan names, codes, currency, IDs and payment references; numeric money; constant empty-state markup. |
| `src/client/billing-ui.mjs:202` | `container..innerHTML` | escapeHtml for plan names, codes, currency, IDs and payment references; numeric money; constant empty-state markup. |
| `src/client/billing-ui.mjs:268` | `container..innerHTML` | escapeHtml for plan names, codes, currency, IDs and payment references; numeric money; constant empty-state markup. |
| `src/client/finance-ui.mjs:24` | `container.querySelector("[data-results]")..innerHTML` | escapeFinanceText for category, description, dates and account names/IDs; numeric money/count; static controls. |
| `src/client/finance-ui.mjs:32` | `select..innerHTML` | escapeFinanceText for category, description, dates and account names/IDs; numeric money/count; static controls. |
| `src/client/finance-ui.mjs:34` | `container.querySelector("[data-results]")..innerHTML` | escapeFinanceText for category, description, dates and account names/IDs; numeric money/count; static controls. |
| `src/client/finance-ui.mjs:46` | `container..innerHTML` | escapeFinanceText for category, description, dates and account names/IDs; numeric money/count; static controls. |
| `src/client/inventory-ui.mjs:425` | `statusCell..innerHTML` | Constant stock-state badges; inventory names/SKUs/units through textContent and form values. |
| `src/client/order-cancellation-ui.mjs:87` | `overlay..innerHTML` | Static modal and encoded order identifier; user reason through textarea value. |
| `src/client/order-history-ui.mjs:121` | `errorEl..innerHTML` | escapeHtml for order/customer/channel/status/ID text and attributes; numeric money; clears/static empty state. |
| `src/client/order-history-ui.mjs:186` | `tr..innerHTML` | escapeHtml for order/customer/channel/status/ID text and attributes; numeric money; clears/static empty state. |
| `src/client/order-history-ui.mjs:221` | `if (!append) tbody..innerHTML` | escapeHtml for order/customer/channel/status/ID text and attributes; numeric money; clears/static empty state. |
| `src/client/order-history-ui.mjs:223` | `tbody..innerHTML` | escapeHtml for order/customer/channel/status/ID text and attributes; numeric money; clears/static empty state. |
| `src/client/order-refund-ui.mjs:162` | `overlay..innerHTML` | Static modal; amounts numeric; errors/reasons through textContent. |
| `src/client/purchases-ui.mjs:408` | `statusCell..innerHTML` | Closed status-to-badge mapping; supplier names/contact/notes through textContent and form values. |
| `src/client/sales-report-ui.mjs:172` | `containerEl..innerHTML` | escapeHtml for names/customer/channel labels and attributes; numeric money formatting; static controls. |
| `src/client/sales-report-ui.mjs:231` | `contentArea..innerHTML` | escapeHtml for names/customer/channel labels and attributes; numeric money formatting; static controls. |
| `src/client/sales-report-ui.mjs:409` | `contentArea..innerHTML` | escapeHtml for names/customer/channel labels and attributes; numeric money formatting; static controls. |

## Regression coverage

`tests/pos-xss-csp.test.mjs` checks five-character encoding, JavaScript argument round trips, CSS rejection, historical expense HTML, and report logging/body limits. `tests/browser/pos-xss-acceptance.spec.mjs` creates the exact `<img src=x onerror="window.__xss=1">` canary in menu/category, customer order, supplier and expense records against the real server, checks persistence on reload, visits their POS screens, and exercises imported historical renderers. It asserts no canary image element and no execution marker. Existing browser journeys cover receipt layout, editing, stock handlers and reporting. Static suites retain all prior characterization coverage.

## CSP rollout

POS responses use `Content-Security-Policy-Report-Only` and send legacy CSP reports to `/api/csp-report`. The endpoint accepts at most 8 KiB and 60 reports/minute/IP. It logs only directive, blocked-resource classification, and bounded line/column coordinates; URLs, original policy and script samples are discarded. The administrator panel keeps its separate enforced CSP.

Before changing to `Content-Security-Policy`: move inline POS scripts into same-origin modules (or authorize exact static scripts with reviewed hashes/nonces); replace every inline event attribute with registered listeners; remove dynamic JavaScript construction/eval; review inline styles and consider external CSS/nonces; verify blob/raster image and receipt/print/export flows; monitor legitimate violations across mobile and desktop. A nonce does not authorize inline event attributes. Test actual deployment paths, proxies and reports first, then enforce in staging before production. Report-only does not itself prevent XSS. Keep `/api/csp-report` body redaction and rate limiting when enforcing.
