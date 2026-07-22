// ============================================================
//  AveMafia — Edge Function «club» (Supabase / Deno).
//  Единая точка API: принимает { action, initData, payload },
//  проверяет подпись Telegram (initData), выполняет операцию с
//  service-role доступом. Клиент напрямую БД не трогает.
//
//  Секреты (Supabase → Project Settings → Edge Functions → Secrets):
//    BOT_TOKEN        — токен бота из @BotFather (для проверки initData)
//    TICKET_SECRET    — любая длинная строка (подпись билетов)
//  SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY доступны автоматически.
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const OWNER_USERNAMES = ["Lovelias21"];               // владельцы клуба (без @)
// Классификации игр. Группа = пара (город, классификация); рейтинг считается внутри группы.
const KIND_RU: Record<string, string> = {
  team: "Сборная мафия", corp: "Корпоративная мафия", kids: "Детская мафия",
};
const RP = { win: 3, loss: 0, mvp: 2, streak3: 1, mvp3mo: 2, attend5: 1 };

// Полный доступ к БД. В новых проектах Supabase секретный ключ лежит в
// авто-переменной SUPABASE_SECRET_KEYS (JSON), в старых — SUPABASE_SERVICE_ROLE_KEY.
// Заголовки НЕ переопределяем — supabase-js сам правильно оформит новый ключ.
function getSecretKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") ?? "";
  const m = raw.match(/sb_secret_[A-Za-z0-9_\-]+/);
  if (m) return m[0];
  return Deno.env.get("SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const SERVICE_KEY = getSecretKey();
const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  SERVICE_KEY,
  { auth: { persistSession: false } },
);
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const TICKET_SECRET = Deno.env.get("TICKET_SECRET") ?? "ave-mafia-secret";
// Токен платёжного провайдера (ЮKassa), выдаётся в @BotFather → Payments.
// Для отладки берётся TEST-токен — деньги не списываются, карты тестовые.
const PROVIDER_TOKEN = Deno.env.get("PROVIDER_TOKEN") ?? "";

// ---------- Чеки от ЮKassa (54-ФЗ) ----------
// Система налогообложения поставщика. ИП на УСН «доходы» (6%) = 2.
// Значения ЮKassa: 1 ОСН · 2 УСН доход · 3 УСН доход−расход · 5 ЕСХН · 6 Патент.
const TAX_SYSTEM_CODE = Number(Deno.env.get("TAX_SYSTEM_CODE") ?? "2");
// Ставка НДС в позиции чека. Для УСН товар/услуга — «Без НДС» = 1.
const VAT_CODE = Number(Deno.env.get("VAT_CODE") ?? "1");
// Состав чека для одной позиции. Email покупателя Telegram передаёт провайдеру
// сам (need_email + send_email_to_provider), поэтому customer тут не нужен.
function buildReceipt(desc: string, rub: number) {
  return {
    tax_system_code: TAX_SYSTEM_CODE,
    items: [{
      description: desc.slice(0, 128),
      quantity: "1.00",
      amount: { value: rub.toFixed(2), currency: "RUB" },
      vat_code: VAT_CODE,
      payment_mode: "full_payment",   // полный расчёт
      payment_subject: "service",     // услуга
    }],
  };
}

// Вызов Telegram Bot API (нужен для выставления счёта).
async function tgApi(method: string, payload: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await r.json();
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "content-type": "application/json" } });

// ---------- Telegram initData validation ----------
async function hmac(keyData: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");

async function verifyUser(initData: string) {
  if (!initData) throw new Error("no initData");
  const p = new URLSearchParams(initData);
  const hash = p.get("hash") ?? "";
  p.delete("hash");
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmac(new TextEncoder().encode("WebAppData"), BOT_TOKEN);
  if (hex(await hmac(secret, dcs)) !== hash) throw new Error("bad initData");
  const u = JSON.parse(p.get("user") ?? "null");
  if (!u?.id) throw new Error("no user");
  return u; // { id, first_name, last_name, username, ... }
}

// ---------- helpers ----------
const monthKey = () => { const d = new Date(); return d.getFullYear() + "-" + (d.getMonth() + 1); };
async function ticketSig(code: string, gameId: string) {
  return hex(await hmac(new TextEncoder().encode(TICKET_SECRET), `${code}|${gameId}`)).slice(0, 16);
}
async function ensureUser(tgu: any) {
  const isOwner = OWNER_USERNAMES.map((s) => s.toLowerCase()).includes(String(tgu.username || "").toLowerCase());
  // first_name/last_name/username — ВСЕГДА оригинал из Telegram (владелец видит правду).
  // display_name/city/kind тут не трогаем: их задаёт сам игрок.
  await sb.from("users").upsert({
    tg_id: tgu.id, username: tgu.username ?? null,
    first_name: tgu.first_name ?? "Игрок", last_name: tgu.last_name ?? null,
    is_owner: isOwner,
  }, { onConflict: "tg_id" });
  const { data } = await sb.from("users").select("*").eq("tg_id", tgu.id).single();
  // строка рейтинга заводится в ГРУППЕ игрока (город × классификация)
  await sb.from("player_stats").upsert(
    { tg_id: tgu.id, city: data?.city ?? "", kind: data?.kind ?? "team" },
    { onConflict: "tg_id,city,kind", ignoreDuplicates: true },
  );
  return data;
}
// Статистика игрока внутри конкретной группы.
async function statsRow(tg_id: number, city = "", kind = "team") {
  const { data } = await sb.from("player_stats").select("*")
    .eq("tg_id", tg_id).eq("city", city ?? "").eq("kind", kind ?? "team").maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { action, initData, payload = {} } = await req.json();

    // --- Публичные действия (без Telegram-авторизации): список игр и рейтинг ---
    if (action === "games") {
      // Игры своей ГРУППЫ (город × классификация). Без фильтра — все (для владельца).
      let gq = sb.from("games").select("*").eq("archived", false).order("gdate");
      if (payload?.city) gq = gq.eq("city", payload.city);
      if (payload?.kind) gq = gq.eq("kind", payload.kind);
      const { data } = await gq;
      // реальные счётчики записей по каждой игре (общие для всех)
      const { data: su } = await sb.from("signups").select("game_id, paid");
      const cnt: Record<string, number> = {}, paidCnt: Record<string, number> = {};
      (su ?? []).forEach((s: any) => { cnt[s.game_id] = (cnt[s.game_id] || 0) + 1; if (s.paid) paidCnt[s.game_id] = (paidCnt[s.game_id] || 0) + 1; });
      const games = (data ?? []).map((g: any) => ({ ...g, signup_count: cnt[g.id] || 0, paid_count: paidCnt[g.id] || 0 }));
      return json({ games });
    }
    if (action === "leaderboard") {
      // Рейтинг ВНУТРИ группы (город × классификация): показываем всех
      // зарегистрированных игроков этой группы, даже без сыгранных игр.
      const city = payload?.city ?? null;
      const kind = payload?.kind ?? null;

      // Владельцу дополнительно отдаём оригинальные имена из Telegram.
      // Для анонимов этого поля нет — иначе настоящие имена мог бы собрать кто угодно.
      let viewerIsOwner = false;
      try {
        if (initData) {
          const u = await verifyUser(initData);
          viewerIsOwner = OWNER_USERNAMES.map((s) => s.toLowerCase())
            .includes(String(u.username || "").toLowerCase());
        }
      } catch { /* не авторизован — просто обычный зритель */ }

      let uq = sb.from("users")
        .select("tg_id, first_name, last_name, username, display_name, avatar_id, city, kind, created_at")
        .order("created_at", { ascending: true }).limit(1000);
      if (city !== null) uq = uq.eq("city", city);
      if (kind !== null) uq = uq.eq("kind", kind);
      const { data: users } = await uq;

      let sq = sb.from("player_stats").select("tg_id, pts, wins, losses, games, mvp_total");
      if (city !== null) sq = sq.eq("city", city);
      if (kind !== null) sq = sq.eq("kind", kind);
      const { data: stats } = await sq;
      const byId: Record<number, any> = {};
      (stats ?? []).forEach((s: any) => { byId[s.tg_id] = s; });

      const list = (users ?? []).map((u: any) => {
        const s = byId[u.tg_id] || {};
        const row: any = {
          tg_id: u.tg_id,
          first_name: u.display_name || u.first_name || "Игрок",   // публичное имя
          avatar_id: u.avatar_id || null,
          city: u.city ?? null, kind: u.kind ?? "team",
          pts: s.pts ?? 0, wins: s.wins ?? 0, losses: s.losses ?? 0,
          games: s.games ?? 0, mvp: s.mvp_total ?? 0,
        };
        if (viewerIsOwner) {
          row.real_name = [u.first_name, u.last_name].filter(Boolean).join(" ");
          row.username = u.username ?? null;
        }
        return row;
      }).sort((a, b) => (b.pts - a.pts) || (b.games - a.games));
      return json({ leaderboard: list, count: list.length });
    }

    // --- Остальное требует подписи Telegram (initData) ---
    const tgu = await verifyUser(initData);
    const me = await ensureUser(tgu);
    const isOwner = !!me?.is_owner;
    const requireOwner = () => { if (!isOwner) throw new Error("owner only"); };

    switch (action) {
      // ---- профиль/старт: вернуть всё, что нужно фронту ----
      case "init": {
        // Обновим профиль из регистрации, если пришёл.
        // ВАЖНО: имя из формы пишем в display_name, а НЕ в first_name —
        // first_name/last_name/username остаются оригиналом из Telegram,
        // чтобы владелец всегда видел, кто это на самом деле.
        if (payload.profile) {
          const pr = payload.profile;
          const upd: Record<string, unknown> = {
            occupation: pr.occupation ?? me.occupation,
            birthday: pr.birthday || null,
            phone: pr.phone ?? me.phone,
          };
          if (pr.first) upd.display_name = String(pr.first).trim().slice(0, 40);
          if (pr.city) upd.city = String(pr.city).trim().slice(0, 40);
          if (pr.kind) upd.kind = String(pr.kind);
          await sb.from("users").update(upd).eq("tg_id", me.tg_id);
        }
        const fresh = await one("users", me.tg_id);
        const stats = await statsRow(me.tg_id, fresh?.city ?? "", fresh?.kind ?? "team");
        return json({ me: fresh, stats, isOwner });
      }

      // ---- игрок меняет своё имя и/или группу (город + классификация) ----
      case "saveProfile": {
        const upd: Record<string, unknown> = {};
        if (payload.displayName !== undefined) {
          const n = String(payload.displayName || "").trim().slice(0, 40);
          upd.display_name = n || null;          // пусто → снова показываем имя из Telegram
        }
        if (payload.city !== undefined) upd.city = String(payload.city || "").trim().slice(0, 40);
        if (payload.kind !== undefined) upd.kind = String(payload.kind || "team");
        if (Object.keys(upd).length) await sb.from("users").update(upd).eq("tg_id", me.tg_id);
        return json({ me: await one("users", me.tg_id) });
      }

      // ---- владелец: создать/обновить игру ----
      case "adminSaveGame": {
        requireOwner();
        const g = payload.game;
        await sb.from("games").upsert(g, { onConflict: "id" });
        const { data } = await sb.from("games").select("*").eq("archived", false).order("gdate");
        return json({ games: data ?? [] });
      }
      case "adminDeleteGame": {
        requireOwner();
        await sb.from("games").update({ archived: true }).eq("id", payload.gameId);
        return json({ ok: true });
      }

      // ---- записи на игру ----
      case "signups": {
        const { data } = await sb.from("signups")
          .select("tg_id, paid, joined_at, users(first_name)")
          .eq("game_id", payload.gameId).order("joined_at");
        return json({ signups: data ?? [] });
      }
      case "signup": {
        // Жёсткий запрет записи в чужую группу: игра из другого города или
        // другой классификации недоступна. Проверяем на сервере — клиенту нельзя доверять.
        const { data: g } = await sb.from("games").select("city, kind").eq("id", payload.gameId).single();
        if (!g) throw new Error("игра не найдена");
        const myCity = me.city ?? "", myKind = me.kind ?? "team";
        if ((g.city ?? "") !== myCity || (g.kind ?? "team") !== myKind) {
          throw new Error(
            `Это игра другой группы: ${g.city || "—"} · ${KIND_RU[g.kind] || g.kind}. ` +
            `Ваша группа: ${myCity || "—"} · ${KIND_RU[myKind] || myKind}. Сменить можно в профиле.`,
          );
        }
        await sb.from("signups").upsert({ game_id: payload.gameId, tg_id: me.tg_id }, { onConflict: "game_id,tg_id", ignoreDuplicates: true });
        return json(await signupList(payload.gameId));
      }
      case "cancelSignup": {
        await sb.from("signups").delete().eq("game_id", payload.gameId).eq("tg_id", me.tg_id);
        return json(await signupList(payload.gameId));
      }

      // ---- ВЫСТАВИТЬ СЧЁТ (ЮKassa через Telegram Payments) ----
      // Возвращаем ссылку на счёт; фронт открывает её через TG.openInvoice().
      // Деньги зачисляет НЕ этот вызов, а вебхук `tgbot` (successful_payment) —
      // так подтверждение приходит от Telegram, а не от клиента (его нельзя подделать).
      case "createInvoice": {
        if (!PROVIDER_TOKEN) throw new Error("PROVIDER_TOKEN не задан в секретах функции");
        const kind = String(payload.kind || "game");   // game | avatar | style
        let title = "", description = "", amount = 0, ip = "";
        if (kind === "game") {
          const { data: g } = await sb.from("games").select("*").eq("id", payload.id).single();
          if (!g) throw new Error("игра не найдена");
          amount = +g.price || 0;
          title = g.title || "Участие в игре";
          description = ["Участие в игре", g.gdate, g.gtime, g.place].filter(Boolean).join(" · ");
          ip = `game:${g.id}`;
        } else if (kind === "avatar" || kind === "style") {
          amount = +payload.rub || 0;
          title = (kind === "avatar" ? "Аватарка" : "Стиль") + ` «${payload.name || payload.id}»`;
          description = "Оформление профиля в клубе «АвеМафия»";
          ip = `${kind}:${payload.id}`;
        } else throw new Error("неизвестный тип покупки");
        if (!(amount > 0)) throw new Error("некорректная сумма");
        ip += `:${me.tg_id}`;                       // чтобы вебхук знал плательщика
        const inv = await tgApi("createInvoiceLink", {
          title: title.slice(0, 32),                // лимиты Telegram
          description: description.slice(0, 255),
          payload: ip,
          provider_token: PROVIDER_TOKEN,
          currency: "RUB",
          prices: [{ label: title.slice(0, 32), amount: Math.round(amount * 100) }], // в копейках
          need_email: true, send_email_to_provider: true,   // e-mail для чека уходит в ЮKassa
          // Состав чека (54-ФЗ, «Чеки от ЮKassa»). Сумма позиции = сумме счёта.
          provider_data: JSON.stringify({ receipt: buildReceipt(title, amount) }),
        });
        if (!inv?.ok) throw new Error("Telegram: " + (inv?.description || "createInvoiceLink failed"));
        // фиксируем намерение оплаты (статус обновит вебхук)
        await sb.from("payments").insert({
          tg_id: me.tg_id, game_id: kind === "game" ? payload.id : null,
          amount, provider: "yookassa", status: "pending",
        });
        return json({ link: inv.result });
      }

      // ---- оплата (Фаза 1: без реальных денег — выдаём билет; Фаза 2: YooKassa) ----
      case "pay": {
        await sb.from("signups").update({ paid: true }).eq("game_id", payload.gameId).eq("tg_id", me.tg_id);
        const code = "AM-" + Math.floor(1000 + Math.random() * 8999);
        const sig = await ticketSig(code, payload.gameId);
        await sb.from("tickets").upsert({ code, game_id: payload.gameId, tg_id: me.tg_id, sig });
        return json({ ticket: { code, gameId: payload.gameId, sig } });
      }

      // ---- мои билеты (их создаёт вебхук после реальной оплаты) ----
      case "myTickets": {
        const { data } = await sb.from("tickets")
          .select("code, game_id, sig, used, used_at, issued_at")
          .eq("tg_id", me.tg_id).order("issued_at", { ascending: false });
        return json({ tickets: data ?? [] });
      }

      // ---- владелец: проверка билета на входе ----
      case "verifyTicket": {
        requireOwner();
        const parts = String(payload.raw || "").trim().split("|"); // AVEMAFIA|CODE|GAME|SIG
        if (parts[0] !== "AVEMAFIA" || parts.length < 4) return json({ ok: false, reason: "fake" });
        const [, code, gameId, sig] = parts;
        if (sig !== (await ticketSig(code, gameId))) return json({ ok: false, reason: "fake" });
        const { data: t } = await sb.from("tickets").select("*").eq("code", code).eq("game_id", gameId).single();
        if (!t) return json({ ok: false, reason: "notfound" });
        if (t.used) return json({ ok: false, reason: "used", usedAt: t.used_at });
        await sb.from("tickets").update({ used: true, used_at: new Date().toISOString() }).eq("code", code);
        return json({ ok: true, code });
      }

      // ---- владелец: подвести итог игры (роли + результат + голоса) → рейтинг ----
      case "finalizeGame": {
        requireOwner();
        const { gameId, roles, result, votes } = payload; // roles:{tgId:{key,team}}, result:'good', votes:{voter:target}
        const ids = Object.keys(roles).map(Number);
        // MVP по голосам
        const tally: Record<number, number> = {};
        for (const v of Object.values(votes || {}) as number[]) tally[v] = (tally[v] || 0) + 1;
        let mvp: number | null = null, best = -1;
        for (const id of ids) { const c = tally[id] || 0; if (c > best) { best = c; mvp = id; } }
        const { data: res } = await sb.from("game_results").insert({ game_id: gameId, win_team: result, mvp_tg_id: mvp }).select().single();
        for (const id of ids) await sb.from("game_roles").insert({ result_id: res.id, tg_id: id, role_key: roles[id].key, team: roles[id].team });
        // Рейтинг начисляем в ГРУППЕ ИГРЫ (город × классификация), а не «вообще».
        // Так очки Владивостока не перемешиваются с Москвой и детской мафией.
        const { data: gRow } = await sb.from("games").select("city, kind").eq("id", gameId).single();
        const gCity = gRow?.city ?? "", gKind = gRow?.kind ?? "team";
        const mk = monthKey();
        for (const id of ids) {
          const s = await statsRow(id, gCity, gKind) ?? { tg_id: id, city: gCity, kind: gKind, pts: 0, wins: 0, losses: 0, games: 0, streak: 0, max_streak: 0, wins_mafia: 0, wins_good: 0, wins_third: 0, mvp_total: 0, month_games: 0, month_mvp: 0, stat_month: mk };
          if (s.stat_month !== mk) { s.stat_month = mk; s.month_games = 0; s.month_mvp = 0; }
          const won = roles[id].team === result;
          s.games++; s.month_games++;
          if (won) { s.wins++; s.pts += RP.win; s.streak++; if (s.streak > s.max_streak) s.max_streak = s.streak; s["wins_" + result]++; if (s.streak % 3 === 0) s.pts += RP.streak3; }
          else { s.losses++; s.streak = 0; }
          if (s.month_games === 5) s.pts += RP.attend5;
          await sb.from("player_stats").upsert(s, { onConflict: "tg_id,city,kind" });
        }
        if (mvp != null) {
          const s = await statsRow(mvp, gCity, gKind);
          if (s) {
            s.pts += RP.mvp; s.mvp_total++; s.month_mvp++;
            if (s.month_mvp === 3) s.pts += RP.mvp3mo;
            await sb.from("player_stats").upsert(s, { onConflict: "tg_id,city,kind" });
          }
          // лучшему игроку — сундук
          const { data: mu } = await sb.from("users").select("chests").eq("tg_id", mvp).single();
          await sb.from("users").update({ chests: (mu?.chests || 0) + 1 }).eq("tg_id", mvp);
        }
        return json({ ok: true, mvp });
      }

      // ---- сохранить любимые роли / активную аватарку / покупку ----
      case "saveFavRoles": { await sb.from("users").update({ fav_roles: payload.roles ?? [] }).eq("tg_id", me.tg_id); return json({ ok: true }); }
      case "saveAvatar":   { await sb.from("users").update({ avatar_id: payload.id }).eq("tg_id", me.tg_id); return json({ ok: true }); }
      case "buyAvatar":    { const list = new Set([...(me.avatars || []), payload.id]); await sb.from("users").update({ avatars: [...list] }).eq("tg_id", me.tg_id); return json({ ok: true }); }

      default:
        return json({ error: "unknown action: " + action }, 400);
    }
  } catch (e) {
    return json({ error: String(e?.message || e) }, 400);
  }
});

// ---------- маленькие хелперы ----------
async function one(table: string, tg_id: number) {
  const { data } = await sb.from(table).select("*").eq("tg_id", tg_id).single();
  return data;
}
async function signupList(gameId: string) {
  const { data } = await sb.from("signups")
    .select("tg_id, paid, joined_at, users(first_name)")
    .eq("game_id", gameId).order("joined_at");
  return { signups: data ?? [] };
}
