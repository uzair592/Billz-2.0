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
  node.textContent = message;
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
    if (response.status === 401) {
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
  plans = [],
  currentRestaurant = null,
  resetUser = null;
const pageSize = 20;
function showView(view) {
  for (const id of [
    "dashboard-page",
    "restaurants-page",
    "audits-page",
    "payments-page",
    "detail-view",
  ])
    $(id).classList.add("hidden");
  $(`${view}-page`).classList.remove("hidden");
  $("page-title").textContent = {
    dashboard: "Overview",
    restaurants: "Restaurants",
    audits: "Audit log",
    payments: "Payments",
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
  await Promise.all([loadDashboard(), loadRestaurants(), loadPlans()]).catch(handleError);
}
async function loadDashboard() {
  const stats = await apiCall("/platform-admin/api/dashboard");
  for (const [id, key] of [
    ["stat-total", "totalRestaurants"],
    ["stat-active", "activeRestaurants"],
    ["stat-suspended", "suspendedRestaurants"],
    ["stat-pending", "pendingPayments"],
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
      }),
    });
    await checkAuth().catch(handleError);
  } catch (error) {
    $("login-error").textContent = error.message;
    $("login-error").classList.remove("hidden");
    handleError(error);
  } finally {
    $("password").value = "";
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
  try { await loadPlans(); } catch (error) { handleError(error); return; }
  if (!plans.length) { toast("No active plans are configured.", true); return; }
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
    <article class="card"><h3>Subscription</h3>${badge(s.status)}<p><strong>${escapeHtml(s.planName)}</strong> · ${escapeHtml(s.planCode || "—")}</p><p class="muted">${date(s.currentPeriodStart)} – ${date(s.currentPeriodEnd)}</p></article>
    <article class="card"><h3>File storage</h3><strong>${bytes(storage.usedStorageBytes)} / ${bytes(storage.maxStorageBytes)}</strong><progress max="100" value="${percentage}" aria-label="Storage used"></progress>
      <form id="storage-form"><label for="storage-limit">Allowance (GB)</label><input id="storage-limit" type="number" min="0" step="any" value="${Number(storage.maxStorageBytes) / 1073741824}" required /><button class="btn secondary" type="submit">Update allowance</button></form></article></div>
    <article class="card"><div class="section-heading"><h3>Restaurant users</h3><button id="create-user-btn" class="btn secondary">+ Create user</button></div><p class="muted">Password resets and disabling users sign out their active devices.</p><div class="table-wrap"><table><thead><tr><th>Username</th><th>Display name</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead><tbody id="users-tbody">${usersMarkup(data.users)}</tbody></table></div></article>
    <article class="card"><h3>Record manual payment</h3><form id="record-pay-form" class="form-grid">
      <label for="pay-plan">Subscription plan<select id="pay-plan" required>${planOptions(s.planCode)}</select></label>
      <label for="pay-amount">Amount (PKR)<input id="pay-amount" type="number" min="0" step="0.01" value="5000" required /></label>
      <label for="pay-from">Covered from<input id="pay-from" type="date" required /></label><label for="pay-until">Covered until<input id="pay-until" type="date" required /></label>
      <label for="pay-ref" class="span-two">Transaction reference<input id="pay-ref" required maxlength="200" /></label><div class="span-two"><button type="submit" class="btn">Record payment</button></div></form></article>
    <article class="card"><h3>Payment history</h3><div class="table-wrap"><table><thead><tr><th>Reference / plan</th><th>Amount</th><th>Status</th><th>Coverage</th><th>Actions</th></tr></thead><tbody>${paymentsMarkup(data.payments)}</tbody></table></div></article>`;
  $("create-user-btn").onclick = () => openUserModal();
  const start = new Date(),
    end = new Date(Date.now() + 30 * 86400000);
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
          currencyCode: "PKR",
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
  const edit = event.target.closest(".user-edit");
  if (edit) { openUserModal(currentRestaurant.users.find(user => user.id === edit.dataset.user)); return; }
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
    if ($("edit-code").value.trim().toLowerCase() !== currentRestaurant.restaurant.code && !(await confirmAction("Change restaurant code?", "All restaurant users must sign in again with the new code."))) return;
    await apiCall(`/platform-admin/api/restaurants/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: $("edit-name").value,
        ...($("edit-code").value.trim().toLowerCase() !== currentRestaurant.restaurant.code ? { code: $("edit-code").value } : {}),
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
  return plans.map(plan => `<option value="${escapeHtml(plan.code)}" ${plan.code === selected ? "selected" : ""}>${escapeHtml(plan.name)} (${escapeHtml(plan.code)})</option>`).join("");
}
async function loadPlans() {
  plans = (await apiCall("/platform-admin/api/plans")).plans;
  $("create-plan").innerHTML = planOptions("GROWTH");
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
$("user-modal").addEventListener("close", () => { $("user-password").value = ""; editingUser = null; });
$("user-form").onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  const id = currentRestaurant.restaurant.id, user = editingUser;
  try {
    const payload = { displayName: $("user-display-name").value };
    if (!user || $("user-username").value !== user.username) payload.username = $("user-username").value;
    if (user && payload.username && !(await confirmAction("Change username?", "All active sessions for this user will be revoked."))) return;
    if (!user) Object.assign(payload, { role: $("user-role").value, password: $("user-password").value });
    await apiCall(`/platform-admin/api/restaurants/${id}/users${user ? `/${user.id}` : ""}`, { method: user ? "PATCH" : "POST", body: JSON.stringify(payload) });
    $("user-modal").close(); toast(user ? "User updated." : "User created."); await viewRestaurant(id);
  } catch (error) { handleError(error); }
  finally { $("user-password").value = ""; button.disabled = false; }
};
let paymentReqId = 0;
async function loadPayments() {
  const req = ++paymentReqId;
  $("payments-tbody").innerHTML = '<tr><td colspan="6" class="empty">Loading payments…</td></tr>';
  try {
    const data = await apiCall(`/platform-admin/api/payments?${new URLSearchParams({ status: $("payment-filter").value, page: paymentPage, limit: pageSize })}`);
    if (req !== paymentReqId) return;
    $("payments-tbody").innerHTML = data.payments.length ? data.payments.map(payment => `<tr><td><button class="btn secondary payment-restaurant" data-id="${escapeHtml(payment.restaurantId)}">${escapeHtml(payment.restaurantName)}</button><p class="muted">${escapeHtml(payment.restaurantCode)}</p></td>${paymentsMarkup([payment]).replace(/^<tr>|<\/tr>$/g, "")}</tr>`).join("") : '<tr><td colspan="6" class="empty">No payments match this filter.</td></tr>';
    pager("payment", paymentPage, data.totalCount, pageSize);
  } catch (error) {
    if (req !== paymentReqId) return;
    $("payments-tbody").innerHTML = '<tr><td colspan="6" class="empty">Could not load payments. Change the filter to retry.</td></tr>'; throw error;
  }
}
$("payment-filter").onchange = () => { paymentPage = 1; loadPayments().catch(handleError); };
$("payment-prev").onclick = () => { paymentPage--; loadPayments().catch(handleError); };
$("payment-next").onclick = () => { paymentPage++; loadPayments().catch(handleError); };
$("payments-tbody").onclick = async event => {
  const manage = event.target.closest(".payment-restaurant");
  if (manage) { viewRestaurant(manage.dataset.id).catch(handleError); return; }
  const payment = event.target.closest(".btn-approve,.btn-reject"); if (!payment) return;
  const approve = payment.classList.contains("btn-approve");
  payment.disabled = true;
  try {
    if (!(await confirmAction(approve ? "Approve payment?" : "Reject payment?", approve ? "Extend access once; administrative suspension stays in place." : "This payment will not grant access."))) return;
    await apiCall(`/platform-admin/api/payments/${payment.dataset.pid}/${approve ? "approve" : "reject"}`, { method: "POST", body: "{}" });
    toast("Payment reviewed."); await Promise.all([loadPayments(), loadDashboard()]);
  } catch (error) { handleError(error); }
  finally { payment.disabled = false; }
};
