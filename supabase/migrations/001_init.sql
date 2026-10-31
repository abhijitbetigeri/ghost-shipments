-- Ghost Shipments: exception tickets, mission event log, evidence photo bucket.
create extension if not exists pgcrypto;

create table if not exists public.tickets (
    id          uuid primary key default gen_random_uuid(),
    code        text,
    shipment_id text,
    bay         int,
    verdict     text,
    summary     text,
    photo_url   text,
    mission_id  text,
    raw         jsonb,
    created_at  timestamptz not null default now()
);
create index if not exists tickets_created_at_idx on public.tickets (created_at desc);

create table if not exists public.mission_events (
    id         bigserial primary key,
    mission_id text,
    step       int,
    data       jsonb,
    created_at timestamptz not null default now()
);
create index if not exists mission_events_mission_idx on public.mission_events (mission_id, step);

-- Public evidence bucket (photos uploaded by the rover with the service key).
insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', true)
on conflict (id) do nothing;

drop policy if exists "evidence public read" on storage.objects;
create policy "evidence public read" on storage.objects
    for select using (bucket_id = 'evidence');
