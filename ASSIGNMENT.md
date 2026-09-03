# Kebra Take Home Assignment

**TL;DR:** The names and numbers in the data are made up. The situation is not. This is close to what you would actually build at Kebra.

Gulf Breeze Air is an HVAC company in Miami. Fourteen techs, a lot of vacation rentals run by property managers, and one office manager who lives on the phone.

Their phone is answered by a booking bot today. It takes a name and a time window and that's about it. The owner's complaint, close to word for word: it can't tell a customer when we were last out there, it can't tell them if they're under warranty, it can't move an appointment, I have no idea what it promised anyone, and it's pretty slow.

You're building the replacement. Two pieces:

1. A voice agent that answers a real phone call.
2. The platform behind it. Where the office works, and where the agent's work lands.

How the two fit together is up to you. That's most of what we're looking at.

This is open-ended on purpose. Treat everything here as the theme, not a spec. If you're not sure what the platform should be, build whatever you think should exist for this company and make it good. We're not going to explain more than this.

## What you get

The `data` folder has the last six months of this company's jobs out of their field-service software. Around 2,000 jobs with every note the techs and the office wrote, the invoices with line items, the customers and the crew. Phone numbers, emails and door codes have been stripped. `README.md` in that folder lists the fields.

## What the agent should be able to do

Think about who calls an HVAC office. A homeowner whose upstairs is frozen. A property manager with guests checking in at four. The owner asking what his day looks like. A tech asking what was done last time at an address.

The agent needs to:

- Know the business. Anything in that data should be askable. "When were you last at 89 Harborlight Shores and what did you do" should get an answer, not a search result.
- Reach outside the data when it has to. Weather for an attic job, a model number it hasn't seen, a supplier's hours. Some kind of live web tool.
- Do things on your platform, through your platform. Book something, move something, leave a note, check who's free. Whatever an office would ask for. We want to see it land on the screen while we're still on the phone.
- Know when to stop and hand off to a person.

## What the platform should be

The office should be able to run their day from it and see what the agent is doing and has done. Past that, it's yours to design. We won't hand you a feature list.

## Rules

- Any stack, any model, your own keys. If building this costs you money, for APIs, a phone number or hosting, keep the receipts and tell us. We'll reimburse you.
- A real phone number we can dial, live for 24 hours after you submit. If you can't get a real number working, a web call from a separate platform is fine.

## What to send

The phone number, the platform URL, and the repo.
