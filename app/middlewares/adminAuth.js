import jwt from "jsonwebtoken";

export function requireAdmin(req, res, next) {
  // 🔥 ВАЖНО: пропускаем preflight
  if (req.method === "OPTIONS") {
    return next();
  }

  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No auth token" });
  }

  const token = header.slice("Bearer ".length);

  try {
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid token" });
  }
}
