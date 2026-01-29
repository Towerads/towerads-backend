
export async function sendTelegramMessage(telegramUserId, text) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

  if (!BOT_TOKEN || !telegramUserId) {
    console.warn("⚠️ Telegram token or user id missing");
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: telegramUserId,
      text,
      parse_mode: "HTML",
    }),
  });
}
