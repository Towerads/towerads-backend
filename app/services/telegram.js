const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.warn("⚠️ TELEGRAM_BOT_TOKEN is not set");
}

export async function sendTelegramMessage(telegramUserId, text) {
  if (!BOT_TOKEN || !telegramUserId) return;

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramUserId,
        text,
        parse_mode: "HTML",
      }),
    });
  } catch (err) {
    console.error("❌ Telegram send error:", err);
  }
}
