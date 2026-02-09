import crypto from "crypto";

function parseInitData(initData) {
  const params = new URLSearchParams(initData);
  const data = {};
  for (const [k, v] of params.entries()) data[k] = v;
  return data;
}

function buildDataCheckString(data) {
  // по доке Telegram: сортируем ключи, исключая hash
  const keys = Object.keys(data).filter((k) => k !== "hash").sort();
  return keys.map((k) => `${k}=${data[k]}`).join("\n");
}

function verifyTelegramInitData(initData, botToken) {
  const data = parseInitData(initData);
  const hash = data.hash;
  if (!hash) return { ok: false, error: "Missing hash in initData" };

  const dataCheckString = buildDataCheckString(data);

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();

  // check_hash = HMAC_SHA256(secret_key, data_check_string)
  const checkHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  // constant-time compare
  const a = Buffer.from(checkHash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: "Invalid initData hash" };
  }

  // user приходит JSON строкой
  let user = null;
  try {
    user = data.user ? JSON.parse(data.user) : null;
  } catch {
    return { ok: false, error: "Invalid user JSON in initData" };
  }

  if (!user?.id) return { ok: false, error: "Missing user.id in initData" };

  return { ok: true, user };
}

export function requireTelegramUser(req, res, next) {
  // 1) сначала пробуем initData (боевой режим)
  const initData =
    req.header("X-TG-INIT-DATA") ||
    req.header("Authorization")?.replace(/^Bearer\s+/i, "");

  // 2) временный fallback для тестов (можно убрать позже)
  const legacyId = req.header("X-TG-USER-ID");

  const botToken = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;

  if (initData) {
    if (!botToken) {
      return res.status(500).json({ error: "Server misconfigured: missing TELEGRAM_BOT_TOKEN" });
    }
    const r = verifyTelegramInitData(initData, botToken);
    if (!r.ok) return res.status(401).json({ error: r.error });

    req.tgUserId = String(r.user.id);
    req.tgUser = r.user;
    return next();
  }

  // fallback на период внедрения фронта
  if (legacyId) {
    req.tgUserId = String(legacyId);
    return next();
  }

  return res.status(401).json({ error: "Missing Telegram initData" });
}
