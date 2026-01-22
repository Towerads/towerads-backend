import jwt from "jsonwebtoken";

export function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;

  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const token = auth.split(" ")[1];
    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);

    if (payload.role !== "admin") {
      return res.status(403).json({ error: "Forbidden" });
    }

    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}
