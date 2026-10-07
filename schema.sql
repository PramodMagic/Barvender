-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run
create table master_items(
  id bigint generated always as identity primary key,
  awb text, sku text, ret_qty numeric,
  data jsonb not null,            -- every column of your master row
  vals text[] not null,           -- all values (lowercase) so ANY attribute can be scanned
  created_at timestamptz default now());
create index on master_items using gin(vals);
create index on master_items(awb);

create table returns(
  id bigint generated always as identity primary key,
  awb text, sku text, return_qty numeric,
  received_qty numeric not null,
  remark text not null check (remark in ('Fresh','Damage','Partial Damage','Partial Fresh')),
  note text, photo_path text,
  scanned_by uuid default auth.uid(),
  created_at timestamptz default now());
create index on returns(created_at);
create index on returns(awb);

alter table master_items enable row level security;
alter table returns enable row level security;
create policy "logged in users" on master_items for all to authenticated using (true) with check (true);
create policy "logged in users" on returns for all to authenticated using (true) with check (true);

-- private file storage (master files + damage photos)
insert into storage.buckets(id,name,public) values ('master-files','master-files',false),('return-photos','return-photos',false) on conflict do nothing;
create policy "logged in files" on storage.objects for all to authenticated
  using (bucket_id in ('master-files','return-photos')) with check (bucket_id in ('master-files','return-photos'));
