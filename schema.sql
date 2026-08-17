create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint unique not null,
  chat_id bigint not null,
  first_name text,
  last_name text,
  username text,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create table if not exists classes (
  id uuid primary key default gen_random_uuid(),
  starts_at timestamptz not null,
  location text not null default 'Northbrook, IL',
  capacity integer not null default 8 check (capacity > 0),
  price_cents integer not null default 1500 check (price_cents >= 0),
  status text not null default 'open' check (status in ('open','closed','cancelled')),
  created_at timestamptz not null default now()
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  class_id uuid not null references classes(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','paid','cancelled','refunded')),
  payment_status text not null default 'unpaid' check (payment_status in ('unpaid','paid','refunded')),
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  expires_at timestamptz,
  attended boolean,
  created_at timestamptz not null default now(),
  unique(user_id, class_id)
);

create index if not exists classes_starts_at_idx on classes(starts_at);
create index if not exists bookings_class_id_idx on bookings(class_id);
create index if not exists bookings_user_id_idx on bookings(user_id);

create or replace function reserve_class_slot(p_user_id uuid, p_class_id uuid)
returns bookings
language plpgsql
security definer
as $$
declare
  c classes%rowtype;
  existing bookings%rowtype;
  active_count integer;
  result bookings%rowtype;
begin
  select * into c from classes where id = p_class_id for update;
  if not found then raise exception 'CLASS_NOT_FOUND'; end if;
  if c.status <> 'open' then raise exception 'CLASS_NOT_OPEN'; end if;
  if c.starts_at <= now() then raise exception 'CLASS_STARTED'; end if;

  select * into existing from bookings where user_id = p_user_id and class_id = p_class_id;
  if found and existing.status = 'paid' then return existing; end if;
  if found and existing.status = 'pending' and existing.expires_at > now() then return existing; end if;

  select count(*) into active_count
  from bookings
  where class_id = p_class_id
    and (status = 'paid' or (status = 'pending' and expires_at > now()));

  if active_count >= c.capacity then raise exception 'CLASS_FULL'; end if;

  if found then
    update bookings
    set status='pending', payment_status='unpaid', expires_at=now() + interval '15 minutes',
        stripe_checkout_session_id=null, stripe_payment_intent_id=null
    where id = existing.id
    returning * into result;
  else
    insert into bookings(user_id,class_id,status,payment_status,expires_at)
    values(p_user_id,p_class_id,'pending','unpaid',now() + interval '15 minutes')
    returning * into result;
  end if;

  return result;
end;
$$;

create or replace view class_availability as
select
  c.*,
  greatest(c.capacity - count(b.id) filter (
    where b.status='paid' or (b.status='pending' and b.expires_at > now())
  ), 0)::int as spots_left
from classes c
left join bookings b on b.class_id = c.id
group by c.id;
