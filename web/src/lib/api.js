// Tiny fetch client for the front-desk API (proxied to :8080 by Vite).
async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error ?? `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export const api = {
  // customers
  searchCustomers: (q) => request(`/api/customers?q=${encodeURIComponent(q)}`),
  getCustomer: (id) => request(`/api/customers/${id}`),
  getCustomerHistory: (id, limit = 20) => request(`/api/customers/${id}/history?limit=${limit}`),
  getCustomerUpcoming: (id) => request(`/api/customers/${id}/upcoming`),
  getCustomerWarranty: (id) => request(`/api/customers/${id}/warranty`),
  getCustomerInvoices: (id) => request(`/api/customers/${id}/invoices`),
  // jobs
  getJob: (id) => request(`/api/jobs/${id}`),
  // schedule
  getTodaySchedule: () => request('/api/schedule/today'),
  getWeekSchedule: (start) => request(`/api/schedule/week?start=${start}`),
  getAvailability: (date) => request(`/api/availability?date=${date}`),
  // calls
  getCalls: () => request('/api/calls'),
  getCall: (id) => request(`/api/calls/${id}`),
  // tasks
  getTasks: (status = 'open') => request(`/api/tasks?status=${status}`),
  completeTask: (id) => request(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) }),
  // employees (crew)
  getEmployees: () => request('/api/employees'),
  getEmployeeSchedule: (id, date) => request(`/api/employees/${id}/schedule${date ? `?date=${date}` : ''}`),
  getEmployeeMessages: (id) => request(`/api/employees/${id}/messages`),
  // web call
  realtimeToken: () => request('/api/realtime-token', { method: 'POST', body: '{}' }),
};
