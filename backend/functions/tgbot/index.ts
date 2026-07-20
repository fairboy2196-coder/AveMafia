// ============================================================
//  AveMafia — Edge Function «tgbot» (Supabase / Deno).
//  Это WEBHOOK бота: Telegram шлёт сюда апдейты (/start, оплата).
//
//  ВАЖНО при деплое: у этой функции ПРОВЕРКА JWT ДОЛЖНА БЫТЬ ВЫКЛЮЧЕНА
//  (Verify JWT = OFF), иначе Supabase отклонит запросы Telegram (он не
//  шлёт заголовок Authorization). Наша защита — секретный токен webhook.
//
//  Что делает:
//   • /start           → приветствие с ценами игр + кнопка «Открыть клуб»
//                        (это и нужный YooKassa скрин «из бота до запуска»).
//   • pre_checkout_query→ подтверждает счёт Telegram (иначе оплата не пройдёт).
//   • successful_payment→ помечает запись оплаченной, пишет платёж, выдаёт билет.
//
//  Секреты (общие для проекта): BOT_TOKEN, TICKET_SECRET,
//  SUPABASE_URL, SUPABASE_SECRET_KEYS, WEBHOOK_SECRET (необязательный).
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const APP_URL = "https://fairboy2196-coder.github.io/AveMafia/";
const BOT_TOKEN = Deno.env.get("BOT_TOKEN") ?? "";
const TICKET_SECRET = Deno.env.get("TICKET_SECRET") ?? "ave-mafia-secret";
const WEBHOOK_SECRET = Deno.env.get("WEBHOOK_SECRET") ?? ""; // если задан — проверяем заголовок

function getSecretKey(): string {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS") ?? "";
  const m = raw.match(/sb_secret_[A-Za-z0-9_\-]+/);
  if (m) return m[0];
  return Deno.env.get("SERVICE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
}
const sb = createClient(Deno.env.get("SUPABASE_URL")!, getSecretKey(), { auth: { persistSession: false } });

// ---------- Telegram Bot API ----------
async function tgApi(method: string, payload: unknown) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return await r.json();
}

// ---------- подпись билета (та же схема, что в club) ----------
async function hmac(keyData: Uint8Array, msg: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg)));
}
const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
async function ticketSig(code: string, gameId: string) {
  return hex(await hmac(new TextEncoder().encode(TICKET_SECRET), `${code}|${gameId}`)).slice(0, 16);
}

// ---------- приветствие /start ----------
async function sendWelcome(chatId: number) {
  const { data: games } = await sb.from("games").select("title, price, gdate")
    .eq("archived", false).order("gdate").limit(6);
  const lines = (games ?? []).filter((g: any) => +g.price > 0)
    .map((g: any) => `• ${g.title} — ${(+g.price).toLocaleString("ru-RU")} ₽`).join("\n");
  const text =
    "🎭 *АвеМафия* — клуб мафиозных игр\n\n" +
    "Живые игры в мафию для новичков и опытных. Выбирайте игру, записывайтесь и оплачивайте участие прямо в приложении.\n\n" +
    (lines ? ("*Ближайшие игры:*\n" + lines + "\n\n") : "") +
    "Нажмите кнопку ниже, чтобы открыть клуб, выбрать игру и оплатить участие.";
  await tgApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: [[{ text: "🎭 Открыть клуб", web_app: { url: APP_URL } }]] },
  });
}

// ---------- успешная оплата → билет ----------
async function onPaid(msg: any) {
  const sp = msg.successful_payment;
  // invoice_payload формата "<kind>:<id>:<tgId>" (кладём его в club/createInvoice)
  const parts = String(sp?.invoice_payload || "").split(":");
  const kind = parts[0] || "game";
  const itemId = parts[1] || "";
  const tgId = Number(parts[2]) || msg.from?.id;    // плательщик из payload надёжнее
  const rub = Math.round((sp?.total_amount || 0) / 100);
  if (!tgId || !itemId) return;

  // платёж в историю (общая для всех видов покупок)
  await sb.from("payments").insert({
    tg_id: tgId, game_id: kind === "game" ? itemId : null, amount: rub,
    provider: "yookassa", ext_id: sp.provider_payment_charge_id || sp.telegram_payment_charge_id || null,
    status: "succeeded",
  });

  if (kind === "game") {
    // запись оплачена + билет с подписью
    await sb.from("signups").upsert({ game_id: itemId, tg_id: tgId, paid: true }, { onConflict: "game_id,tg_id" });
    const code = "AM-" + Math.floor(1000 + Math.random() * 8999);
    const sig = await ticketSig(code, itemId);
    await sb.from("tickets").upsert({ code, game_id: itemId, tg_id: tgId, sig });
    await tgApi("sendMessage", {
      chat_id: msg.chat.id,
      text: `✅ Оплата получена! Ваш билет №${code} готов — откройте приложение, чтобы показать QR на входе.`,
      reply_markup: { inline_keyboard: [[{ text: "🎫 Мой билет", web_app: { url: APP_URL } }]] },
    });
    return;
  }

  // Цифровые товары: аватарка / стиль интерфейса — выдаём в профиль игрока.
  const col = kind === "avatar" ? "avatars" : "styles";
  const { data: u } = await sb.from("users").select(col).eq("tg_id", tgId).single();
  const owned: string[] = (u as any)?.[col] || [];
  if (!owned.includes(itemId)) {
    await sb.from("users").update({ [col]: [...owned, itemId] }).eq("tg_id", tgId);
  }
  await tgApi("sendMessage", {
    chat_id: msg.chat.id,
    text: `✅ Покупка оплачена! ${kind === "avatar" ? "Аватарка" : "Стиль оформления"} открыт — загляните в профиль.`,
    reply_markup: { inline_keyboard: [[{ text: "🎭 Открыть клуб", web_app: { url: APP_URL } }]] },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  // Защита webhook: если задан WEBHOOK_SECRET — Telegram должен прислать его в заголовке.
  if (WEBHOOK_SECRET) {
    const got = req.headers.get("x-telegram-bot-api-secret-token") || "";
    if (got !== WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
  }
  try {
    const u = await req.json();
    // pre_checkout: обязателен ответ в течение 10 сек, иначе оплата отменится
    if (u.pre_checkout_query) {
      await tgApi("answerPreCheckoutQuery", { pre_checkout_query_id: u.pre_checkout_query.id, ok: true });
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    }
    const msg = u.message || u.edited_message;
    if (msg) {
      if (msg.successful_payment) {
        await onPaid(msg);
      } else if (typeof msg.text === "string" && msg.text.startsWith("/start")) {
        await sendWelcome(msg.chat.id);
      }
    }
    return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error)?.message || e) }), {
      headers: { "content-type": "application/json" },
    });
  }
});
