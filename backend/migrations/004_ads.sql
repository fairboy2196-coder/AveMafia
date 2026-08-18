-- ============================================================
--  Миграция 004 — Реклама (объявления игроков со скидкой от клуба).
--  Игрок размещает свой бизнес/услугу со скидкой для участников клуба,
--  владелец модерирует и берёт плату за размещение.
--  Применить: Supabase → SQL Editor → New query → вставить → Run.
-- ============================================================

create table if not exists ads (
  id          bigserial primary key,
  tg_id       bigint not null references users(tg_id) on delete cascade,
  business    text not null,                     -- название / чем занимается
  category    text,                              -- род деятельности (для поиска)
  discount    text,                              -- скидка для клуба (напр. «15%»)
  description text,
  contact     text,                              -- телефон / @telegram / сайт
  city        text,                              -- город (можно фильтровать по группе)
  status      text not null default 'pending',   -- pending | active | rejected
  price       int  not null default 0,           -- плата за размещение (руб), задаёт владелец
  paid        boolean not null default false,    -- оплачено ли размещение
  created_at  timestamptz not null default now(),
  expires_at  timestamptz                        -- когда снять с публикации (необяз.)
);
create index if not exists ads_status_idx on ads(status, created_at desc);
create index if not exists ads_tg_idx on ads(tg_id);

alter table ads enable row level security;   -- доступ только через Edge Function
