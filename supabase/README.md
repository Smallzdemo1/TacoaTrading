# Tacoa Supabase setup

This project now includes a minimal Supabase-backed lead capture and inventory foundation.

## 1) Create the database schema

In the Supabase SQL editor, run the contents of `supabase/schema.sql`.

## 2) Add the Edge Function

Create a new Supabase Edge Function called `submit-quote` and paste the contents of `supabase/functions/submit-quote/index.ts`.

## 3) Configure environment variables

In the Supabase dashboard, set these environment variables for the function:

- `SUPABASE_URL` = your project URL
- `SUPABASE_SERVICE_ROLE_KEY` = the service role key
- `RESEND_API_KEY` = optional alternative to SMTP
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` = mailbox used to send (SMTP is tried first)
- `BUSINESS_EMAIL` = where lead emails are sent

## 4) Update the site config

Edit `js/supabase-config.js` and replace:

- `https://YOUR_PROJECT_REF.supabase.co`
- `YOUR_SUPABASE_ANON_KEY`

with your project URL and anon key.

## 5) Deploy the function

If using the Supabase CLI:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy submit-quote
```

## 6) Admin area (`admin.html`)

Run `supabase/admin.sql` after `schema.sql` (or `supabase db query --linked -f supabase/admin.sql`). It adds admin-only access, atomic sale/purchase/breakage functions and the profit and loss report.

Then in the Supabase dashboard:

1. Authentication > Users > Add user: use an email listed in the `admins` table, set a password, tick Auto Confirm.
2. Authentication > Sign In / Providers: turn off "Allow new users to sign up".
3. To add another admin: `insert into public.admins (email) values ('name@example.com');` (lowercase).

Open `admin.html` and sign in.

## 7) Useful tables for the business

- `leads` — inbound quote requests
- `inventory` — product stock levels
- `purchases` — inventory purchased
- `sales` — inventory sold
- `stock_adjustments` — breakages, losses, returns
- `accounting_entries` — ledger-style accounting tracking

This gives you a real starting point for customer enquiries, stock control, and basic accounting without building a full custom ERP immediately.
