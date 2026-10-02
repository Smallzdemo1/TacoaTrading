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
create or replace function public.record_sale(
  p_product_id uuid,
  p_qty integer,
  p_unit_price numeric,
  p_customer text default null
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

  insert into public.sales (product_id, qty_sold, unit_price, unit_cost, total_amount, customer_name)
  values (p_product_id, p_qty, p_unit_price, v_inv.unit_cost, round(p_qty * p_unit_price, 2), nullif(trim(p_customer), ''))
  returning * into v_sale;

  insert into public.accounting_entries (entry_type, amount, description)
  values ('sale', v_sale.total_amount, format('Sale: %s x %s @ %s', p_qty, v_inv.product_name, p_unit_price));

  return v_sale;
end;
$$;

create or replace function public.record_purchase(
  p_product_id uuid,
  p_qty integer,
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
  p_qty integer,
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
  v_delta integer;
begin
  if not public.is_admin() then raise exception 'Not authorised'; end if;
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
revoke all on function public.record_sale(uuid, integer, numeric, text) from public, anon;
revoke all on function public.record_purchase(uuid, integer, numeric, text) from public, anon;
revoke all on function public.record_adjustment(uuid, text, integer, text) from public, anon;
revoke all on function public.record_expense(text, numeric, text) from public, anon;
revoke all on function public.accounting_report(timestamptz, timestamptz) from public, anon;

grant execute on function public.record_sale(uuid, integer, numeric, text) to authenticated;
grant execute on function public.record_purchase(uuid, integer, numeric, text) to authenticated;
grant execute on function public.record_adjustment(uuid, text, integer, text) to authenticated;
grant execute on function public.record_expense(text, numeric, text) to authenticated;
grant execute on function public.accounting_report(timestamptz, timestamptz) to authenticated;
