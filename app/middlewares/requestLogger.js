export function requestLogger(req, res, next) {
  // Логируем только SDK (как у тебя было)
  if (req.path.startsWith("/api/tower-ads")) {
    console.log("📥 INCOMING REQUEST");
    console.log("PATH:", req.path);
    console.log("BODY:", JSON.stringify(req.body, null, 2));
    console.log("HEADERS:", req.headers);
  }
  next();
}
