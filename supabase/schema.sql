create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  phone text not null,
  email text,
  inquiry_type text not null,
  message text not null,
  location text,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory (
  id uuid primary key default gen_random_uuid(),
  product_name text not null,
  category text not null,
  stock_on_hand integer not null default 0,
  unit_cost numeric(12,2) not null default 0,
  selling_price numeric(12,2) not null default 0,
  reorder_level integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.inventory(id) on delete cascade,
  qty_bought integer not null default 0,
  unit_cost numeric(12,2) not null default 0,
  total_cost numeric(12,2) not null default 0,
  supplier text,
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.inventory(id) on delete cascade,
  qty_sold integer not null default 0,
  unit_price numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  customer_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.inventory(id) on delete cascade,
  adjustment_type text not null check (adjustment_type in ('breakage', 'loss', 'return', 'manual_adjustment')),
  qty integer not null default 0,
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.accounting_entries (
  id uuid primary key default gen_random_uuid(),
  entry_type text not null check (entry_type in ('sale', 'purchase', 'breakage', 'loss', 'manual_adjustment')),
  amount numeric(12,2) not null default 0,
  description text,
  created_at timestamptz not null default now()
);

create index if not exists idx_leads_created_at on public.leads(created_at desc);
create index if not exists idx_inventory_category on public.inventory(category);
create index if not exists idx_sales_created_at on public.sales(created_at desc);
create index if not exists idx_purchases_created_at on public.purchases(created_at desc);

alter table public.leads enable row level security;
alter table public.inventory enable row level security;
alter table public.purchases enable row level security;
alter table public.sales enable row level security;
alter table public.stock_adjustments enable row level security;
alter table public.accounting_entries enable row level security;

create policy "Allow anonymous quote submissions"
on public.leads for insert
with check (true);

create policy "Allow authenticated reads for inventory"
on public.inventory for select
using (auth.role() = 'authenticated');

create policy "Allow authenticated writes for inventory"
on public.inventory for insert
with check (auth.role() = 'authenticated');

create policy "Allow authenticated updates for inventory"
on public.inventory for update
using (auth.role() = 'authenticated');

create policy "Allow authenticated reads for sales"
on public.sales for select
using (auth.role() = 'authenticated');

create policy "Allow authenticated writes for sales"
on public.sales for insert
with check (auth.role() = 'authenticated');

create policy "Allow authenticated reads for purchases"
on public.purchases for select
using (auth.role() = 'authenticated');

create policy "Allow authenticated writes for purchases"
on public.purchases for insert
with check (auth.role() = 'authenticated');

create policy "Allow authenticated reads for stock adjustments"
on public.stock_adjustments for select
using (auth.role() = 'authenticated');

create policy "Allow authenticated writes for stock adjustments"
on public.stock_adjustments for insert
with check (auth.role() = 'authenticated');

create policy "Allow authenticated reads for accounting entries"
on public.accounting_entries for select
using (auth.role() = 'authenticated');

create policy "Allow authenticated writes for accounting entries"
on public.accounting_entries for insert
with check (auth.role() = 'authenticated');
