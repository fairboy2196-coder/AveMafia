# AveMafia — бэкенд (Supabase)

Фаза 1: общая база для всех игроков (регистрация по Telegram, общие игры/записи/рейтинг/профили/билеты). Оплата (YooKassa) — фаза 2.

## Шаг 1. Создать проект
1. https://supabase.com → войти (через GitHub) → **New project**.
2. Имя: `avemafia`, задать **Database password** (сохрани), регион — ближе к тебе (Frankfurt).
3. Дождаться, пока проект поднимется (~2 мин).

## Шаг 2. Создать таблицы
1. Слева **SQL Editor** → **New query**.
2. Открыть файл `backend/schema.sql`, скопировать **всё** → вставить → **Run**.
3. Проверить: слева **Table Editor** — появились таблицы `users`, `games`, `signups`, `tickets`, `player_stats` и др., в `games` — 5 стартовых игр.

## Шаг 3. Задать секреты
**Project Settings → Edge Functions → Secrets** (или Settings → Functions) → добавить:
- `BOT_TOKEN` — токен твоего бота из @BotFather (нужен, чтобы проверять подпись Telegram).
- `TICKET_SECRET` — любая длинная случайная строка (подпись билетов), напр. 32+ символов.

## Шаг 4. Задеплоить функцию `club`
Проще всего через браузер:
1. Слева **Edge Functions** → **Create a new function** → имя ровно **`club`**.
2. Открыть `backend/functions/club/index.ts`, скопировать **весь** код → вставить в редактор функции.
3. **Deploy**.

(Либо через CLI: `supabase functions deploy club --project-ref <ref>`.)

## Шаг 5. Прислать мне ключи
**Project Settings → API**:
- **Project URL** (вида `https://xxxx.supabase.co`)
- **anon public** key (длинный публичный ключ — безопасно)

Пришли эти два значения — я пропишу их во фронт (`index.html`) и переведу приложение с localStorage на реальный API по одной сущности за раз.

---

### Что уже готово в этой папке
- `schema.sql` — все таблицы фазы 1 + RLS + стартовые игры.
- `functions/club/index.ts` — единый API: проверка Telegram `initData` и действия: `init`, `games`, `adminSaveGame`, `signups/signup/cancelSignup`, `pay` (выдача билета), `verifyTicket`, `finalizeGame` (роли→рейтинг, сундук MVP), `leaderboard`, `saveFavRoles/saveAvatar/buyAvatar`.

### Как фронт будет обращаться
Один POST на функцию с `{ action, initData, payload }`, где `initData = Telegram.WebApp.initData`. Сервер проверяет подпись, узнаёт игрока и выполняет операцию. Прямого доступа к БД у клиента нет (безопасно).
