export function requireTelegramUser(req, res, next) {
  const tgUserId = req.header("X-TG-USER-ID");

  if (!tgUserId) {
    return res.status(401).json({
      error: "Missing Telegram user id",
    });
  }

  // всегда храним как строку
  req.tgUserId = String(tgUserId);

  return next();
}
