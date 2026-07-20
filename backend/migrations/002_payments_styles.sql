-- ============================================================
--  Миграция 002 — оплата (ЮKassa через Telegram Payments).
--  Применить в Supabase → SQL Editor → New query → вставить → Run.
--  Безопасно запускать повторно (IF NOT EXISTS).
-- ============================================================

-- Купленные стили интерфейса (зимний и будущие). Аватарки уже есть в users.avatars.
alter table users add column if not exists styles text[] not null default '{}';

-- Платежи: ext_id пригодится для сверки с ЮKassa и защиты от дублей.
create unique index if not exists payments_ext_id_uidx
  on payments(ext_id) where ext_id is not null;

-- Быстрый поиск платежей игрока.
create index if not exists payments_tg_idx on payments(tg_id, created_at desc);
