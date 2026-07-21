-- ============================================================
--  Миграция 003 — подгруппы (город × классификация) + смена имени.
--  Применить: Supabase → SQL Editor → New query → вставить → Run.
--  Безопасно запускать повторно (IF NOT EXISTS).
--
--  Классификации (kind): 'team' — Сборная мафия, 'corp' — Корпоративная,
--                        'kids' — Детская мафия.
--  Группа = пара (city, kind). Рейтинг считается внутри группы.
-- ============================================================

-- ---------- Имя игрока ----------
-- display_name — имя, которое игрок выбрал сам (видят все).
-- first_name/last_name/username остаются ОРИГИНАЛЬНЫМИ из Telegram —
-- их видит только владелец клуба.
alter table users add column if not exists display_name text;

-- ---------- Группа игрока ----------
alter table users add column if not exists city text;
alter table users add column if not exists kind text not null default 'team';

-- ---------- Группа игры ----------
alter table games add column if not exists city text;
alter table games add column if not exists kind text not null default 'team';

-- Быстрый подбор игр своей группы
create index if not exists games_group_idx on games(city, kind, gdate);

-- ---------- Рейтинг: теперь ОТДЕЛЬНЫЙ по каждой группе ----------
-- Раньше была одна строка на игрока (PK = tg_id). Теперь у игрока может быть
-- своя статистика в разных городах/классификациях, поэтому ключ составной.
alter table player_stats add column if not exists city text not null default '';
alter table player_stats add column if not exists kind text not null default 'team';

do $$
begin
  -- сменить первичный ключ на (tg_id, city, kind), если ещё не сменён
  if exists (
    select 1 from pg_constraint
    where conname = 'player_stats_pkey'
      and (select count(*) from unnest(conkey)) = 1
  ) then
    alter table player_stats drop constraint player_stats_pkey;
    alter table player_stats add primary key (tg_id, city, kind);
  end if;
end $$;

create index if not exists player_stats_group_idx on player_stats(city, kind, pts desc);

-- ---------- Проставить группу существующим играм ----------
-- Все текущие игры считаем «Сборной мафией» в твоём городе.
-- ЗАМЕНИ 'Владивосток' на свой город, если нужно другое значение.
update games set city = coalesce(city, 'Владивосток') where city is null;
update users set city = coalesce(city, 'Владивосток') where city is null;
