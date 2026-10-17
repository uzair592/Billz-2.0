function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}
const $ = (id) => document.getElementById(id);
function bytes(value) {
  const count = Math.max(0, Number(value) || 0);
  if (count >= 1073741824) return `${(count / 1073741824).toFixed(2)} GB`;
  if (count >= 1048576) return `${(count / 1048576).toFixed(1)} MB`;
  if (count >= 1024) return `${(count / 1024).toFixed(1)} KB`;
  return `${count} B`;
}
function date(value) {
  return value ? new Date(value).toLocaleDateString() : "—";
}
function badge(value) {
  const kind = ["active", "approved"].includes(value)
    ? "good"
    : ["suspended", "disabled", "rejected", "deactivated"].includes(value)
      ? "bad"
      : "warning";
  return `<span class="badge ${kind}">${escapeHtml(value || "none")}</span>`;
}
function renderRestaurantRow(r) {
  return `<td><strong>${escapeHtml(r.code)}</strong></td><td>${escapeHtml(r.name)}</td><td>${badge(r.status)}</td>
    <td>${badge(r.subscriptionStatus)}<p class="muted">${escapeHtml(r.planName)}</p></td>
    <td>${bytes(r.usedStorageBytes)} / ${bytes(r.maxStorageBytes)}</td>
    <td><button class="btn secondary btn-manage" data-id="${escapeHtml(r.id)}">Manage</button></td>`;
}
function toast(message, error = false) {
  const node = document.createElement("div");
  node.className = `toast${error ? " error-toast" : ""}`;
  node.setAttribute("role", error ? "alert" : "status");
  node.textContent = message;
  $("toasts").replaceChildren();
  $("toasts").appendChild(node);
  setTimeout(() => node.remove(), error ? 10000 : 5000);
}
function handleError(error) {
  toast(error.message || "The request failed. Please try again.", true);
}
function pager(prefix, page, count, limit) {
  const pages = Math.max(1, Math.ceil(count / limit));
  $(`${prefix}-page-info`).textContent =
    `${count} records · Page ${page} of ${pages}`;
  $(`${prefix}-prev`).disabled = page <= 1;
  $(`${prefix}-next`).disabled = page >= pages;
}
function closeDialogs() {
  clearEnrollment();
  document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
  document.querySelectorAll('input[type="password"]').forEach((input) => {
    input.value = "";
  });
  $("temporary-password").value = "";
}
async function apiCall(path, options = {}) {
  const headers = { ...options.headers };
  if (!["GET", "HEAD"].includes((options.method || "GET").toUpperCase())) {
    headers["Content-Type"] = "application/json";
    if (!options.body) options.body = JSON.stringify({});
  }
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers,
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && data?.code === "UNAUTHENTICATED") {
      closeDialogs();
      $("login-view").classList.remove("hidden");
      $("portal-view").classList.add("hidden");
    }
    throw new Error(data?.error || `Request failed (${response.status}).`);
  }
  return data;
}
let restaurantPage = 1,
  auditPage = 1,
  paymentPage = 1,
  editingUser = null,
  editingBranch = null,
  plans = [],
  currentRestaurant = null,
  resetUser = null;
const pageSize = 20;
function showView(view) {
  clearEnrollment();
  for (const id of [
    "dashboard-page",
    "restaurants-page",
    "audits-page",
    "payments-page",
    "plans-page",
    "security-page",
    "sync-page",
    "analytics-page",
    "devices-page",
    "detail-view",
    "device-detail-view",
  ])
    $(id).classList.add("hidden");
  $(`${view}-page`).classList.remove("hidden");
  $("page-title").textContent = {
    dashboard: "Overview",
    restaurants: "Restaurants",
    audits: "Audit log",
    payments: "Payments",
    plans: "Subscription plans",
    security: "Administrator security",
    sync: "Offline sync & telemetry",
    analytics: "Platform financial analytics",
    devices: "Device registry",
  }[view];
  document
    .querySelectorAll("[data-view]")
    .forEach((button) =>
      button.classList.toggle("selected", button.dataset.view === view),
    );
}
async function checkAuth() {
  try {
    const data = await apiCall("/platform-admin/api/auth/me");
    $("admin-display-name").textContent = data.admin.displayName;
    $("login-view").classList.add("hidden");
    $("portal-view").classList.remove("hidden");
  } catch {
    return;
  }
  showView("dashboard");
  await Promise.all([loadDashboard(), loadRestaurants(), loadPlans()]).catch(
    handleError,
  );
}
async function loadDashboard() {
  const stats = await apiCall("/platform-admin/api/dashboard");
  for (const [id, key] of [
    ["stat-total", "totalRestaurants"],
    ["stat-active", "activeRestaurants"],
    ["stat-suspended", "suspendedRestaurants"],
    ["stat-pending", "pendingPayments"],
    ["stat-plans", "activePlans"],
    ["stat-trials", "activeTrials"],
    ["stat-expiring", "expiringSoon"],
  ])
    $(id).textContent = stats[key];
  $("stat-storage").textContent = bytes(stats.totalStorageUsedBytes);
}
let searchReqId = 0;
async function loadRestaurants() {
  const reqId = ++searchReqId;
  const query = new URLSearchParams({
    search: $("search-input").value,
    status: $("status-filter").value,
    page: restaurantPage,
    limit: pageSize,
    includeTotal: "true",
  });
  const tbody = $("restaurants-tbody");
  tbody.innerHTML =
    '<tr><td colspan="6" class="empty">Loading restaurants…</td></tr>';
  try {
    const data = await apiCall(`/platform-admin/api/restaurants?${query}`);
    if (reqId !== searchReqId) return;
    const list = data.restaurants || data;
    tbody.innerHTML = "";
    if (!list.length)
      tbody.innerHTML =
        '<tr><td colspan="6" class="empty">No restaurants match your search.</td></tr>';
    list.forEach((r) => {
      const tr = document.createElement("tr");
      tr.innerHTML = renderRestaurantRow(r);
      tbody.appendChild(tr);
    });
    pager(
      "restaurant",
      restaurantPage,
      data.totalCount ?? list.length,
      pageSize,
    );
  } catch (error) {
    if (reqId !== searchReqId) return;
    tbody.innerHTML =
      '<tr><td colspan="6" class="empty">Could not load restaurants. Change the filter to retry.</td></tr>';
    throw error;
  }
}
document.getElementById("search-input").addEventListener("input", () => {
  restaurantPage = 1;
  loadRestaurants().catch(handleError);
});
$("status-filter").addEventListener("change", () => {
  restaurantPage = 1;
  loadRestaurants().catch(handleError);
});
$("restaurant-prev").onclick = () => {
  restaurantPage--;
  loadRestaurants().catch(handleError);
};
$("restaurant-next").onclick = () => {
  restaurantPage++;
  loadRestaurants().catch(handleError);
};
$("restaurants-tbody").addEventListener("click", (event) => {
  const button = event.target.closest(".btn-manage");
  if (button) viewRestaurant(button.dataset.id).catch(handleError);
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("login-error").classList.add("hidden");
  try {
    await apiCall("/platform-admin/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        username: $("username").value,
        password: $("password").value,
        code: $("admin-login-code").value,
      }),
    });
    await checkAuth().catch(handleError);
  } catch (error) {
    $("login-error").textContent = error.message;
    $("login-error").classList.remove("hidden");
    handleError(error);
  } finally {
    $("password").value = "";
    $("admin-login-code").value = "";
    button.disabled = false;
  }
});
$("logout-btn").onclick = async () => {
  try {
    await apiCall("/platform-admin/api/auth/logout", { method: "POST" });
    closeDialogs();
    currentRestaurant = null;
    $("login-view").classList.remove("hidden");
    $("portal-view").classList.add("hidden");
  } catch (error) {
    handleError(error);
  }
};
document.querySelectorAll("[data-view]").forEach(
  (button) =>
    (button.onclick = () => {
      const view = button.dataset.view;
      showView(view);
      ({
        dashboard: loadDashboard,
        restaurants: loadRestaurants,
        audits: loadAudits,
        payments: loadPayments,
        plans: loadPlanCatalog,
        security: loadSecurity,
        sync: loadSyncMonitoring,
        analytics: loadAnalytics,
        devices: loadDevices,
      })
        [view]()
        .catch(handleError);
    }),
);
$("dashboard-restaurants").onclick = () => {
  showView("restaurants");
  loadRestaurants().catch(handleError);
};
$("open-create-modal").onclick = async () => {
  try {
    await loadPlans();
  } catch (error) {
    handleError(error);
    return;
  }
  if (!plans.length) {
    toast("No active plans are configured.", true);
    return;
  }
  $("create-error").classList.add("hidden");
  $("create-modal").showModal();
};
$("cancel-create-btn").onclick = () => $("create-modal").close();
$("create-modal").addEventListener("close", () => {
  $("create-owner-pass").value = "";
});
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => $(button.dataset.close).close()),
  );
$("create-restaurant-form").onsubmit = async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    await apiCall("/platform-admin/api/restaurants", {
      method: "POST",
      body: JSON.stringify({
        name: $("create-name").value,
        code: $("create-code").value,
        ownerUsername: $("create-owner-user").value,
        ownerPassword: $("create-owner-pass").value,
        ...($("create-owner-email").value
          ? { ownerEmail: $("create-owner-email").value }
          : {}),
        ...($("create-phone").value ? { phone: $("create-phone").value } : {}),
        planCode: $("create-plan").value,
      }),
    });
    $("create-modal").close();
    $("create-restaurant-form").reset();
    toast("Restaurant created.");
    restaurantPage = 1;
    await Promise.all([loadRestaurants(), loadDashboard()]);
  } catch (error) {
    $("create-error").textContent = error.message;
    $("create-error").classList.remove("hidden");
    handleError(error);
  } finally {
    event.submitter.disabled = false;
  }
};
function confirmAction(title, message) {
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  const dialog = $("confirm-dialog");
  dialog.returnValue = "";
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "accept"),
      { once: true },
    );
    dialog.showModal();
  });
}
$("confirm-cancel").onclick = () => $("confirm-dialog").close("cancel");
$("confirm-accept").onclick = () => $("confirm-dialog").close("accept");
async function confirmedMutation(title, message, path, body) {
  if (!(await confirmAction(title, message))) return false;
  await apiCall(path, { method: "POST", body: JSON.stringify(body || {}) });
  toast("Action completed.");
  await Promise.all([
    viewRestaurant(currentRestaurant.restaurant.id),
    loadRestaurants(),
    loadDashboard(),
  ]);
  return true;
}
function usersMarkup(users) {
  return users.length
    ? users
        .map(
          (
            user,
          ) => `<tr><td><strong>${escapeHtml(user.username || "—")}</strong></td><td>${escapeHtml(user.displayName)}</td><td>${escapeHtml(user.role)}</td><td>${badge(user.status)}</td>
    <td><div class="action-row"><button class="btn secondary user-edit" data-user="${escapeHtml(user.id)}">Edit user</button><button class="btn secondary user-reset" data-user="${escapeHtml(user.id)}">Reset password</button>
    <button class="btn ${user.status === "active" ? "danger" : "secondary"} user-status" data-user="${escapeHtml(user.id)}" data-status="${user.status === "active" ? "disabled" : "active"}">${user.status === "active" ? "Disable" : "Enable"}</button></div></td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty">No restaurant users found.</td></tr>';
}
function paymentsMarkup(payments) {
  return payments.length
    ? payments
        .map(
          (
            payment,
          ) => `<tr><td>${escapeHtml(payment.externalReference)}<p class="muted">${escapeHtml(payment.planName)}</p></td>
    <td>${escapeHtml(payment.currencyCode)} ${(Number(payment.amountMinor) / 100).toFixed(2)}</td><td>${badge(payment.status)}</td><td>${date(payment.coveredFrom)} – ${date(payment.coveredUntil)}</td>
    <td>${payment.status === "pending" ? `<div class="action-row"><button class="btn success btn-approve" data-pid="${escapeHtml(payment.id)}">Approve</button><button class="btn danger btn-reject" data-pid="${escapeHtml(payment.id)}">Reject</button></div>` : "—"}</td></tr>`,
        )
        .join("")
    : '<tr><td colspan="5" class="empty">No manual payments recorded.</td></tr>';
}
function branchesMarkup(branches) {
  return branches && branches.length
    ? branches
        .map(
          (b) => `<tr>
            <td><strong>${escapeHtml(b.code)}</strong></td>
            <td>${escapeHtml(b.name)}</td>
            <td>${escapeHtml(b.phone || "—")}<br><small class="muted">${escapeHtml(b.address || "No address")}</small></td>
            <td>${escapeHtml(b.timezone || "—")}</td>
            <td>${b.isActive ? '<span class="badge good">Active</span>' : '<span class="badge bad">Inactive</span>'}</td>
            <td>${b.isDefault ? '<span class="badge warning">Default</span>' : "—"}</td>
            <td><button class="btn secondary branch-edit" data-bid="${escapeHtml(b.id)}">Edit</button></td>
          </tr>`,
        )
        .join("")
    : '<tr><td colspan="7" class="empty">No branches configured. Click "+ Add branch" to create one.</td></tr>';
}
function restaurantSyncMarkup(syncList) {
  return syncList && syncList.length
    ? syncList
        .map((d) => {
          const isOnline = d.status === "online";
          const pendingBadge =
            d.pendingOrdersCount > 0
              ? `<span class="badge warning">${d.pendingOrdersCount} queued</span>`
              : '<span class="badge good">0</span>';
          const failedBadge =
            d.failedSyncCount > 0
              ? `<span class="badge bad">${d.failedSyncCount} failed</span>`
              : '<span class="badge good">0</span>';
          const syncErr = d.lastSyncError
            ? `<br><small class="muted" style="color:var(--danger)">${escapeHtml(d.lastSyncError)}</small>`
            : "";
          return `<tr>
            <td><strong>${escapeHtml(d.deviceName)}</strong><br><small class="muted">${escapeHtml(d.deviceId)}</small></td>
            <td>${escapeHtml(d.branchCode || "—")}</td>
            <td>${escapeHtml(d.platform || "Web")}<br><small class="muted">v${escapeHtml(d.appVersion || "1.0")}</small></td>
            <td>${pendingBadge}</td>
            <td>${failedBadge}</td>
            <td>${d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : "Never"}${syncErr}</td>
            <td><span class="badge ${isOnline ? "good" : "bad"}">${isOnline ? "Online" : "Offline"}</span></td>
          </tr>`;
        })
        .join("")
    : '<tr><td colspan="7" class="empty">No sync telemetry recorded for this restaurant yet.</td></tr>';
}
let detailReqId = 0;
async function viewRestaurant(id) {
  const requestId = ++detailReqId;
  currentRestaurant = null;
  $("edit-restaurant-btn").disabled = true;
  showView("restaurants");
  $("restaurants-page").classList.add("hidden");
  $("detail-view").classList.remove("hidden");
  $("page-title").textContent = "Restaurant details";
  $("detail-name").textContent = "Loading restaurant…";
  $("detail-content").innerHTML = '<p class="muted">Loading details…</p>';
  const data = await apiCall(
    `/platform-admin/api/restaurants/${encodeURIComponent(id)}`,
  );
  if (requestId !== detailReqId) return;
  currentRestaurant = data;
  $("edit-restaurant-btn").disabled = false;
  const r = data.restaurant,
    s = data.subscription,
    storage = data.storage;
  $("detail-name").textContent = `${r.name} (${r.code})`;
  const percentage = Math.min(
    100,
    Math.max(
      0,
      (Number(storage.usedStorageBytes) /
        Math.max(1, Number(storage.maxStorageBytes))) *
        100,
    ),
  );
  $("detail-content").innerHTML = `
    <div class="detail-grid"><article class="card"><h3>Restaurant information</h3>${badge(r.status)}<p class="contact">${escapeHtml(r.phone || "No phone provided")}<br>${escapeHtml(r.contactEmail || "No email provided")}<br>${escapeHtml(r.address || "No address provided")}</p>
      <button id="${r.status === "active" ? "suspend-btn" : "restore-btn"}" class="btn ${r.status === "active" ? "danger" : "success"}">${r.status === "active" ? "Suspend access" : "Restore access"}</button></article>
    <article class="card"><h3>Subscription</h3>${badge(s.status)}<p><strong>${escapeHtml(s.planName)}</strong> · ${escapeHtml(s.planCode || "—")}</p><p class="muted">${date(s.currentPeriodStart)} – ${date(s.currentPeriodEnd)}</p><p>${Number(s.maxDevices)} concurrent devices</p><button id="subscription-edit-btn" class="btn secondary">Assign / renew plan</button></article>
    <article class="card"><h3>File storage</h3><strong>${bytes(storage.usedStorageBytes)} / ${bytes(storage.maxStorageBytes)}</strong><progress max="100" value="${percentage}" aria-label="Storage used"></progress>
      <form id="storage-form"><label for="storage-limit">Allowance (GB)</label><input id="storage-limit" type="number" min="0" step="any" value="${Number(storage.maxStorageBytes) / 1073741824}" required /><button class="btn secondary" type="submit">Update allowance</button></form></article></div>
    <article class="card"><div class="section-heading"><div><h3>Branches</h3><p class="muted">Manage multiple branch outlets and locations for this restaurant.</p></div><button id="add-branch-btn" class="btn secondary">+ Add branch</button></div><div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Phone / Address</th><th>Timezone</th><th>Status</th><th>Default</th><th>Actions</th></tr></thead><tbody id="branches-tbody">${branchesMarkup(data.branches)}</tbody></table></div></article>
    <article class="card"><div class="section-heading"><div><h3>Device sync telemetry</h3><p class="muted">Live status of POS terminals, offline order queues and sync failures.</p></div><button id="refresh-restaurant-sync-btn" class="btn secondary">Refresh telemetry</button></div><div class="table-wrap"><table><thead><tr><th>Device</th><th>Branch</th><th>Platform / App</th><th>Queued orders</th><th>Failures</th><th>Last sync</th><th>Status</th></tr></thead><tbody id="restaurant-sync-tbody">${restaurantSyncMarkup(data.syncStatus)}</tbody></table></div></article>
    <article class="card"><div class="section-heading"><h3>Restaurant users</h3><button id="create-user-btn" class="btn secondary">+ Create user</button></div><div class="action-row"><button id="owner-credentials-btn" class="btn secondary">Manage owner credentials</button></div><p class="muted">Password resets and disabling users sign out their active devices.</p><div class="table-wrap"><table><thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody id="users-tbody">${usersMarkup(data.users)}</tbody></table></div></article>
    <article class="card"><div class="section-heading"><h3>Active devices / sessions</h3><button id="force-logout-btn" class="btn danger">Force logout all devices</button></div><p class="muted">One slot per active session; multiple tabs sharing a session use one slot.</p><div id="session-results">Loading sessions…</div></article>
    <article class="card"><h3>Record manual payment</h3><form id="record-pay-form" class="form-grid">
      <label for="pay-plan">Subscription plan<select id="pay-plan" required>${planOptions(s.planCode)}</select></label>
      <label for="pay-amount">Amount<input id="pay-amount" type="number" min="0" step="0.01" required /></label>
      <label for="pay-currency">Currency<input id="pay-currency" maxlength="3" pattern="[A-Z]{3}" required /></label>
      <label for="pay-from">Covered from<input id="pay-from" type="date" required /></label><label for="pay-until">Covered until<input id="pay-until" type="date" required /></label>
      <label for="pay-ref" class="span-two">Transaction reference<input id="pay-ref" required maxlength="200" /></label><div class="span-two"><button type="submit" class="btn">Record payment</button></div></form></article>
    <article class="card"><h3>Payment history</h3><div class="table-wrap"><table><thead><tr><th>Reference / plan</th><th>Amount</th><th>Status</th><th>Coverage</th><th>Actions</th></tr></thead><tbody>${paymentsMarkup(data.payments)}</tbody></table></div></article>`;
  $("add-branch-btn").onclick = () => openBranchModal();
  $("refresh-restaurant-sync-btn").onclick = async () => {
    try {
      const res = await apiCall(`/platform-admin/api/restaurants/${encodeURIComponent(id)}/sync-status`);
      currentRestaurant.syncStatus = res.devices || [];
      $("restaurant-sync-tbody").innerHTML = restaurantSyncMarkup(currentRestaurant.syncStatus);
      toast("Sync telemetry refreshed.");
    } catch (e) {
      handleError(e);
    }
  };
  $("create-user-btn").onclick = () => openUserModal();
  $("owner-credentials-btn").onclick = () => openOwnerCredentials(data);
  $("subscription-edit-btn").onclick = () =>
    openSubscription(data).catch(handleError);
  $("force-logout-btn").onclick = async () => {
    try {
      if (
        !(await confirmAction(
          "Force logout all devices?",
          "Every restaurant user must sign in again.",
        ))
      )
        return;
      await apiCall(
        `/platform-admin/api/restaurants/${encodeURIComponent(id)}/sessions/revoke-all`,
        {
          method: "POST",
          body: JSON.stringify({ reason: "Force logout through admin portal" }),
        },
      );
      toast("Restaurant sessions revoked.");
      await viewRestaurant(id);
    } catch (e) {
      handleError(e);
    }
  };
  loadSessions(id, requestId).catch(handleError);
  const start = new Date(),
    end = new Date(Date.now() + 30 * 86400000);
  const setPaymentPrice = () => {
    const price = plans.find((plan) => plan.code === $("pay-plan").value)
      ?.prices?.[0];
    $("pay-currency").value = price?.currencyCode || "PKR";
    $("pay-currency").readOnly = Boolean(price);
    $("pay-amount").value = price
      ? (Number(price.amountMinor) / 100).toFixed(2)
      : "";
  };
  $("pay-plan").onchange = setPaymentPrice;
  setPaymentPrice();
  $("pay-from").value = start.toISOString().slice(0, 10);
  $("pay-until").value = end.toISOString().slice(0, 10);
  $("suspend-btn")?.addEventListener("click", () =>
    confirmedMutation(
      "Suspend restaurant?",
      "Restaurant users will lose POS access.",
      `/platform-admin/api/restaurants/${id}/suspend`,
      { reason: "Suspended through admin portal" },
    ).catch(handleError),
  );
  $("restore-btn")?.addEventListener("click", () =>
    confirmedMutation(
      "Restore restaurant?",
      "Restore access subject to the restaurant's subscription.",
      `/platform-admin/api/restaurants/${id}/restore`,
    ).catch(handleError),
  );
  $("record-pay-form").onsubmit = async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      await apiCall(`/platform-admin/api/restaurants/${id}/payments`, {
        method: "POST",
        body: JSON.stringify({
          planCode: $("pay-plan").value,
          amountMinor: Math.round(Number($("pay-amount").value) * 100),
          currencyCode: $("pay-currency").value.toUpperCase(),
          paymentDate: new Date().toISOString(),
          coveredFrom: new Date($("pay-from").value).toISOString(),
          coveredUntil: new Date($("pay-until").value).toISOString(),
          externalReference: $("pay-ref").value,
        }),
      });
      toast("Payment recorded for review.");
      await Promise.all([viewRestaurant(id), loadDashboard()]);
    } catch (error) {
      handleError(error);
    } finally {
      event.submitter.disabled = false;
    }
  };
  $("storage-form").onsubmit = async (event) => {
    event.preventDefault();
    event.submitter.disabled = true;
    try {
      await apiCall(`/platform-admin/api/restaurants/${id}/storage-allowance`, {
        method: "PUT",
        body: JSON.stringify({
          maxStorageBytes: Math.round(
            Number($("storage-limit").value) * 1073741824,
          ),
        }),
      });
      toast("Storage allowance updated.");
      await viewRestaurant(id);
    } catch (error) {
      handleError(error);
    } finally {
      event.submitter.disabled = false;
    }
  };
}
$("close-detail-btn").onclick = () => {
  detailReqId++;
  showView("restaurants");
  loadRestaurants().catch(handleError);
};
$("detail-content").addEventListener("click", (event) => {
  const payment = event.target.closest(".btn-approve,.btn-reject");
  if (payment) {
    const approve = payment.classList.contains("btn-approve");
    confirmedMutation(
      approve ? "Approve payment?" : "Reject payment?",
      approve
        ? "This extends the subscription once. It does not restore an administrative suspension."
        : "This payment will not grant subscription access.",
      `/platform-admin/api/payments/${payment.dataset.pid}/${approve ? "approve" : "reject"}`,
    ).catch(handleError);
    return;
  }
  const branchEdit = event.target.closest(".branch-edit");
  if (branchEdit) {
    const branch = currentRestaurant.branches?.find(
      (b) => b.id === branchEdit.dataset.bid,
    );
    if (branch) openBranchModal(branch);
    return;
  }
  const edit = event.target.closest(".user-edit");
  if (edit) {
    openUserModal(
      currentRestaurant.users.find((user) => user.id === edit.dataset.user),
    );
    return;
  }
  const reset = event.target.closest(".user-reset");
  if (reset) {
    resetUser = currentRestaurant.users.find(
      (user) => user.id === reset.dataset.user,
    );
    $("reset-user-label").textContent =
      `${resetUser.username || resetUser.displayName} · ${currentRestaurant.restaurant.name}`;
    $("reset-generate").checked = true;
    $("reset-new-password").disabled = true;
    $("reset-new-password").required = false;
    $("reset-modal").showModal();
    return;
  }
  const status = event.target.closest(".user-status");
  if (status) {
    const disable = status.dataset.status === "disabled";
    confirmedMutation(
      disable ? "Disable user?" : "Enable user?",
      disable
        ? "This user will be signed out on all devices and unable to sign in."
        : "This user can sign in again. Previously revoked sessions stay revoked.",
      `/platform-admin/api/restaurants/${currentRestaurant.restaurant.id}/users/${status.dataset.user}/status`,
      { status: status.dataset.status },
    ).catch(handleError);
  }
});
$("edit-restaurant-btn").onclick = () => {
  if (!currentRestaurant) return;
  const r = currentRestaurant.restaurant;
  for (const [id, key] of [
    ["edit-name", "name"],
    ["edit-code", "code"],
    ["edit-phone", "phone"],
    ["edit-email", "contactEmail"],
    ["edit-address", "address"],
  ])
    $(id).value = r[key] || "";
  $("edit-modal").showModal();
};
$("edit-restaurant-form").onsubmit = async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    const id = currentRestaurant.restaurant.id;
    if (
      $("edit-code").value.trim().toLowerCase() !==
        currentRestaurant.restaurant.code &&
      !(await confirmAction(
        "Change restaurant code?",
        "All restaurant users must sign in again with the new code.",
      ))
    )
      return;
    await apiCall(`/platform-admin/api/restaurants/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("edit-name").value,
        ...($("edit-code").value.trim().toLowerCase() !==
        currentRestaurant.restaurant.code
          ? { code: $("edit-code").value }
          : {}),
        phone: $("edit-phone").value || null,
        contactEmail: $("edit-email").value || null,
        address: $("edit-address").value || null,
      }),
    });
    $("edit-modal").close();
    toast("Restaurant updated.");
    await Promise.all([viewRestaurant(id), loadRestaurants()]);
  } catch (error) {
    handleError(error);
  } finally {
    event.submitter.disabled = false;
  }
};
$("reset-generate").onchange = () => {
  $("reset-new-password").disabled = $("reset-generate").checked;
  $("reset-new-password").required = !$("reset-generate").checked;
  $("reset-new-password").value = "";
};
$("reset-modal").addEventListener("close", () => {
  $("reset-new-password").value = "";
  resetUser = null;
});
$("reset-password-form").onsubmit = async (event) => {
  event.preventDefault();
  event.submitter.disabled = true;
  try {
    const userId = resetUser.id,
      id = currentRestaurant.restaurant.id;
    if (
      !(await confirmAction(
        "Reset password?",
        "All active sessions for this user will be revoked.",
      ))
    )
      return;
    const payload = $("reset-generate").checked
      ? { generateTemporary: true }
      : { newPassword: $("reset-new-password").value };
    const result = await apiCall(
      `/platform-admin/api/restaurants/${id}/users/${userId}/reset-password`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    $("reset-modal").close();
    toast("Password reset. Active sessions revoked.");
    if (result.temporaryPassword) {
      $("temporary-password").value = result.temporaryPassword;
      $("temporary-password-modal").showModal();
    }
    await viewRestaurant(id);
  } catch (error) {
    handleError(error);
  } finally {
    event.submitter.disabled = false;
  }
};
$("temporary-password-modal").addEventListener("close", () => {
  $("temporary-password").value = "";
});
$("copy-temporary-password").onclick = async () => {
  try {
    await navigator.clipboard.writeText($("temporary-password").value);
    toast("Password copied.");
  } catch {
    $("temporary-password").focus();
    $("temporary-password").select();
    toast("Select and copy the password manually.");
  }
};
let auditReqId = 0;
async function loadAudits() {
  const reqId = ++auditReqId;
  $("audits-tbody").innerHTML =
    '<tr><td colspan="5" class="empty">Loading audit log…</td></tr>';
  try {
    const query = new URLSearchParams({
      page: auditPage,
      limit: pageSize,
      action: $("audit-search").value,
    });
    const data = await apiCall(`/platform-admin/api/audit-logs?${query}`);
    if (reqId !== auditReqId) return;
    $("audits-tbody").innerHTML = data.audits.length
      ? data.audits
          .map(
            (entry) =>
              `<tr><td>${escapeHtml(new Date(entry.createdAt).toLocaleString())}</td><td>${escapeHtml(entry.actorName)}<p class="muted">${escapeHtml(entry.actorType)}</p></td><td>${escapeHtml(entry.action)}</td><td>${escapeHtml(entry.restaurantId || "Platform")}<p class="muted">${escapeHtml(entry.resourceType)} · ${escapeHtml(entry.resourceId)}</p></td><td class="audit-details">${escapeHtml(JSON.stringify(entry.metadata, null, 2))}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">No audit entries match this filter.</td></tr>';
    pager("audit", auditPage, data.totalCount, pageSize);
  } catch (error) {
    if (reqId !== auditReqId) return;
    $("audits-tbody").innerHTML =
      '<tr><td colspan="5" class="empty">Could not load audit log. Use Refresh to retry.</td></tr>';
    throw error;
  }
}
$("refresh-audits").onclick = () => loadAudits().catch(handleError);
$("audit-search").oninput = () => {
  auditPage = 1;
  loadAudits().catch(handleError);
};
$("audit-prev").onclick = () => {
  auditPage--;
  loadAudits().catch(handleError);
};
$("audit-next").onclick = () => {
  auditPage++;
  loadAudits().catch(handleError);
};
checkAuth().catch(handleError);

function planOptions(selected) {
  return plans
    .map(
      (plan) =>
        `<option value="${escapeHtml(plan.code)}" ${plan.code === selected ? "selected" : ""}>${escapeHtml(plan.name)} (${escapeHtml(plan.code)})</option>`,
    )
    .join("");
}
async function loadPlans() {
  const catalog = [];
  for (let page = 1; ; page += 1) {
    const data = await apiCall(
      `/platform-admin/api/plans?page=${page}&limit=100`,
    );
    catalog.push(...data.plans);
    if (
      !data.plans.length ||
      catalog.length >= (data.totalCount ?? catalog.length)
    )
      break;
  }
  plans = catalog;
  $("create-plan").innerHTML = planOptions("GROWTH");
  if (!plans.length)
    toast(
      "Create an active subscription plan before provisioning a restaurant.",
      true,
    );
}
function openUserModal(user = null) {
  editingUser = user;
  $("user-modal-title").textContent = user ? "Edit user" : "Create user";
  $("user-username").value = user?.username || "";
  $("user-display-name").value = user?.displayName || "";
  $("user-role").value = user?.role || "cashier";
  $("user-role").disabled = Boolean(user);
  $("user-password").value = "";
  $("user-password").hidden = Boolean(user);
  $("user-password-label").hidden = Boolean(user);
  $("user-password").required = !user;
  $("user-modal").showModal();
}
$("user-modal").addEventListener("close", () => {
  $("user-password").value = "";
  editingUser = null;
});
$("user-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  const id = currentRestaurant.restaurant.id,
    user = editingUser;
  try {
    const payload = { displayName: $("user-display-name").value };
    if (!user || $("user-username").value !== user.username)
      payload.username = $("user-username").value;
    if (
      user &&
      payload.username &&
      !(await confirmAction(
        "Change username?",
        "All active sessions for this user will be revoked.",
      ))
    )
      return;
    if (!user)
      Object.assign(payload, {
        role: $("user-role").value,
        password: $("user-password").value,
      });
    await apiCall(
      `/platform-admin/api/restaurants/${id}/users${user ? `/${user.id}` : ""}`,
      { method: user ? "PATCH" : "POST", body: JSON.stringify(payload) },
    );
    $("user-modal").close();
    toast(user ? "User updated." : "User created.");
    await viewRestaurant(id);
  } catch (error) {
    handleError(error);
  } finally {
    $("user-password").value = "";
    button.disabled = false;
  }
};
let paymentReqId = 0;
async function loadPayments() {
  const req = ++paymentReqId;
  $("payments-tbody").innerHTML =
    '<tr><td colspan="6" class="empty">Loading payments…</td></tr>';
  try {
    const data = await apiCall(
      `/platform-admin/api/payments?${new URLSearchParams({ status: $("payment-filter").value, page: paymentPage, limit: pageSize })}`,
    );
    if (req !== paymentReqId) return;
    $("payments-tbody").innerHTML = data.payments.length
      ? data.payments
          .map(
            (payment) =>
              `<tr><td><button class="btn secondary payment-restaurant" data-id="${escapeHtml(payment.restaurantId)}">${escapeHtml(payment.restaurantName)}</button><p class="muted">${escapeHtml(payment.restaurantCode)}</p></td>${paymentsMarkup([payment]).replace(/^<tr>|<\/tr>$/g, "")}</tr>`,
          )
          .join("")
      : '<tr><td colspan="6" class="empty">No payments match this filter.</td></tr>';
    pager("payment", paymentPage, data.totalCount, pageSize);
  } catch (error) {
    if (req !== paymentReqId) return;
    $("payments-tbody").innerHTML =
      '<tr><td colspan="6" class="empty">Could not load payments. Change the filter to retry.</td></tr>';
    throw error;
  }
}
$("payment-filter").onchange = () => {
  paymentPage = 1;
  loadPayments().catch(handleError);
};
$("payment-prev").onclick = () => {
  paymentPage--;
  loadPayments().catch(handleError);
};
$("payment-next").onclick = () => {
  paymentPage++;
  loadPayments().catch(handleError);
};
$("payments-tbody").onclick = async (event) => {
  const manage = event.target.closest(".payment-restaurant");
  if (manage) {
    viewRestaurant(manage.dataset.id).catch(handleError);
    return;
  }
  const payment = event.target.closest(".btn-approve,.btn-reject");
  if (!payment) return;
  const approve = payment.classList.contains("btn-approve");
  payment.disabled = true;
  try {
    if (
      !(await confirmAction(
        approve ? "Approve payment?" : "Reject payment?",
        approve
          ? "Extend access once; administrative suspension stays in place."
          : "This payment will not grant access.",
      ))
    )
      return;
    await apiCall(
      `/platform-admin/api/payments/${payment.dataset.pid}/${approve ? "approve" : "reject"}`,
      { method: "POST", body: "{}" },
    );
    toast("Payment reviewed.");
    await Promise.all([loadPayments(), loadDashboard()]);
  } catch (error) {
    handleError(error);
  } finally {
    payment.disabled = false;
  }
};

let planPage = 1,
  planRecords = [],
  editingPlan = null,
  ownerTarget = null,
  subscriptionTarget = null,
  planRequestId = 0;
const intervalLabels = {
  month: "Monthly",
  quarter: "Quarterly",
  year: "Yearly",
  trial: "Custom trial",
};
async function loadPlanCatalog() {
  const request = ++planRequestId;
  $("plans-tbody").innerHTML =
    '<tr><td colspan="6" class="empty">Loading plans…</td></tr>';
  try {
    const data = await apiCall(
      `/platform-admin/api/plans?includeInactive=true&page=${planPage}&limit=${pageSize}`,
    );
    if (request !== planRequestId) return;
    planRecords = data.plans;
    $("plans-tbody").innerHTML = data.plans.length
      ? data.plans
          .map((plan) => {
            const price = plan.prices[0];
            return `<tr><td><strong>${escapeHtml(plan.name)}</strong><p class="muted">${escapeHtml(plan.code)}</p></td><td>${price ? `${escapeHtml(price.currencyCode)} ${(Number(price.amountMinor) / 100).toFixed(2)} · ${escapeHtml(intervalLabels[price.billingInterval])}` : "No manual price"}</td><td>${Number(plan.maxDevices)}</td><td>${Number(plan.trialDays)}</td><td>${badge(plan.isActive ? "active" : "archived")}</td><td><div class="action-row"><button class="btn secondary plan-edit" data-id="${escapeHtml(plan.id)}">Edit</button><button class="btn secondary plan-toggle" data-id="${escapeHtml(plan.id)}">${plan.isActive ? "Archive" : "Activate"}</button><button class="btn danger plan-delete" data-id="${escapeHtml(plan.id)}">Delete unused</button></div></td></tr>`;
          })
          .join("")
      : '<tr><td colspan="6" class="empty">No plans yet. Create a plan to onboard restaurants.</td></tr>';
    pager("plan", planPage, data.totalCount, pageSize);
  } catch (e) {
    if (request === planRequestId)
      $("plans-tbody").innerHTML =
        '<tr><td colspan="6" class="empty">Could not load plans. Open Plans again to retry.</td></tr>';
    throw e;
  }
}
function openPlan(plan = null) {
  editingPlan = plan;
  const price = plan?.prices[0];
  $("plan-modal-title").textContent = plan
    ? "Edit subscription plan"
    : "Create subscription plan";
  $("plan-name").value = plan?.name || "";
  $("plan-code").value = plan?.code || "";
  $("plan-interval").value = price?.billingInterval || "month";
  $("plan-price").value = Number(price?.amountMinor ?? 0) / 100;
  $("plan-currency").value = price?.currencyCode || "PKR";
  $("plan-devices").value = plan?.maxDevices || 3;
  $("plan-trial-days").value = plan?.trialDays || 14;
  $("plan-active").checked = plan?.isActive ?? true;
  $("plan-modal").showModal();
}
$("new-plan-btn").onclick = () => openPlan();
$("plan-prev").onclick = () => {
  planPage--;
  loadPlanCatalog().catch(handleError);
};
$("plan-next").onclick = () => {
  planPage++;
  loadPlanCatalog().catch(handleError);
};
$("plan-interval").onchange = () => {
  if ($("plan-interval").value === "trial") $("plan-price").value = 0;
};
$("plans-tbody").onclick = async (event) => {
  const button = event.target.closest("button[data-id]");
  if (!button) return;
  const plan = planRecords.find((p) => p.id === button.dataset.id);
  if (!plan) return;
  if (button.classList.contains("plan-edit")) {
    openPlan(plan);
    return;
  }
  const remove = button.classList.contains("plan-delete");
  const action = remove ? "delete" : plan.isActive ? "archive" : "activate";
  try {
    if (
      !(await confirmAction(
        `${action[0].toUpperCase() + action.slice(1)} plan?`,
        remove
          ? "Plans with billing history must be archived, and cannot be deleted."
          : action === "archive"
            ? "Existing subscribers retain access. New assignments are disabled."
            : "Allow new assignments to this plan.",
      ))
    )
      return;
    button.disabled = true;
    await apiCall(
      `/platform-admin/api/plans/${encodeURIComponent(plan.id)}${remove ? "" : `/${action}`}`,
      { method: remove ? "DELETE" : "POST" },
    );
    toast("Plan updated.");
    await Promise.all([loadPlanCatalog(), loadPlans(), loadDashboard()]);
  } catch (e) {
    handleError(e);
  } finally {
    button.disabled = false;
  }
};
$("plan-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter,
    plan = editingPlan;
  button.disabled = true;
  try {
    if (
      plan &&
      !(await confirmAction(
        "Update plan?",
        "New prices apply to future assignments. Lower device limits sign out excess sessions, keeping the most recently used.",
      ))
    )
      return;
    const body = {
      name: $("plan-name").value,
      code: $("plan-code").value.toUpperCase(),
      billingInterval: $("plan-interval").value,
      amountMinor: Math.round(Number($("plan-price").value) * 100),
      currencyCode: $("plan-currency").value.toUpperCase(),
      maxDevices: Number($("plan-devices").value),
      trialDays: Number($("plan-trial-days").value),
      isActive: $("plan-active").checked,
    };
    await apiCall(
      `/platform-admin/api/plans${plan ? `/${encodeURIComponent(plan.id)}` : ""}`,
      { method: plan ? "PATCH" : "POST", body: JSON.stringify(body) },
    );
    $("plan-modal").close();
    toast("Plan saved.");
    await Promise.all([loadPlanCatalog(), loadPlans(), loadDashboard()]);
  } catch (e) {
    handleError(e);
  } finally {
    button.disabled = false;
  }
};
async function loadSessions(id, requestId) {
  const data = await apiCall(
    `/platform-admin/api/restaurants/${encodeURIComponent(id)}/sessions`,
  );
  if (requestId !== detailReqId) return;
  $("session-results").innerHTML = data.sessions.length
    ? `<p><strong>${data.sessions.length} active sessions</strong></p><div class="table-wrap"><table><thead><tr><th>User</th><th>Device / client</th><th>IP</th><th>Last seen</th><th>Expires</th></tr></thead><tbody>${data.sessions.map((s) => `<tr><td>${escapeHtml(s.username || s.displayName)}</td><td>${escapeHtml(s.userAgent || "Unknown client")}</td><td>${escapeHtml(s.ipAddress || "—")}</td><td>${escapeHtml(new Date(s.lastSeenAt).toLocaleString())}</td><td>${escapeHtml(new Date(s.expiresAt).toLocaleString())}</td></tr>`).join("")}</tbody></table></div>`
    : '<p class="muted">No active restaurant sessions.</p>';
}
function openOwnerCredentials(data) {
  const owners = data.users.filter((u) => u.role === "owner");
  if (owners.length !== 1) {
    toast(
      "Use the user table to reset a specific owner; this shortcut requires exactly one owner.",
      true,
    );
    return;
  }
  ownerTarget = { restaurantId: data.restaurant.id, owner: owners[0] };
  $("owner-credentials-context").textContent =
    `${data.restaurant.name} · ${owners[0].username}`;
  $("owner-login-email").value = owners[0].email || "";
  $("owner-new-password").value = "";
  $("owner-new-password").disabled = false;
  $("owner-generate-password").checked = false;
  $("owner-credential-reason").value = "";
  $("owner-credentials-modal").showModal();
}
$("owner-generate-password").onchange = () => {
  $("owner-new-password").value = "";
  $("owner-new-password").disabled = $("owner-generate-password").checked;
};
$("owner-credentials-modal").addEventListener("close", () => {
  $("owner-new-password").value = "";
  ownerTarget = null;
});
$("owner-credentials-form").onsubmit = async (event) => {
  event.preventDefault();
  const target = ownerTarget,
    button = event.submitter;
  button.disabled = true;
  try {
    if (
      !(await confirmAction(
        "Change owner credentials?",
        "Every owner session is revoked. The owner must sign in again.",
      ))
    )
      return;
    const payload = {
      reason: $("owner-credential-reason").value,
      generateTemporary: $("owner-generate-password").checked,
    };
    const email = $("owner-login-email").value.trim();
    if (
      email &&
      email.toLowerCase() !== (target.owner.email || "").toLowerCase()
    )
      payload.email = email;
    if ($("owner-new-password").value)
      payload.newPassword = $("owner-new-password").value;
    const result = await apiCall(
      `/platform-admin/api/restaurants/${encodeURIComponent(target.restaurantId)}/owner-credentials`,
      { method: "POST", body: JSON.stringify(payload) },
    );
    $("owner-credentials-modal").close();
    toast("Owner credentials changed; active sessions revoked.");
    if (result.temporaryPassword) {
      $("temporary-password").value = result.temporaryPassword;
      $("temporary-password-modal").showModal();
    }
    await viewRestaurant(target.restaurantId);
  } catch (e) {
    handleError(e);
  } finally {
    $("owner-new-password").value = "";
    button.disabled = false;
  }
};
async function openSubscription(data) {
  await loadPlans();
  subscriptionTarget = data.restaurant.id;
  $("subscription-plan").innerHTML = plans
    .map(
      (p) =>
        `<option value="${escapeHtml(p.id)}" ${p.id === data.subscription.planId ? "selected" : ""}>${escapeHtml(p.name)} · ${Number(p.maxDevices)} devices</option>`,
    )
    .join("");
  $("subscription-mode").value = "renew";
  $("subscription-expiry").value = "";
  $("subscription-reason").value = "";
  $("subscription-modal").showModal();
}
$("subscription-form").onsubmit = async (event) => {
  event.preventDefault();
  const id = subscriptionTarget,
    button = event.submitter;
  button.disabled = true;
  try {
    if (
      !(await confirmAction(
        "Assign / renew subscription?",
        "This changes access and may revoke excess device sessions. Administrative suspension stays in place.",
      ))
    )
      return;
    const payload = {
      planId: $("subscription-plan").value,
      mode: $("subscription-mode").value,
      reason: $("subscription-reason").value,
    };
    if ($("subscription-expiry").value)
      payload.expiresAt = new Date(
        `${$("subscription-expiry").value}T23:59:59.999Z`,
      ).toISOString();
    await apiCall(
      `/platform-admin/api/restaurants/${encodeURIComponent(id)}/subscription`,
      { method: "PUT", body: JSON.stringify(payload) },
    );
    $("subscription-modal").close();
    toast("Subscription updated.");
    await Promise.all([viewRestaurant(id), loadDashboard()]);
  } catch (e) {
    handleError(e);
  } finally {
    button.disabled = false;
  }
};

let mfaEnrollmentId = null;
function clearEnrollment() {
  mfaEnrollmentId = null;
  for (const id of ['mfa-uri','mfa-verify-code','mfa-manage-code','mfa-start-password','mfa-manage-password']) $(id).value = '';
  $('mfa-recovery-codes').textContent = '';
  $('mfa-once').classList.add('hidden');
}
async function loadSecurity() {
  const state = await apiCall('/platform-admin/api/security/2fa');
  $('mfa-status').textContent = state.enabled ? `2FA enabled · ${state.recoveryCodesRemaining} recovery codes remaining` : '2FA is disabled. Enrollment requires your current password.';
  $('mfa-start-form').classList.toggle('hidden', state.enabled);
  $('mfa-manage-form').classList.toggle('hidden', !state.enabled);
}
function showMfaOnce(data) {
  clearEnrollment();
  mfaEnrollmentId = data.enrollmentId || null;
  $('mfa-uri').value = data.otpauthUri || '';
  $('mfa-uri').hidden = !data.otpauthUri;
  document.querySelector('label[for="mfa-uri"]').hidden = !data.otpauthUri;
  $('mfa-recovery-codes').textContent = data.recoveryCodes.join('\n');
  $('mfa-verify-form').classList.toggle('hidden', !data.enrollmentId);
  $('mfa-once').classList.remove('hidden');
}
for (const [id, action] of [['mfa-start-form','start'],['mfa-verify-form','verify'],['mfa-manage-form',null]]) {
  $(id).onsubmit = async event => {
    event.preventDefault();const button = event.submitter;button.disabled = true;
    try {
      const path = action || $('mfa-action').value;
      const payload = path === 'start' ? {currentPassword:$('mfa-start-password').value}
        : path === 'verify' ? {enrollmentId:mfaEnrollmentId,code:$('mfa-verify-code').value}
        : {currentPassword:$('mfa-manage-password').value,code:$('mfa-manage-code').value};
      const data = await apiCall(`/platform-admin/api/security/2fa/${path}`,{method:'POST',body:JSON.stringify(payload)});
      if (data.recoveryCodes) showMfaOnce(data);else clearEnrollment();
      await loadSecurity();toast(path === 'verify' ? '2FA enabled. Other administrator sessions signed out.' : 'Security settings updated.');
    }catch(error){handleError(error);}finally{
      $('mfa-start-password').value='';$('mfa-manage-password').value='';$('mfa-manage-code').value='';$('mfa-verify-code').value='';button.disabled=false;
    }
  };
}
window.addEventListener('pagehide',clearEnrollment);

function openBranchModal(branch = null) {
  editingBranch = branch;
  $("branch-modal-title").textContent = branch ? "Edit branch" : "Create branch";
  $("branch-name").value = branch?.name || "";
  $("branch-code").value = branch?.code || "";
  $("branch-code").disabled = Boolean(branch);
  $("branch-phone").value = branch?.phone || "";
  $("branch-address").value = branch?.address || "";
  $("branch-timezone").value = branch?.timezone || "Asia/Karachi";
  $("branch-active").checked = branch ? Boolean(branch.isActive) : true;
  $("branch-default").checked = branch ? Boolean(branch.isDefault) : false;
  $("branch-modal").showModal();
}
$("branch-modal").addEventListener("close", () => {
  editingBranch = null;
  $("branch-code").disabled = false;
});
$("branch-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  try {
    const restaurantId = currentRestaurant.restaurant.id;
    const payload = {
      name: $("branch-name").value.trim(),
      phone: $("branch-phone").value.trim() || null,
      address: $("branch-address").value.trim() || null,
      timezone: $("branch-timezone").value.trim() || "Asia/Karachi",
      isActive: $("branch-active").checked,
      isDefault: $("branch-default").checked,
    };
    if (editingBranch) {
      await apiCall(
        `/platform-admin/api/restaurants/${encodeURIComponent(restaurantId)}/branches/${encodeURIComponent(editingBranch.id)}`,
        { method: "PATCH", body: JSON.stringify(payload) },
      );
      toast("Branch updated.");
    } else {
      payload.code = $("branch-code").value.trim().toLowerCase();
      await apiCall(
        `/platform-admin/api/restaurants/${encodeURIComponent(restaurantId)}/branches`,
        { method: "POST", body: JSON.stringify(payload) },
      );
      toast("Branch created.");
    }
    $("branch-modal").close();
    await viewRestaurant(restaurantId);
  } catch (error) {
    handleError(error);
  } finally {
    button.disabled = false;
  }
};

async function loadSyncMonitoring() {
  $("sync-tbody").innerHTML =
    '<tr><td colspan="8" class="empty">Loading sync telemetry…</td></tr>';
  try {
    const data = await apiCall("/platform-admin/api/sync-monitoring");
    const s = data.summary || {};
    $("sync-stat-total").textContent = s.totalDevices ?? 0;
    $("sync-stat-online").textContent = s.onlineNow ?? 0;
    $("sync-stat-pending").textContent = s.totalPendingOrders ?? 0;
    $("sync-stat-failed").textContent = s.totalFailedJobs ?? 0;
    $("sync-stat-errors").textContent = s.errorDevices ?? 0;

    const list = data.devices || [];
    $("sync-tbody").innerHTML = list.length
      ? list
          .map((d) => {
            const isOnline = d.status === "online";
            const pendingBadge =
              d.pendingOrdersCount > 0
                ? `<span class="badge warning">${d.pendingOrdersCount} queued</span>`
                : '<span class="badge good">0</span>';
            const failedBadge =
              d.failedSyncCount > 0
                ? `<span class="badge bad">${d.failedSyncCount} failed</span>`
                : '<span class="badge good">0</span>';
            const syncErr = d.lastSyncError
              ? `<br><small class="muted" style="color:var(--danger)">${escapeHtml(d.lastSyncError)}</small>`
              : "";
            return `<tr>
              <td><strong>${escapeHtml(d.restaurantName || "—")}</strong><br><small class="muted">${escapeHtml(d.restaurantCode || "")}</small></td>
              <td><strong>${escapeHtml(d.deviceName)}</strong><br><small class="muted">${escapeHtml(d.deviceId)}</small></td>
              <td>${escapeHtml(d.branchCode || "—")}</td>
              <td>${escapeHtml(d.platform || "Web")}<br><small class="muted">v${escapeHtml(d.appVersion || "1.0")}</small></td>
              <td>${pendingBadge}</td>
              <td>${failedBadge}</td>
              <td>${d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : "Never"}${syncErr}</td>
              <td><span class="badge ${isOnline ? "good" : "bad"}">${isOnline ? "Online" : "Offline"}</span></td>
            </tr>`;
          })
          .join("")
      : '<tr><td colspan="8" class="empty">No sync telemetry records found.</td></tr>';
  } catch (error) {
    $("sync-tbody").innerHTML =
      '<tr><td colspan="8" class="empty">Failed to load sync telemetry.</td></tr>';
    throw error;
  }
}
$("refresh-sync-btn").onclick = () => loadSyncMonitoring().catch(handleError);

async function loadAnalytics() {
  try {
    const data = await apiCall("/platform-admin/api/analytics/overview");
    const o = data.overview || {};
    const formatCurrency = (minor) =>
      `PKR ${(Number(minor || 0) / 100).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

    $("analytics-mrr").textContent = formatCurrency(o.mrrMinor);
    $("analytics-arr").textContent = formatCurrency(o.arrMinor);
    $("analytics-30d-rev").textContent = formatCurrency(o.revenueLast30DaysMinor);
    $("analytics-total-rev").textContent = formatCurrency(o.totalVerifiedRevenueMinor);
    $("analytics-active-subs").textContent = o.activeSubscriptions ?? 0;
    $("analytics-trial-subs").textContent = o.trialSubscriptions ?? 0;
    $("analytics-churned-subs").textContent = o.churnedSubscriptions ?? 0;
    $("analytics-churn-rate").textContent = `${o.churnRatePercentage ?? 0}%`;

    const plansTable = $("analytics-plans-tbody");
    plansTable.innerHTML = (data.plansBreakdown || []).length
      ? data.plansBreakdown
          .map(
            (p) => `<tr>
              <td><strong>${escapeHtml(p.name)}</strong></td>
              <td><code>${escapeHtml(p.code)}</code></td>
              <td>${p.activeSubscribers}</td>
              <td>${p.totalSubscribers}</td>
              <td><strong>${formatCurrency(p.mrrContributionMinor)}</strong></td>
            </tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">No active plans.</td></tr>';

    const paymentsTable = $("analytics-payments-tbody");
    paymentsTable.innerHTML = (data.recentPayments || []).length
      ? data.recentPayments
          .map(
            (p) => `<tr>
              <td>${date(p.paymentDate)}</td>
              <td><strong>${escapeHtml(p.restaurantName || "—")}</strong> <small class="muted">(${escapeHtml(p.restaurantCode || "")})</small></td>
              <td>${escapeHtml(p.planName || "—")}</td>
              <td><strong>${escapeHtml(p.currencyCode)} ${(Number(p.amountMinor) / 100).toFixed(2)}</strong></td>
              <td><code>${escapeHtml(p.externalReference || "—")}</code></td>
            </tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">No verified payments found.</td></tr>';
  } catch (error) {
    handleError(error);
  }
}
$("export-payments-csv-btn").onclick = async () => {
  try {
    const res = await fetch(
      "/platform-admin/api/analytics/export-payments.csv",
      { credentials: "same-origin" },
    );
    if (!res.ok) throw new Error(`Export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `platform_payments_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Payments CSV exported.");
  } catch (error) {
    handleError(error);
  }
};

// --- DEDICATED DEVICE MANAGEMENT MODULE ---
let devicePage = 1;
let deviceTotalCount = 0;
let currentDevice = null;
let deviceSearchReqId = 0;
let cachedRestaurantsForDevices = [];

function deviceBadge(calculatedStatus, persistentStatus) {
  if (persistentStatus === "revoked" || calculatedStatus === "revoked") {
    return '<span class="badge bad">Revoked</span>';
  }
  switch (calculatedStatus) {
    case "online":
      return '<span class="badge good">Online</span>';
    case "offline":
      return '<span class="badge warning">Offline</span>';
    case "stale":
      return '<span class="badge warning" style="opacity:0.8">Stale (&gt;24h)</span>';
    default:
      return `<span class="badge">${escapeHtml(calculatedStatus || "unknown")}</span>`;
  }
}

async function populateDeviceRestaurantDropdowns() {
  if (cachedRestaurantsForDevices.length) return;
  try {
    const data = await apiCall("/platform-admin/api/restaurants?limit=100");
    cachedRestaurantsForDevices = data.restaurants || data || [];
    const filterSelect = $("device-restaurant-filter");
    if (filterSelect) {
      filterSelect.innerHTML =
        '<option value="">All restaurants</option>' +
        cachedRestaurantsForDevices
          .map(
            (r) =>
              `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} (${escapeHtml(r.code)})</option>`,
          )
          .join("");
    }
  } catch (err) {
    console.error("Failed to preload restaurants for device filter", err);
  }
}

async function loadDevices() {
  const reqId = ++deviceSearchReqId;
  await populateDeviceRestaurantDropdowns();

  const params = new URLSearchParams();
  params.set("page", devicePage);
  params.set("limit", pageSize);
  const searchVal = $("device-search-input").value.trim();
  if (searchVal) params.set("search", searchVal);
  const statusVal = $("device-status-filter").value;
  if (statusVal && statusVal !== "all") params.set("status", statusVal);
  const typeVal = $("device-type-filter").value;
  if (typeVal) params.set("deviceType", typeVal);
  const restVal = $("device-restaurant-filter").value;
  if (restVal) params.set("restaurantId", restVal);

  const query = params.toString();

  const tbody = $("devices-tbody");
  tbody.innerHTML =
    '<tr><td colspan="8" class="empty">Loading devices…</td></tr>';

  try {
    const data = await apiCall(`/platform-admin/api/devices?${query}`);
    if (reqId !== deviceSearchReqId) return;

    const s = data.summary || {};
    $("dev-stat-total").textContent = s.totalDevices ?? 0;
    $("dev-stat-online").textContent = s.onlineDevices ?? 0;
    $("dev-stat-offline").textContent = s.offlineDevices ?? 0;
    $("dev-stat-stale").textContent = s.staleDevices ?? 0;
    $("dev-stat-revoked").textContent = s.revokedDevices ?? 0;

    const list = data.devices || [];
    deviceTotalCount = data.totalCount ?? list.length;
    tbody.innerHTML = "";

    if (!list.length) {
      tbody.innerHTML =
        '<tr><td colspan="8" class="empty">No registered devices match your criteria.</td></tr>';
    } else {
      list.forEach((dev) => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><strong>${escapeHtml(dev.name)}</strong><br><small class="muted"><code>${escapeHtml(dev.deviceUid)}</code></small></td>
          <td><strong>${escapeHtml(dev.restaurantName || "—")}</strong><br><small class="muted">${escapeHtml(dev.branchName || dev.branchCode || "Default branch")}</small></td>
          <td>${escapeHtml((dev.deviceType || "desktop").toUpperCase())}<br><small class="muted">${escapeHtml(dev.os || dev.platform || "Web")}</small></td>
          <td><code>v${escapeHtml(dev.appVersion || "1.0.0")}</code></td>
          <td>${deviceBadge(dev.calculatedStatus, dev.status)}</td>
          <td>${dev.lastSeenAt ? new Date(dev.lastSeenAt).toLocaleString() : "Never"}</td>
          <td>${dev.lastSyncAt ? new Date(dev.lastSyncAt).toLocaleString() : "Never"}</td>
          <td><button class="btn secondary btn-manage-device" data-id="${escapeHtml(dev.id)}">Manage</button></td>
        `;
        tbody.appendChild(tr);
      });
    }

    pager("device", devicePage, deviceTotalCount, pageSize);
  } catch (error) {
    if (reqId !== deviceSearchReqId) return;
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty">Could not load devices. Adjust filters to retry.</td></tr>';
    throw error;
  }
}

$("device-search-input").addEventListener("input", () => {
  devicePage = 1;
  loadDevices().catch(handleError);
});
$("device-status-filter").addEventListener("change", () => {
  devicePage = 1;
  loadDevices().catch(handleError);
});
$("device-type-filter").addEventListener("change", () => {
  devicePage = 1;
  loadDevices().catch(handleError);
});
$("device-restaurant-filter").addEventListener("change", () => {
  devicePage = 1;
  loadDevices().catch(handleError);
});
$("device-prev").onclick = () => {
  if (devicePage > 1) {
    devicePage--;
    loadDevices().catch(handleError);
  }
};
$("device-next").onclick = () => {
  const maxPage = Math.ceil(deviceTotalCount / pageSize);
  if (devicePage < maxPage) {
    devicePage++;
    loadDevices().catch(handleError);
  }
};

$("devices-tbody").addEventListener("click", (event) => {
  const button = event.target.closest(".btn-manage-device");
  if (button) viewDevice(button.dataset.id).catch(handleError);
});

$("close-device-detail-btn").onclick = () => {
  $("device-detail-view").classList.add("hidden");
  $("devices-page").classList.remove("hidden");
  loadDevices().catch(handleError);
};

async function viewDevice(deviceId) {
  const content = $("device-detail-content");
  content.innerHTML =
    '<div class="empty">Loading device administrative details…</div>';
  $("devices-page").classList.add("hidden");
  $("device-detail-view").classList.remove("hidden");

  try {
    const data = await apiCall(
      `/platform-admin/api/devices/${encodeURIComponent(deviceId)}`,
    );
    currentDevice = data.device;
    const d = data.device;
    const restaurant = data.restaurant || {};
    const branch = data.branch || {};
    const sessions = data.activeSessions || [];
    const audits = data.auditHistory || [];

    $("device-detail-name").textContent = `${d.name} (${d.deviceUid})`;

    if (d.status === "revoked") {
      $("btn-revoke-device").classList.add("hidden");
      $("btn-reactivate-device").classList.remove("hidden");
    } else {
      $("btn-revoke-device").classList.remove("hidden");
      $("btn-reactivate-device").classList.add("hidden");
    }

    const sessionsMarkup = sessions.length
      ? sessions
          .map(
            (s) => `<tr>
          <td><strong>${escapeHtml(s.username || s.displayName || "Unknown")}</strong></td>
          <td><code>${escapeHtml(s.ipAddress || "—")}</code></td>
          <td>${escapeHtml(s.userAgent || "—")}</td>
          <td>${s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : "—"}</td>
          <td>${s.expiresAt ? new Date(s.expiresAt).toLocaleString() : "—"}</td>
        </tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">No active authenticated sessions for this device.</td></tr>';

    const auditMarkup = audits.length
      ? audits
          .map(
            (a) => `<tr>
          <td><strong>${escapeHtml(a.action)}</strong></td>
          <td>${escapeHtml(a.actorType || "platform_admin")}<br><small class="muted">${escapeHtml(a.actorId || "")}</small></td>
          <td><code>${escapeHtml(a.ipAddress || "—")}</code></td>
          <td>${date(a.createdAt)} ${new Date(a.createdAt).toLocaleTimeString()}</td>
          <td><pre style="margin:0; font-size:11px; max-width:260px; overflow-x:auto;">${escapeHtml(JSON.stringify(a.metadata || {}, null, 1))}</pre></td>
        </tr>`,
          )
          .join("")
      : '<tr><td colspan="5" class="empty">No audit events recorded for this device.</td></tr>';

    const revocationBox =
      d.status === "revoked"
        ? `<div style="background:var(--danger-bg, #fee2e2); border:1px solid var(--danger, #ef4444); border-radius:6px; padding:12px; margin-bottom:1rem;">
          <strong style="color:var(--danger, #b91c1c);">Device Revoked on ${d.revokedAt ? new Date(d.revokedAt).toLocaleString() : "Unknown"}</strong>
          <p style="margin:4px 0 0; color:#7f1d1d;">Reason: ${escapeHtml(d.revocationReason || "No reason specified.")}</p>
        </div>`
        : d.reactivatedAt
          ? `<div style="background:var(--success-bg, #dcfce7); border:1px solid var(--success, #22c55e); border-radius:6px; padding:12px; margin-bottom:1rem;">
            <strong style="color:var(--success, #15803d);">Device Reactivated on ${new Date(d.reactivatedAt).toLocaleString()}</strong>
            <p style="margin:4px 0 0; color:#14532d;">Reason: ${escapeHtml(d.reactivationReason || "No reason specified.")}</p>
          </div>`
          : "";

    content.innerHTML = `
      ${revocationBox}
      <div class="grid cols-2" style="margin-bottom:1.5rem;">
        <article class="card">
          <h3>Hardware & Identity</h3>
          <p><strong>Device ID (UUID):</strong> <code>${escapeHtml(d.id)}</code></p>
          <p><strong>Device UID / Serial:</strong> <code>${escapeHtml(d.deviceUid)}</code></p>
          <p><strong>Display Name:</strong> ${escapeHtml(d.name)}</p>
          <p><strong>Form Factor:</strong> <span class="badge">${escapeHtml(d.deviceType || "desktop")}</span></p>
          <p><strong>Platform / OS:</strong> ${escapeHtml(d.platform || "Web")} (${escapeHtml(d.os || "Unknown OS")})</p>
          <p><strong>App Version:</strong> <code>v${escapeHtml(d.appVersion || "1.0.0")}</code></p>
          <p><strong>Persistent Status:</strong> ${badge(d.status)}</p>
          <p><strong>Calculated Telemetry Status:</strong> ${deviceBadge(d.calculatedStatus, d.status)}</p>
        </article>

        <article class="card">
          <h3>Tenant & Subscription Context</h3>
          <p><strong>Restaurant:</strong> <strong>${escapeHtml(restaurant.name || "—")}</strong> (<code>${escapeHtml(restaurant.code || "—")}</code>)</p>
          <p><strong>Branch:</strong> ${escapeHtml(branch.name || "Default branch")} (<code>${escapeHtml(branch.code || "default")}</code>)</p>
          <p><strong>Subscription Status:</strong> ${badge(restaurant.subscriptionStatus || "active")}</p>
          <p><strong>Subscription Plan:</strong> ${escapeHtml(restaurant.planName || "—")}</p>
          <p><strong>Device Allowance:</strong> ${restaurant.activeDevicesCount ?? "—"} / ${restaurant.maxDevices ?? "—"} allowed devices</p>
          <p><strong>Registered Date:</strong> ${d.createdAt ? new Date(d.createdAt).toLocaleString() : "—"}</p>
          <p><strong>Last Heartbeat:</strong> ${d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : "Never"}</p>
          <p><strong>Last Sync:</strong> ${d.lastSyncAt ? new Date(d.lastSyncAt).toLocaleString() : "Never"}</p>
        </article>
      </div>

      <article class="card" style="margin-bottom:1.5rem;">
        <div class="section-heading">
          <div>
            <h3>Active Sessions (${sessions.length})</h3>
            <p class="muted">Currently active bearer and cookie sessions associated with this hardware device.</p>
          </div>
          ${sessions.length ? '<button id="btn-quick-revoke-sessions" class="btn secondary">Revoke all sessions</button>' : ""}
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>IP address</th>
                <th>User agent</th>
                <th>Last active</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>${sessionsMarkup}</tbody>
          </table>
        </div>
      </article>

      <article class="card">
        <h3>Device Audit Log & Administrative Actions</h3>
        <p class="muted">Tamper-evident record of registration, modifications, revoking, and reactivations.</p>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Actor</th>
                <th>IP address</th>
                <th>Timestamp</th>
                <th>Metadata</th>
              </tr>
            </thead>
            <tbody>${auditMarkup}</tbody>
          </table>
        </div>
      </article>
    `;

    const quickRevoke = $("btn-quick-revoke-sessions");
    if (quickRevoke) {
      quickRevoke.onclick = () => revokeDeviceSessionsAction();
    }
  } catch (error) {
    content.innerHTML =
      '<div class="empty">Failed to load device details.</div>';
    handleError(error);
  }
}

$("open-register-device-modal").onclick = async () => {
  const modal = $("register-device-modal");
  const restSelect = $("reg-device-restaurant");
  const branchSelect = $("reg-device-branch");
  $("register-device-error").classList.add("hidden");
  $("register-device-form").reset();

  restSelect.innerHTML = "<option value=\"\">Loading restaurants…</option>";
  branchSelect.innerHTML = '<option value="">Default branch</option>';

  try {
    const data = await apiCall("/platform-admin/api/restaurants?limit=100");
    const rests = data.restaurants || data || [];
    restSelect.innerHTML =
      '<option value="">Select a restaurant tenant</option>' +
      rests
        .map(
          (r) =>
            `<option value="${escapeHtml(r.id)}">${escapeHtml(r.name)} (${escapeHtml(r.code)})</option>`,
        )
        .join("");

    restSelect.onchange = async () => {
      const restId = restSelect.value;
      branchSelect.innerHTML = '<option value="">Default branch</option>';
      if (!restId) return;
      try {
        const rData = await apiCall(
          `/platform-admin/api/restaurants/${encodeURIComponent(restId)}`,
        );
        const branches = rData.branches || [];
        if (branches.length) {
          branchSelect.innerHTML =
            '<option value="">Default branch</option>' +
            branches
              .map(
                (b) =>
                  `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)} (${escapeHtml(b.code)})</option>`,
              )
              .join("");
        }
      } catch (err) {
        console.error("Failed to load branches for restaurant", err);
      }
    };

    modal.showModal();
  } catch (err) {
    handleError(err);
  }
};

$("register-device-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("register-device-error").classList.add("hidden");

  try {
    const payload = {
      restaurantId: $("reg-device-restaurant").value,
      branchId: $("reg-device-branch").value || null,
      name: $("reg-device-name").value.trim(),
      deviceUid: $("reg-device-uid").value.trim(),
      deviceType: $("reg-device-type").value,
      platform: $("reg-device-platform").value.trim() || "Web",
      os: $("reg-device-os").value.trim() || null,
      appVersion: $("reg-device-version").value.trim() || "1.0.0",
    };

    const res = await apiCall("/platform-admin/api/devices", {
      method: "POST",
      body: JSON.stringify(payload),
    });

    $("register-device-modal").close();
    toast(`Device "${res.device.name}" registered successfully.`);
    devicePage = 1;
    await loadDevices();
    if (res.device?.id) await viewDevice(res.device.id);
  } catch (error) {
    $("register-device-error").textContent = error.message;
    $("register-device-error").classList.remove("hidden");
    handleError(error);
  } finally {
    button.disabled = false;
  }
};

$("btn-edit-device").onclick = async () => {
  if (!currentDevice) return;
  const modal = $("edit-device-modal");
  $("edit-device-error").classList.add("hidden");

  $("edit-dev-name").value = currentDevice.name || "";
  $("edit-dev-type").value = currentDevice.deviceType || "desktop";
  $("edit-dev-platform").value = currentDevice.platform || "Web";
  $("edit-dev-os").value = currentDevice.os || "";
  $("edit-dev-version").value = currentDevice.appVersion || "1.0.0";

  const branchSelect = $("edit-dev-branch");
  branchSelect.innerHTML = '<option value="">None / Default</option>';
  try {
    const rData = await apiCall(
      `/platform-admin/api/restaurants/${encodeURIComponent(currentDevice.restaurantId)}`,
    );
    const branches = rData.branches || [];
    branches.forEach((b) => {
      const opt = document.createElement("option");
      opt.value = b.id;
      opt.textContent = `${b.name} (${b.code})`;
      if (b.id === currentDevice.branchId) opt.selected = true;
      branchSelect.appendChild(opt);
    });
  } catch (err) {
    console.error("Failed to load branches for edit device", err);
  }

  modal.showModal();
};

$("edit-device-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("edit-device-error").classList.add("hidden");

  try {
    const payload = {
      name: $("edit-dev-name").value.trim(),
      branchId: $("edit-dev-branch").value || null,
      deviceType: $("edit-dev-type").value,
      platform: $("edit-dev-platform").value.trim() || null,
      os: $("edit-dev-os").value.trim() || null,
      appVersion: $("edit-dev-version").value.trim() || null,
    };

    await apiCall(
      `/platform-admin/api/devices/${encodeURIComponent(currentDevice.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(payload),
      },
    );

    $("edit-device-modal").close();
    toast("Device metadata updated.");
    await viewDevice(currentDevice.id);
  } catch (error) {
    $("edit-device-error").textContent = error.message;
    $("edit-device-error").classList.remove("hidden");
    handleError(error);
  } finally {
    button.disabled = false;
  }
};

$("btn-revoke-device").onclick = () => {
  if (!currentDevice) return;
  $("revoke-device-error").classList.add("hidden");
  $("revoke-dev-reason").value = "";
  $("revoke-dev-sessions-check").checked = true;
  $("revoke-device-modal").showModal();
};

$("revoke-device-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("revoke-device-error").classList.add("hidden");

  try {
    const payload = {
      reason: $("revoke-dev-reason").value.trim(),
      revokeSessions: $("revoke-dev-sessions-check").checked,
    };

    await apiCall(
      `/platform-admin/api/devices/${encodeURIComponent(currentDevice.id)}/revoke`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    $("revoke-device-modal").close();
    toast("Device revoked and sessions invalidated.");
    await viewDevice(currentDevice.id);
  } catch (error) {
    $("revoke-device-error").textContent = error.message;
    $("revoke-device-error").classList.remove("hidden");
    handleError(error);
  } finally {
    button.disabled = false;
  }
};

$("btn-reactivate-device").onclick = () => {
  if (!currentDevice) return;
  $("reactivate-device-error").classList.add("hidden");
  $("reactivate-dev-reason").value = "";
  $("reactivate-device-modal").showModal();
};

$("reactivate-device-form").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("reactivate-device-error").classList.add("hidden");

  try {
    const payload = {
      reason: $("reactivate-dev-reason").value.trim(),
    };

    await apiCall(
      `/platform-admin/api/devices/${encodeURIComponent(currentDevice.id)}/reactivate`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    $("reactivate-device-modal").close();
    toast("Device reactivated.");
    await viewDevice(currentDevice.id);
  } catch (error) {
    $("reactivate-device-error").textContent = error.message;
    $("reactivate-device-error").classList.remove("hidden");
    handleError(error);
  } finally {
    button.disabled = false;
  }
};

async function revokeDeviceSessionsAction() {
  if (!currentDevice) return;
  if (
    !(await confirmAction(
      "Revoke device sessions?",
      "All active users signed into this terminal will be signed out immediately.",
    ))
  ) {
    return;
  }

  try {
    await apiCall(
      `/platform-admin/api/devices/${encodeURIComponent(currentDevice.id)}/revoke-sessions`,
      {
        method: "POST",
        body: JSON.stringify({
          reason: "Administrator remote session revocation",
        }),
      },
    );
    toast("All device sessions revoked.");
    await viewDevice(currentDevice.id);
  } catch (error) {
    handleError(error);
  }
}
$("btn-revoke-device-sessions").onclick = revokeDeviceSessionsAction;

document.querySelectorAll("dialog [data-close]").forEach((btn) => {
  btn.onclick = () => {
    const dialogId = btn.getAttribute("data-close");
    if (dialogId && $(dialogId)) $(dialogId).close();
  };
});
