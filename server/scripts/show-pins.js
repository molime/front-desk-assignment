// Print the crew-line PINs locally (office use — the platform UI/API never
// exposes them). Run from the repo root:
//   npm --prefix server run pins
// PINs are deterministic per employee (CREW_PIN_SEED, default gba-crew-line-v1)
// so they survive reseeds and redeploys: the same tech always has the same PIN.
import db from '../src/db/index.js';
import { ensureEmployeePins, fullName } from '../src/services/employeeService.js';

ensureEmployeePins();
const rows = db
  .prepare(
    `SELECT e.id, e.role, e.first_name, e.last_name, ea.pin
     FROM employees e JOIN employee_auth ea ON ea.employee_id = e.id
     ORDER BY e.role, e.last_name`
  )
  .all();
console.log(`Crew-line PINs (seed: ${process.env.CREW_PIN_SEED ?? 'gba-crew-line-v1'})`);
console.log('');
for (const r of rows) {
  console.log(`  ${fullName(r).padEnd(22)} ${r.role.padEnd(12)} PIN ${r.pin}`);
}
console.log('');
console.log('The office dashboard deliberately does NOT show PINs: it has no auth, so');
console.log('the roster is effectively public. Look them up here instead.');