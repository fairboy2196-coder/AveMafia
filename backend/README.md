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

## Фаза 2. Оплата (ЮKassa через Telegram Payments)

Код уже написан. Осталась настройка — по шагам.

### Шаг П1. Применить миграцию
SQL Editor → New query → вставить весь `backend/migrations/002_payments_styles.sql` → **Run**.
(Добавляет `users.styles` и индексы для `payments`. Запускать повторно безопасно.)

### Шаг П2. Получить платёжный токен
1. @BotFather → `/mybots` → выбрать бота → **Payments**.
2. Выбрать **ЮKassa (YooKassa)** → подключить.
3. Сначала бери **TEST-токен** — он позволяет пройти весь путь оплаты тестовыми картами, **деньги не списываются**. Боевой токен подключишь, когда ЮKassa одобрит договор (нужно ИП/ООО).
4. Токен вида `381764678:TEST:xxxxx` — скопировать.

### Шаг П3. Добавить секреты
**Project Settings → Edge Functions → Secrets**:
- `PROVIDER_TOKEN` — токен из шага П2.
- `WEBHOOK_SECRET` — любая длинная случайная строка (защита вебхука).

### Шаг П4. Задеплоить обе функции
- `club` — обновить кодом из `backend/functions/club/index.ts` (добавились `createInvoice`, `myTickets`).
- `tgbot` — создать/обновить из `backend/functions/tgbot/index.ts`.
  **ВАЖНО:** у `tgbot` выключить **Verify JWT** (Telegram не шлёт `Authorization`).

### Шаг П5. Прописать вебхук
Открыть в браузере (подставив свои значения):

```
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<project-ref>.supabase.co/functions/v1/tgbot&secret_token=<WEBHOOK_SECRET>
```

Проверить: `https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo` — должен быть указан твой URL и `pending_update_count: 0`.

### Шаг П6. Проверить оплату
1. Открыть Mini App → «Игры» → записаться → **«Оплатить»**.
2. Откроется окно Telegram с суммой. Тестовая карта ЮKassa: **1111 1111 1111 1026**, срок `12/26`, CVC `000`.
3. После оплаты: бот пришлёт сообщение с номером билета, в приложении появится QR, в базе — строка в `payments` (`status: succeeded`) и в `tickets`.

### Как устроено (важно для безопасности)
Клиент **не может** сам «зачислить» оплату. Фронт лишь просит счёт (`createInvoice`) и открывает окно Telegram. Факт оплаты подтверждает **Telegram → вебхук `tgbot`** (`successful_payment`), и только вебхук помечает запись оплаченной, пишет платёж и выдаёт билет. Поэтому подделать оплату из браузера нельзя.

### Что осталось по чекам (54-ФЗ)
Сейчас счёт создаётся с `need_email` + `send_email_to_provider`. Если ЮKassa потребует полноценный чек, добавим `provider_data` с составом чека в `club/createInvoice` — скажи, когда дойдёшь до боевого токена.

---

### Что уже готово в этой папке
- `schema.sql` — все таблицы фазы 1 + RLS + стартовые игры.
- `functions/club/index.ts` — единый API: проверка Telegram `initData` и действия: `init`, `games`, `adminSaveGame`, `signups/signup/cancelSignup`, `pay` (выдача билета), `verifyTicket`, `finalizeGame` (роли→рейтинг, сундук MVP), `leaderboard`, `saveFavRoles/saveAvatar/buyAvatar`.

### Как фронт будет обращаться
Один POST на функцию с `{ action, initData, payload }`, где `initData = Telegram.WebApp.initData`. Сервер проверяет подпись, узнаёт игрока и выполняет операцию. Прямого доступа к БД у клиента нет (безопасно).
