-- Tacoa admin backend: run AFTER schema.sql. Safe to re-run.
-- Adds: admin allow-list, admin-only RLS, atomic stock/accounting functions, P&L report.

-- ---------------------------------------------------------------------------
-- Admin allow-list. Only these emails can read or change business data.
-- No RLS policies on purpose: the table is managed from the SQL editor only.
-- ---------------------------------------------------------------------------
create table if not exists public.admins (
  email text primary key check (email = lower(email))
);
alter table public.admins enable row level security;

insert into public.admins (email) values ('info@tacoatrading.com')
on conflict do nothing;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins
    where email = lower(auth.jwt() ->> 'email')
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Schema additions
-- ---------------------------------------------------------------------------
alter table public.sales add column if not exists unit_cost numeric(12,2) not null default 0;

-- Two ways to sell glass: whole sheets (selling_price per sqm) or cut to size (cut_price per sqm).
-- Stock is always in sqm. sheet_*_mm is the full sheet size used to convert sheets to sqm.
alter table public.inventory add column if not exists cut_price numeric(12,2) not null default 0 check (cut_price >= 0);
alter table public.inventory add column if not exists sheet_width_mm integer not null default 1830 check (sheet_width_mm > 0);
alter table public.inventory add column if not exists sheet_height_mm integer not null default 2440 check (sheet_height_mm > 0);
-- How a line was sold, e.g. "2 whole sheets (1830 x 2440 mm)" or "9 cut pieces of 890 x 500 mm".
alter table public.sales add column if not exists detail text;

-- One receipt can cover several sale lines (one line per product).
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_no bigint generated always as identity unique,
  customer_name text,
  customer_phone text,
  customer_email text,
  total_amount numeric(12,2) not null default 0,
  created_by text,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.receipts enable row level security;
alter table public.sales add column if not exists receipt_id uuid references public.receipts(id);
create index if not exists idx_sales_receipt on public.sales(receipt_id);

-- All quantities are square metres (sqm), so they need decimals.
alter table public.inventory alter column stock_on_hand type numeric(12,2);
alter table public.inventory alter column reorder_level type numeric(12,2);
alter table public.purchases alter column qty_bought type numeric(12,2);
alter table public.sales alter column qty_sold type numeric(12,2);
alter table public.stock_adjustments alter column qty type numeric(12,2);

alter table public.leads add column if not exists status text not null default 'new';
alter table public.leads drop constraint if exists leads_status_check;
alter table public.leads add constraint leads_status_check
  check (status in ('new', 'contacted', 'won', 'lost'));

alter table public.inventory drop constraint if exists inventory_stock_nonneg;
alter table public.inventory add constraint inventory_stock_nonneg check (stock_on_hand >= 0);

alter table public.accounting_entries drop constraint if exists accounting_entries_entry_type_check;
alter table public.accounting_entries add constraint accounting_entries_entry_type_check
  check (entry_type in ('sale', 'purchase', 'breakage', 'loss', 'manual_adjustment', 'expense', 'income'));

-- ---------------------------------------------------------------------------
-- Row level security: replace the old "any authenticated user" policies.
-- Leads are inserted only by the submit-quote edge function (service role),
-- so the public insert policy is removed.
-- Ledger tables (sales, purchases, adjustments, accounting) are insert-only.
-- ---------------------------------------------------------------------------
drop policy if exists "Allow anonymous quote submissions" on public.leads;
drop policy if exists "Allow authenticated reads for inventory" on public.inventory;
drop policy if exists "Allow authenticated writes for inventory" on public.inventory;
drop policy if exists "Allow authenticated updates for inventory" on public.inventory;
drop policy if exists "Allow authenticated reads for sales" on public.sales;
drop policy if exists "Allow authenticated writes for sales" on public.sales;
drop policy if exists "Allow authenticated reads for purchases" on public.purchases;
drop policy if exists "Allow authenticated writes for purchases" on public.purchases;
drop policy if exists "Allow authenticated reads for stock adjustments" on public.stock_adjustments;
drop policy if exists "Allow authenticated writes for stock adjustments" on public.stock_adjustments;
drop policy if exists "Allow authenticated reads for accounting entries" on public.accounting_entries;
drop policy if exists "Allow authenticated writes for accounting entries" on public.accounting_entries;

drop policy if exists "Admins read leads" on public.leads;
drop policy if exists "Admins update leads" on public.leads;
create policy "Admins read leads" on public.leads for select to authenticated using (public.is_admin());
create policy "Admins update leads" on public.leads for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read inventory" on public.inventory;
drop policy if exists "Admins insert inventory" on public.inventory;
drop policy if exists "Admins update inventory" on public.inventory;
create policy "Admins read inventory" on public.inventory for select to authenticated using (public.is_admin());
create policy "Admins insert inventory" on public.inventory for insert to authenticated with check (public.is_admin());
create policy "Admins update inventory" on public.inventory for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read sales" on public.sales;
drop policy if exists "Admins insert sales" on public.sales;
create policy "Admins read sales" on public.sales for select to authenticated using (public.is_admin());
create policy "Admins insert sales" on public.sales for insert to authenticated with check (public.is_admin());

drop policy if exists "Admins read receipts" on public.receipts;
drop policy if exists "Admins insert receipts" on public.receipts;
create policy "Admins read receipts" on public.receipts for select to authenticated using (public.is_admin());
create policy "Admins insert receipts" on public.receipts for insert to authenticated with check (public.is_admin());

drop policy if exists "Admins read purchases" on public.purchases;
drop policy if exists "Admins insert purchases" on public.purchases;
create policy "Admins read purchases" on public.purchases for select to authenticated using (public.is_admin());
create policy "Admins insert purchases" on public.purchases for insert to authenticated with check (public.is_admin());

drop policy if exists "Admins read adjustments" on public.stock_adjustments;
drop policy if exists "Admins insert adjustments" on public.stock_adjustments;
create policy "Admins read adjustments" on public.stock_adjustments for select to authenticated using (public.is_admin());
create policy "Admins insert adjustments" on public.stock_adjustments for insert to authenticated with check (public.is_admin());

drop policy if exists "Admins read accounting" on public.accounting_entries;
drop policy if exists "Admins insert accounting" on public.accounting_entries;
create policy "Admins read accounting" on public.accounting_entries for select to authenticated using (public.is_admin());
create policy "Admins insert accounting" on public.accounting_entries for insert to authenticated with check (public.is_admin());

-- ---------------------------------------------------------------------------
-- Atomic operations. Each runs in one transaction and locks the product row,
-- so stock and the books can never get out of step.
-- Accounting sign convention: money in is positive, money out / write-offs negative.
-- ---------------------------------------------------------------------------
drop function if exists public.record_sale(uuid, integer, numeric, text);
drop function if exists public.record_sale(uuid, numeric, numeric, text);
drop function if exists public.record_sale(uuid, numeric, numeric, text, uuid);
drop function if exists public.record_purchase(uuid, integer, numeric, text);
drop function if exists public.record_adjustment(uuid, text, integer, text);

create or replace function public.record_sale(
  p_product_id uuid,
  p_qty numeric,
  p_unit_price numeric,
  p_customer text default null,
  p_receipt_id uuid default null,
  p_detail text default null
)
returns public.sales
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inv public.inventory%rowtype;
  v_sale public.sales%rowtype;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  p_qty := round(p_qty, 2);
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_unit_price is null or p_unit_price < 0 then raise exception 'Price cannot be negative'; end if;

  select * into v_inv from public.inventory where id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;
  if v_inv.stock_on_hand < p_qty then
    raise exception 'Insufficient stock: % on hand, % requested', v_inv.stock_on_hand, p_qty;
  end if;

  update public.inventory
     set stock_on_hand = stock_on_hand - p_qty, updated_at = now()
   where id = p_product_id;

  insert into public.sales (product_id, qty_sold, unit_price, unit_cost, total_amount, customer_name, receipt_id, detail)
  values (p_product_id, p_qty, p_unit_price, v_inv.unit_cost, round(p_qty * p_unit_price, 2), nullif(trim(p_customer), ''), p_receipt_id,
          nullif(left(trim(p_detail), 200), ''))
  returning * into v_sale;

  insert into public.accounting_entries (entry_type, amount, description)
  values ('sale', v_sale.total_amount, format('Sale: %s x %s @ %s', p_qty, v_inv.product_name, p_unit_price));

  return v_sale;
end;
$$;

-- A whole receipt in one transaction: every line is recorded (stock out, ledger entry)
-- or none are. p_items = [{"product_id": "...", "qty": 2.5, "unit_price": 4.5}, ...]
create or replace function public.record_sale_receipt(
  p_items jsonb,
  p_customer text default null,
  p_phone text default null,
  p_email text default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_receipt public.receipts%rowtype;
  v_item jsonb;
  v_total numeric(12,2);
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item';
  end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Too many items on one receipt'; end if;

  select coalesce(sum(round(round((i ->> 'qty')::numeric, 2) * (i ->> 'unit_price')::numeric, 2)), 0)
    into v_total
    from jsonb_array_elements(p_items) as i;

  insert into public.receipts (customer_name, customer_phone, customer_email, total_amount, created_by)
  values (nullif(trim(p_customer), ''), nullif(trim(p_phone), ''), nullif(lower(trim(p_email)), ''),
          v_total, auth.jwt() ->> 'email')
  returning * into v_receipt;

  for v_item in select * from jsonb_array_elements(p_items) loop
    perform public.record_sale(
      (v_item ->> 'product_id')::uuid,
      (v_item ->> 'qty')::numeric,
      (v_item ->> 'unit_price')::numeric,
      p_customer,
      v_receipt.id,
      v_item ->> 'detail');
  end loop;

  return v_receipt.id;
end;
$$;

create or replace function public.record_purchase(
  p_product_id uuid,
  p_qty numeric,
  p_unit_cost numeric,
  p_supplier text default null
)
returns public.purchases
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inv public.inventory%rowtype;
  v_purchase public.purchases%rowtype;
  v_new_cost numeric(12,2);
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  p_qty := round(p_qty, 2);
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
  if p_unit_cost is null or p_unit_cost < 0 then raise exception 'Cost cannot be negative'; end if;

  select * into v_inv from public.inventory where id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;

  -- weighted average cost across existing stock and the new batch
  v_new_cost := round((v_inv.stock_on_hand * v_inv.unit_cost + p_qty * p_unit_cost) / (v_inv.stock_on_hand + p_qty), 2);

  update public.inventory
     set stock_on_hand = stock_on_hand + p_qty, unit_cost = v_new_cost, updated_at = now()
   where id = p_product_id;

  insert into public.purchases (product_id, qty_bought, unit_cost, total_cost, supplier)
  values (p_product_id, p_qty, p_unit_cost, round(p_qty * p_unit_cost, 2), nullif(trim(p_supplier), ''))
  returning * into v_purchase;

  insert into public.accounting_entries (entry_type, amount, description)
  values ('purchase', -v_purchase.total_cost, format('Purchase: %s x %s @ %s', p_qty, v_inv.product_name, p_unit_cost));

  return v_purchase;
end;
$$;

-- breakage / loss: stock out, written off at current cost (hits the books)
-- return: stock back in (no financial entry; record any refund as an expense)
-- manual_adjustment: signed stock count correction (no financial entry)
create or replace function public.record_adjustment(
  p_product_id uuid,
  p_type text,
  p_qty numeric,
  p_reason text default null
)
returns public.stock_adjustments
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_inv public.inventory%rowtype;
  v_adj public.stock_adjustments%rowtype;
  v_delta numeric;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  p_qty := round(p_qty, 2);
  if p_type not in ('breakage', 'loss', 'return', 'manual_adjustment') then
    raise exception 'Invalid adjustment type';
  end if;
  if p_qty is null or p_qty = 0 then raise exception 'Quantity cannot be zero'; end if;
  if p_type <> 'manual_adjustment' and p_qty < 0 then
    raise exception 'Quantity must be greater than zero';
  end if;

  select * into v_inv from public.inventory where id = p_product_id for update;
  if not found then raise exception 'Product not found'; end if;

  v_delta := case when p_type in ('breakage', 'loss') then -p_qty else p_qty end;
  if v_inv.stock_on_hand + v_delta < 0 then
    raise exception 'Insufficient stock: % on hand', v_inv.stock_on_hand;
  end if;

  update public.inventory
     set stock_on_hand = stock_on_hand + v_delta, updated_at = now()
   where id = p_product_id;

  insert into public.stock_adjustments (product_id, adjustment_type, qty, reason)
  values (p_product_id, p_type, p_qty, nullif(trim(p_reason), ''))
  returning * into v_adj;

  if p_type in ('breakage', 'loss') then
    insert into public.accounting_entries (entry_type, amount, description)
    values (p_type, -round(p_qty * v_inv.unit_cost, 2),
            format('%s: %s x %s%s', initcap(p_type), p_qty, v_inv.product_name,
                   case when nullif(trim(p_reason), '') is null then '' else ' (' || trim(p_reason) || ')' end));
  end if;

  return v_adj;
end;
$$;

create or replace function public.record_expense(
  p_kind text,
  p_amount numeric,
  p_description text
)
returns public.accounting_entries
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry public.accounting_entries%rowtype;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  if p_kind not in ('expense', 'income') then raise exception 'Invalid entry type'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Amount must be greater than zero'; end if;
  if nullif(trim(p_description), '') is null then raise exception 'Description is required'; end if;

  insert into public.accounting_entries (entry_type, amount, description)
  values (p_kind, case when p_kind = 'expense' then -round(p_amount, 2) else round(p_amount, 2) end, trim(p_description))
  returning * into v_entry;

  return v_entry;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profit and loss for a period (p_to is exclusive; null = open ended)
-- ---------------------------------------------------------------------------
create or replace function public.accounting_report(
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table (
  revenue_total numeric,
  cogs_total numeric,
  writeoffs_total numeric,
  expenses_total numeric,
  income_total numeric,
  purchases_total numeric,
  gross_profit numeric,
  net_profit numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  with s as (
    select coalesce(sum(total_amount), 0) as r, coalesce(sum(qty_sold * unit_cost), 0) as c
    from public.sales
    where (p_from is null or created_at >= p_from) and (p_to is null or created_at < p_to)
  ),
  a as (
    select
      coalesce(-sum(amount) filter (where entry_type in ('breakage', 'loss')), 0) as w,
      coalesce(-sum(amount) filter (where entry_type = 'expense'), 0) as e,
      coalesce(sum(amount) filter (where entry_type = 'income'), 0) as i
    from public.accounting_entries
    where (p_from is null or created_at >= p_from) and (p_to is null or created_at < p_to)
  ),
  p as (
    select coalesce(sum(total_cost), 0) as t
    from public.purchases
    where (p_from is null or created_at >= p_from) and (p_to is null or created_at < p_to)
  )
  select s.r, s.c, a.w, a.e, a.i, p.t,
         s.r - s.c - a.w,
         s.r - s.c - a.w - a.e + a.i
  from s, a, p;
$$;

-- ---------------------------------------------------------------------------
-- Only signed-in users may call the functions (and each also checks is_admin()).
-- ---------------------------------------------------------------------------
revoke all on function public.record_sale(uuid, numeric, numeric, text, uuid, text) from public, anon;
revoke all on function public.record_sale_receipt(jsonb, text, text, text) from public, anon;
revoke all on function public.record_purchase(uuid, numeric, numeric, text) from public, anon;
revoke all on function public.record_adjustment(uuid, text, numeric, text) from public, anon;
revoke all on function public.record_expense(text, numeric, text) from public, anon;
revoke all on function public.accounting_report(timestamptz, timestamptz) from public, anon;

grant execute on function public.record_sale(uuid, numeric, numeric, text, uuid, text) to authenticated;
grant execute on function public.record_sale_receipt(jsonb, text, text, text) to authenticated;
grant execute on function public.record_purchase(uuid, numeric, numeric, text) to authenticated;
grant execute on function public.record_adjustment(uuid, text, numeric, text) to authenticated;
grant execute on function public.record_expense(text, numeric, text) to authenticated;
grant execute on function public.accounting_report(timestamptz, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- Replies to enquiries, sent from the admin dashboard via the reply-lead
-- edge function (service role). Admins can read; nobody can edit or delete.
-- ---------------------------------------------------------------------------
create table if not exists public.lead_replies (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  sent_by text not null,
  to_email text not null,
  subject text not null,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_replies_lead on public.lead_replies(lead_id, created_at);
alter table public.lead_replies enable row level security;
drop policy if exists "Admins read lead replies" on public.lead_replies;
create policy "Admins read lead replies" on public.lead_replies for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Quotes. A quote never touches stock or the accounts. When the customer
-- accepts and pays, accept_quote() turns it into a normal receipt (sale).
-- ---------------------------------------------------------------------------
create table if not exists public.quotes (
  id uuid primary key default gen_random_uuid(),
  quote_no bigint generated always as identity unique,
  lead_id uuid references public.leads(id) on delete set null,
  customer_name text,
  customer_phone text,
  customer_email text,
  notes text,
  valid_until date not null,
  total_amount numeric(12,2) not null default 0,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined')),
  receipt_id uuid references public.receipts(id),
  created_by text,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.quote_items (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references public.quotes(id) on delete cascade,
  product_id uuid not null references public.inventory(id),
  description text not null,
  qty numeric(12,2) not null check (qty > 0),
  unit_price numeric(12,2) not null check (unit_price >= 0),
  total_amount numeric(12,2) not null
);
alter table public.quote_items add column if not exists detail text;
create index if not exists idx_quote_items_quote on public.quote_items(quote_id);
create index if not exists idx_quotes_created_at on public.quotes(created_at desc);

alter table public.quotes enable row level security;
alter table public.quote_items enable row level security;

drop policy if exists "Admins read quotes" on public.quotes;
drop policy if exists "Admins insert quotes" on public.quotes;
drop policy if exists "Admins update quotes" on public.quotes;
create policy "Admins read quotes" on public.quotes for select to authenticated using (public.is_admin());
create policy "Admins insert quotes" on public.quotes for insert to authenticated with check (public.is_admin());
create policy "Admins update quotes" on public.quotes for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "Admins read quote items" on public.quote_items;
drop policy if exists "Admins insert quote items" on public.quote_items;
create policy "Admins read quote items" on public.quote_items for select to authenticated using (public.is_admin());
create policy "Admins insert quote items" on public.quote_items for insert to authenticated with check (public.is_admin());

-- Only the workflow fields of a quote can change after it is created; prices and items are fixed.
revoke update on public.quotes from anon, authenticated;
grant update (status, receipt_id, emailed_at) on public.quotes to authenticated;

create or replace function public.create_quote(
  p_items jsonb,
  p_customer text default null,
  p_phone text default null,
  p_email text default null,
  p_valid_days integer default 14,
  p_notes text default null,
  p_lead_id uuid default null
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_quote public.quotes%rowtype;
  v_item jsonb;
  v_inv public.inventory%rowtype;
  v_qty numeric;
  v_price numeric;
  v_total numeric(12,2) := 0;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Add at least one item';
  end if;
  if jsonb_array_length(p_items) > 50 then raise exception 'Too many items on one quote'; end if;
  if p_valid_days is null or p_valid_days < 1 or p_valid_days > 365 then
    raise exception 'Validity must be between 1 and 365 days';
  end if;

  select coalesce(sum(round(round((i ->> 'qty')::numeric, 2) * round((i ->> 'unit_price')::numeric, 2), 2)), 0)
    into v_total
    from jsonb_array_elements(p_items) as i;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := round((v_item ->> 'qty')::numeric, 2);
    v_price := round((v_item ->> 'unit_price')::numeric, 2);
    if v_qty is null or v_qty <= 0 then raise exception 'Quantity must be greater than zero'; end if;
    if v_price is null or v_price < 0 then raise exception 'Price cannot be negative'; end if;
  end loop;

  insert into public.quotes (lead_id, customer_name, customer_phone, customer_email, notes, valid_until, total_amount, created_by)
  values (p_lead_id, nullif(trim(p_customer), ''), nullif(trim(p_phone), ''), nullif(lower(trim(p_email)), ''),
          nullif(trim(p_notes), ''), current_date + p_valid_days, v_total, auth.jwt() ->> 'email')
  returning * into v_quote;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := round((v_item ->> 'qty')::numeric, 2);
    v_price := round((v_item ->> 'unit_price')::numeric, 2);
    select * into v_inv from public.inventory where id = (v_item ->> 'product_id')::uuid;
    if not found then raise exception 'Product not found'; end if;

    insert into public.quote_items (quote_id, product_id, description, qty, unit_price, total_amount, detail)
    values (v_quote.id, v_inv.id, v_inv.product_name, v_qty, v_price, round(v_qty * v_price, 2),
            nullif(left(trim(v_item ->> 'detail'), 200), ''));
  end loop;

  if p_lead_id is not null then
    update public.leads set status = 'contacted' where id = p_lead_id and status = 'new';
  end if;

  return v_quote.id;
end;
$$;

-- Customer accepted and paid: record it as a normal sale. Stock is checked and removed here.
create or replace function public.accept_quote(p_quote_id uuid)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_q public.quotes%rowtype;
  v_items jsonb;
  v_receipt uuid;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  select * into v_q from public.quotes where id = p_quote_id for update;
  if not found then raise exception 'Quote not found'; end if;
  if v_q.status <> 'open' then raise exception 'This quote is already %', v_q.status; end if;

  select jsonb_agg(jsonb_build_object('product_id', product_id, 'qty', qty, 'unit_price', unit_price, 'detail', detail))
    into v_items from public.quote_items where quote_id = p_quote_id;

  v_receipt := public.record_sale_receipt(v_items, v_q.customer_name, v_q.customer_phone, v_q.customer_email);
  update public.quotes set status = 'accepted', receipt_id = v_receipt where id = p_quote_id;
  return v_receipt;
end;
$$;

create or replace function public.decline_quote(p_quote_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
  update public.quotes set status = 'declined' where id = p_quote_id and status = 'open';
  if not found then raise exception 'Only an open quote can be marked declined'; end if;
end;
$$;

revoke all on function public.create_quote(jsonb, text, text, text, integer, text, uuid) from public, anon;
revoke all on function public.accept_quote(uuid) from public, anon;
revoke all on function public.decline_quote(uuid) from public, anon;
grant execute on function public.create_quote(jsonb, text, text, text, integer, text, uuid) to authenticated;
grant execute on function public.accept_quote(uuid) to authenticated;
grant execute on function public.decline_quote(uuid) to authenticated;
