// Warranty verdict (DESIGN.md §3 check_warranty).
// Evidence sources:
//  1. Install jobs tagged '1 Yr Labor Warranty' / 'Registration Complete' → 1-year labor warranty
//  2. Jobs tagged 'Warranty Claim' / 'Service Callback' → warranty history
//  3. Invoice line items named 'WARRANTY Parts / Service%' → manufacturer-covered parts
import db from '../db/index.js';

const LABOR_TAGS = ['1 Yr Labor Warranty', 'Registration Complete'];
const CLAIM_TAGS = ['Warranty Claim', 'Service Callback'];

function taggedJobs(customerId, tags) {
  const clauses = tags.map(() => `j.tags LIKE ?`).join(' OR ');
  return db
    .prepare(
      `SELECT j.id, j.invoice_number, j.description, j.work_status, j.tags,
              j.scheduled_start, j.completed_at, a.street, a.city
       FROM jobs j LEFT JOIN customer_addresses a ON a.id = j.address_id
       WHERE j.customer_id = ? AND (${clauses})
       ORDER BY j.scheduled_start DESC NULLS LAST`
    )
    .all(customerId, ...tags.map((t) => `%"${t}"%`))
    .map((j) => ({ ...j, tags: JSON.parse(j.tags || '[]') }));
}

export function checkWarranty(customerId) {
  const customer = db.prepare(`SELECT id FROM customers WHERE id = ?`).get(customerId);
  if (!customer) return null;

  // 1. Qualifying installs → 1-year labor warranty from the install date
  const installs = taggedJobs(customerId, LABOR_TAGS).filter((j) => /install/i.test(j.description ?? ''));
  const now = new Date();
  const laborEvidence = installs.map((j) => {
    const basis = j.completed_at ?? j.scheduled_start;
    const basisDate = basis ? new Date(basis) : null;
    const expires = basisDate ? new Date(basisDate) : null;
    if (expires) expires.setFullYear(expires.getFullYear() + 1);
    return {
      job_id: j.id,
      invoice_number: j.invoice_number,
      description: j.description,
      address: [j.street, j.city].filter(Boolean).join(', '),
      tags: j.tags.filter((t) => LABOR_TAGS.includes(t)),
      installed_at: basis,
      labor_warranty_expires: expires ? expires.toISOString() : null,
      active: expires ? expires > now : false,
    };
  });
  const activeLabor = laborEvidence.filter((e) => e.active);

  // 2. Warranty-claim / callback history
  const claims = taggedJobs(customerId, CLAIM_TAGS).map((j) => ({
    job_id: j.id,
    invoice_number: j.invoice_number,
    description: j.description,
    work_status: j.work_status,
    address: [j.street, j.city].filter(Boolean).join(', '),
    tags: j.tags.filter((t) => CLAIM_TAGS.includes(t)),
    scheduled_start: j.scheduled_start,
    completed_at: j.completed_at,
  }));

  // 3. WARRANTY invoice line items (manufacturer-covered parts/service)
  const lineItems = db
    .prepare(
      `SELECT ii.id, ii.name, ii.type, ii.amount, i.id AS invoice_id, i.invoice_number,
              i.service_date, j.id AS job_id
       FROM invoice_items ii
       JOIN invoices i ON i.id = ii.invoice_id
       JOIN jobs j ON j.id = i.job_id
       WHERE j.customer_id = ? AND ii.name LIKE 'WARRANTY Parts / Service%'
       ORDER BY i.service_date DESC NULLS LAST`
    )
    .all(customerId);

  const verdict = {
    customer_id: customerId,
    labor_warranty: activeLabor.length > 0
      ? {
          active: true,
          basis: 'install tagged 1 Yr Labor Warranty / Registration Complete, 1 year from install date',
          installs: laborEvidence,
        }
      : { active: false, basis: laborEvidence.length > 0 ? 'qualifying install found but 1-year term expired' : 'no qualifying install on record', installs: laborEvidence },
    warranty_claims: claims,
    warranty_line_items: lineItems,
    summary: activeLabor.length > 0
      ? `Active 1-year labor warranty (install ${activeLabor[0].installed_at}, expires ${activeLabor[0].labor_warranty_expires}). ` +
        `${claims.length} warranty-tagged job(s), ${lineItems.length} warranty line item(s) on record.`
      : laborEvidence.length > 0
        ? `Labor warranty expired (last qualifying install ${laborEvidence[0].installed_at}, expired ${laborEvidence[0].labor_warranty_expires}). ` +
          `${claims.length} warranty-tagged job(s), ${lineItems.length} warranty line item(s) on record.`
        : `No labor-warranty install on record. ${claims.length} warranty-tagged job(s), ${lineItems.length} warranty line item(s) on record.`,
  };
  return verdict;
}
