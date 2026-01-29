export async function sendTelegramMessage(chatId, text) {
  const token = process.env.TG_BOT_TOKEN;
  if (!token) {
    console.warn("⚠️ TG_BOT_TOKEN is missing");
    return;
  }
  if (!chatId) return;

  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("❌ Telegram API error:", r.status, errText);
    }
  } catch (e) {
    console.error("❌ Telegram send error:", e);
  }
}
