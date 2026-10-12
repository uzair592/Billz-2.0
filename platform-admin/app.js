function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[char]));
}

    async function apiCall(path, options = {}) {
      const headers = { ...options.headers };
      if (options.body || options.method === 'POST' || options.method === 'PUT') {
        headers['content-type'] = 'application/json';
        if (!options.body) options.body = JSON.stringify({});
      }
      const res = await fetch(path, { credentials: 'same-origin', ...options, headers });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        const errMsg = data?.error || data?.message || `HTTP ${res.status}`;
        console.error(`API Error [${res.status}] ${path}:`, data);
        throw new Error(errMsg);
      }
      return data;
    }

    const loginView = document.getElementById('login-view');
    const portalView = document.getElementById('portal-view');
    const loginError = document.getElementById('login-error');

    async function checkAuth() {
      try {
        const data = await apiCall('/platform-admin/api/auth/me');
        document.getElementById('admin-display-name').textContent = data.admin.displayName;
        document.getElementById('logout-btn').classList.remove('hidden');
        loginView.classList.add('hidden');
        portalView.classList.remove('hidden');
      } catch {
        loginView.classList.remove('hidden');
        portalView.classList.add('hidden');
        return;
      }
      loadDashboard().catch(console.error);
      loadRestaurants().catch(console.error);
    }

    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      loginError.classList.add('hidden');
      try {
        await apiCall('/platform-admin/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        await checkAuth();
      } catch (err) {
        loginError.textContent = err.message;
        loginError.classList.remove('hidden');
      }
    });

    document.getElementById('logout-btn').addEventListener('click', async () => {
      await apiCall('/platform-admin/api/auth/logout', { method: 'POST' });
      await checkAuth();
    });

    async function loadDashboard() {
      const stats = await apiCall('/platform-admin/api/dashboard');
      document.getElementById('stat-total').textContent = stats.totalRestaurants;
      document.getElementById('stat-active').textContent = stats.activeRestaurants;
      document.getElementById('stat-suspended').textContent = stats.suspendedRestaurants;
      document.getElementById('stat-pending').textContent = stats.pendingPayments;
    }

    let searchReqId = 0;
    async function loadRestaurants() {
      const reqId = ++searchReqId;
      const search = document.getElementById('search-input').value;
      const status = document.getElementById('status-filter').value;
      const list = await apiCall(`/platform-admin/api/restaurants?search=${encodeURIComponent(search)}&status=${status}`);
      if (reqId !== searchReqId) return;
      const tbody = document.getElementById('restaurants-tbody');
      tbody.innerHTML = '';
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No restaurants found.</td></tr>';
        return;
      }
      list.forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><strong>${escapeHtml(r.code)}</strong></td>
          <td>${escapeHtml(r.name)}</td>
          <td><span class="badge badge-${escapeHtml(r.status)}">${escapeHtml(r.status)}</span></td>
          <td>${escapeHtml(r.subscriptionStatus)}</td>
          <td>${(Number(r.usedStorageBytes)/(1024*1024)).toFixed(1)} MB / 5 GB</td>
          <td><button class="btn btn-manage" data-id="${escapeHtml(r.id)}">Manage</button></td>
        `;
        tbody.appendChild(tr);
      });
      document.querySelectorAll('.btn-manage').forEach(b => b.addEventListener('click', () => viewRestaurant(b.dataset.id)));
    }

    document.getElementById('search-input').addEventListener('input', () => { loadRestaurants().catch(console.error); });
    document.getElementById('status-filter').addEventListener('change', () => { loadRestaurants().catch(console.error); });

    document.getElementById('open-create-modal').addEventListener('click', () => {
      document.getElementById('create-modal').classList.remove('hidden');
    });
    document.getElementById('cancel-create-btn').addEventListener('click', () => {
      document.getElementById('create-modal').classList.add('hidden');
    });

    document.getElementById('create-restaurant-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const createErr = document.getElementById('create-error');
      createErr.classList.add('hidden');
      try {
        await apiCall('/platform-admin/api/restaurants', {
          method: 'POST',
          body: JSON.stringify({
            code: document.getElementById('create-code').value,
            name: document.getElementById('create-name').value,
            ownerUsername: document.getElementById('create-owner-user').value,
            ownerPassword: document.getElementById('create-owner-pass').value
          })
        });
        document.getElementById('create-modal').classList.add('hidden');
        await loadRestaurants();
        await loadDashboard();
      } catch (err) {
        createErr.textContent = err.message;
        createErr.classList.remove('hidden');
      }
    });

    async function viewRestaurant(id) {
      const data = await apiCall(`/platform-admin/api/restaurants/${id}`);
      const detailView = document.getElementById('detail-view');
      document.getElementById('detail-name').textContent = `${data.restaurant.name} (${data.restaurant.code})`;

      const content = document.getElementById('detail-content');
      content.innerHTML = `
        <div style="margin-bottom:20px; display:flex; gap:15px; align-items:center;">
          <div>Status: <span class="badge badge-${escapeHtml(data.restaurant.status)}">${escapeHtml(data.restaurant.status)}</span></div>
          <div>Plan: <strong>${escapeHtml(data.subscription.planName)}</strong></div>
          ${data.restaurant.status === 'active'
            ? `<button id="suspend-btn" class="btn btn-danger">Suspend Access</button>`
            : `<button id="restore-btn" class="btn btn-success">Restore Access</button>`}
        </div>

        <h3 style="margin-top:20px;">Record Manual Payment</h3>
        <form id="record-pay-form" style="display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:10px;">
          <div><label>Plan Code</label><input id="pay-plan" value="GROWTH" required /></div>
          <div><label>Amount (Minor Units PKR)</label><input id="pay-amount" type="number" value="500000" required /></div>
          <div><label>Covered From</label><input id="pay-from" type="date" required /></div>
          <div><label>Covered Until</label><input id="pay-until" type="date" required /></div>
          <div style="grid-column:span 2;"><label>External Reference / Transaction ID</label><input id="pay-ref" required placeholder="TRX-123456" /></div>
          <div style="grid-column:span 2;"><button type="submit" class="btn btn-success">Record Payment</button></div>
        </form>

        <h3 style="margin-top:25px;">Payment History</h3>
        <table>
          <thead>
            <tr><th>Reference</th><th>Amount</th><th>Status</th><th>Covered Dates</th><th>Action</th></tr>
          </thead>
          <tbody>
            ${data.payments.map(p => `
              <tr>
                <td>${escapeHtml(p.externalReference)}</td>
                <td>PKR ${(p.amountMinor/100).toFixed(2)}</td>
                <td><span class="badge badge-${escapeHtml(p.status)}">${escapeHtml(p.status)}</span></td>
                <td>${new Date(p.coveredFrom).toLocaleDateString()} - ${new Date(p.coveredUntil).toLocaleDateString()}</td>
                <td>
                  ${p.status === 'pending' ? `<button class="btn btn-success btn-approve" data-pid="${escapeHtml(p.id)}">Approve</button>` : ''}
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
      detailView.classList.remove('hidden');

      const today = new Date().toISOString().split('T')[0];
      const nextMonth = new Date(Date.now() + 30*24*60*60*1000).toISOString().split('T')[0];
      if (document.getElementById('pay-from')) document.getElementById('pay-from').value = today;
      if (document.getElementById('pay-until')) document.getElementById('pay-until').value = nextMonth;

      if (document.getElementById('suspend-btn')) {
        document.getElementById('suspend-btn').onclick = async () => {
          try {
            await apiCall(`/platform-admin/api/restaurants/${id}/suspend`, { method: 'POST' });
            await viewRestaurant(id);
            await loadRestaurants();
          } catch (err) {
            console.error('Suspend failed:', err);
          }
        };
      }
      if (document.getElementById('restore-btn')) {
        document.getElementById('restore-btn').onclick = async () => {
          try {
            await apiCall(`/platform-admin/api/restaurants/${id}/restore`, { method: 'POST' });
            await viewRestaurant(id);
            await loadRestaurants();
          } catch (err) {
            console.error('Restore failed:', err);
          }
        };
      }

      document.getElementById('record-pay-form').onsubmit = async (e) => {
        e.preventDefault();
        await apiCall(`/platform-admin/api/restaurants/${id}/payments`, {
          method: 'POST',
          body: JSON.stringify({
            planCode: document.getElementById('pay-plan').value,
            amountMinor: Number(document.getElementById('pay-amount').value),
            paymentDate: new Date().toISOString(),
            coveredFrom: new Date(document.getElementById('pay-from').value).toISOString(),
            coveredUntil: new Date(document.getElementById('pay-until').value).toISOString(),
            externalReference: document.getElementById('pay-ref').value
          })
        });
        await viewRestaurant(id);
      };

      document.querySelectorAll('.btn-approve').forEach(b => {
        b.onclick = async (e) => {
          e.preventDefault();
          const pid = b.getAttribute('data-pid') || b.dataset.pid;
          try {
            await apiCall(`/platform-admin/api/payments/${pid}/approve`, { method: 'POST' });
            await viewRestaurant(id);
            await loadRestaurants();
          } catch (err) {
            console.error('Approve payment failed:', err);
          }
        };
      });
    }

    document.getElementById('close-detail-btn').onclick = () => {
      document.getElementById('detail-view').classList.add('hidden');
    };

    checkAuth();
  