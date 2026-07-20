-- ============================================================
--  AveMafia — схема базы данных (Supabase / PostgreSQL). Фаза 1.
--  Как применить: Supabase → SQL Editor → New query → вставить всё → Run.
--  Всё пишется/читается через Edge Function с service-role ключом,
--  поэтому включаем RLS без публичных политик (прямой доступ клиента закрыт).
-- ============================================================

-- ---------- Пользователи (личность из Telegram + прогресс) ----------
create table if not exists users (
  tg_id       bigint primary key,             -- Telegram user id (из initData)
  username    text,                            -- @username (виден только владельцу)
  first_name  text not null default 'Игрок',
  last_name   text,
  phone       text,
  occupation  text,                            -- род деятельности (в т.ч. «Другое»)
  birthday    date,                            -- для сундука в день рождения
  bday_year   int,                             -- год последнего начисления ДР-сундука
  is_owner    boolean not null default false,  -- владелец клуба (расширенный доступ)
  -- инвентарь (то, что раньше жило в localStorage)
  chests      int not null default 0,
  bonuses     jsonb not null default '{"free":0,"role":0,"immune":0}'::jsonb,
  avatars     text[] not null default '{}',    -- купленные аватарки
  styles      text[] not null default '{}',    -- купленные стили интерфейса (winter и т.д.)
  fav_roles   text[] not null default '{}',    -- любимые роли (до 3)
  avatar_id   text not null default 'hood',    -- активная аватарка
  created_at  timestamptz not null default now()
);

-- ---------- Игры (события клуба; редактирует владелец) ----------
create table if not exists games (
  id          text primary key,                -- 'moon' | 'ev_<slug>'
  title       text not null,
  gdate       date,                            -- дата игры
  gtime       text,                            -- '19:00'
  place       text,
  price       int  not null default 0,         -- рубли
  capacity    int  not null default 24,        -- полный стол
  min_players int  not null default 10,        -- порог «игре быть»
  status      text not null default 'soon',    -- soon | open | done
  format      text,
  level       text,
  descr       text,
  img         text,                            -- ключ картинки (assets)
  special     boolean not null default false,  -- выездной формат
  archived    boolean not null default false,
  sort_pos    int,
  created_at  timestamptz not null default now()
);

-- ---------- Записи на игру (предзапись + резерв, порядок = очередь) ----------
create table if not exists signups (
  id        bigserial primary key,
  game_id   text   not null references games(id) on delete cascade,
  tg_id     bigint not null references users(tg_id) on delete cascade,
  paid      boolean not null default false,
  joined_at timestamptz not null default now(),
  unique (game_id, tg_id)
);
create index if not exists signups_game_idx on signups(game_id, joined_at);

-- ---------- Билеты (после оплаты) ----------
create table if not exists tickets (
  code      text primary key,                  -- 'AM-1234'
  game_id   text   not null references games(id) on delete cascade,
  tg_id     bigint not null references users(tg_id) on delete cascade,
  sig       text   not null,                   -- HMAC-подпись (проверяется на входе)
  used      boolean not null default false,
  used_at   timestamptz,
  issued_at timestamptz not null default now()
);

-- ---------- Итоги проведённых игр ----------
create table if not exists game_results (
  id          bigserial primary key,
  game_id     text not null,
  win_team    text not null,                   -- mafia | good | third
  mvp_tg_id   bigint,
  finished_at timestamptz not null default now()
);
-- Роли, розданные на игру (видит только владелец)
create table if not exists game_roles (
  result_id bigint not null references game_results(id) on delete cascade,
  tg_id     bigint not null,
  role_key  text   not null,
  team      text   not null,
  primary key (result_id, tg_id)
);
-- Голоса за лучшего игрока
create table if not exists mvp_votes (
  result_id    bigint not null references game_results(id) on delete cascade,
  voter_tg_id  bigint not null,
  target_tg_id bigint not null,
  primary key (result_id, voter_tg_id)
);

-- ---------- Рейтинг игрока (агрегат, обновляется при завершении игры) ----------
create table if not exists player_stats (
  tg_id       bigint primary key references users(tg_id) on delete cascade,
  pts         int not null default 0,
  wins        int not null default 0,
  losses      int not null default 0,
  games       int not null default 0,
  streak      int not null default 0,
  max_streak  int not null default 0,
  wins_mafia  int not null default 0,
  wins_good   int not null default 0,
  wins_third  int not null default 0,
  mvp_total   int not null default 0,
  month_games int not null default 0,
  month_mvp   int not null default 0,
  stat_month  text
);

-- ---------- Платежи (Фаза 2 — YooKassa) ----------
create table if not exists payments (
  id         bigserial primary key,
  tg_id      bigint not null,
  game_id    text,
  amount     int not null,
  provider   text,
  ext_id     text,                             -- id платежа у провайдера
  status     text not null default 'pending',  -- pending | succeeded | canceled
  created_at timestamptz not null default now()
);

-- ---------- RLS: прямой доступ клиента закрыт (всё через Edge Function) ----------
alter table users        enable row level security;
alter table games        enable row level security;
alter table signups      enable row level security;
alter table tickets      enable row level security;
alter table game_results enable row level security;
alter table game_roles   enable row level security;
alter table mvp_votes    enable row level security;
alter table player_stats enable row level security;
alter table payments     enable row level security;
-- (политики не добавляем: service-role ключ в Edge Function обходит RLS,
--  а anon/пользователи напрямую таблицы не видят — это безопасно по умолчанию.)

-- ---------- Стартовые игры (перенос текущих дефолтов; можно потом править в «Управление») ----------
insert into games (id,title,gdate,gtime,place,price,capacity,min_players,status,format,level,descr,img) values
  ('moon','Лунная ночь','2026-07-10','19:00','Клуб «Теневой Дом»',1200,10,10,'soon','классика','Уровень: обычная','Игра при свете полной луны для опытных и новичков.','hero'),
  ('masquerade','Маскарад','2026-07-17','18:30','Академия Теней',1300,12,10,'open','тематическая','Уровень: обычная','Бал масок и интриг.','mask'),
  ('table','Теневой стол','2026-07-24','19:00','Клуб «Теневой Дом»',1200,10,10,'open','закрытый стол','Уровень: опытные','Игра для тех, кто любит стратегию и блеф.','ev-table'),
  ('raven','Зов ворона','2026-07-31','19:30','Башня Ворона',1400,12,10,'soon','тематическая','Уровень: обычная','Мрачная тематическая игра под знаком ворона.','ev-raven'),
  ('crown','Проклятие королей','2026-08-07','18:00','Замок Ночи',1500,10,10,'soon','турнир','Уровень: опытные','Премиальная игра в антураже старинного замка.','ev-crown')
on conflict (id) do nothing;
