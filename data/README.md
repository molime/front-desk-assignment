# Data

Six months of one HVAC company's field-service records (March to September 2026, plus the maintenance visits already on the calendar through the end of the year), exported from Housecall Pro. The company is called Gulf Breeze Air here and placed in Miami.

What's real: the dates, the notes as the techs and office wrote them, the job and invoice structure, the shape of the business. What's changed: every person's and company's name is fictional (consistently, so the same customer keeps the same fake name everywhere, including inside notes), every street and city is fictional or relocated to the Miami area (consistently too, so an address in a note matches the job it belongs to), dollar amounts have been nudged a few percent, and phone numbers, emails, door and gate codes and web links are replaced with `[phone]`, `[email]` and `[code]`. A few names or places mentioned only inside notes may have slipped through.

The `.jsonl` files are JSON Lines, one record per line, meant to be read by code. Money is in cents. The same data is in `csv/` as spreadsheets (money in dollars there): `jobs.csv` has one row per job with the notes joined, `notes.csv` one row per note, plus `invoices.csv`, `invoice_items.csv`, `customers.csv`, `employees.csv`.

## jobs.jsonl (1,992 rows, 6,954 notes)

One row per job. The notes are the heart of it: the office writes the booking and follow-ups, the techs write what they found and did. Order inside `notes` is roughly chronological.

- `id`, `invoice_number` (4 digits, the number staff use to refer to a job)
- `description` line item the job was booked under
- `work_status` scheduled / in progress / complete rated / complete unrated / needs scheduling / canceled
- `work_timestamps` on_my_way_at, started_at, completed_at
- `schedule` scheduled_start, scheduled_end (UTC), time_zone, arrival_window minutes
- `tags` office tags, e.g. `1 Yr Labor Warranty`, `Warranty Claim`, `Registration Needed`, `Service Callback`, `Pipeline Automation`
- `total_amount`, `outstanding_balance`
- `customer` id, first_name, last_name, company, kind. Property management companies show up as the customer, with the homeowner mentioned in notes.
- `address` street, street_line_2 (unit), city, state, zip, latitude, longitude
- `assigned_employees` who was on the job
- `notes` id, content

## invoices.jsonl (1,700 rows, 4,390 line items)

- `job_id` joins to jobs
- `invoice_number`, `status`, `amount`, `subtotal`, `due_amount`, `paid_at`, `sent_at`, `service_date`, `invoice_date`
- `items` name, type (labor / material), unit_price, qty_in_hundredths (100 = one), amount. Line names carry the company's price book: dispatch fees, repair tiers, `WARRANTY Parts / Service - WARRANTY - <part>` for parts covered by a manufacturer.
- `taxes`, `discounts`, `payments` amounts only

## customers.jsonl (732 rows)

Built from the jobs. `kind` is homeowner or company. `addresses` lists every service address seen for that customer, `job_count`, `first_job`, `last_job`.

## employees.jsonl (23 rows)

Everyone who was assigned to a job in the window, with `role` and how many jobs they touched. `Team Phone` is the shared office line, not a person.
