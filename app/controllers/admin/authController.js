import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../../config/db.js";

export async function adminLogin(req, res) {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Missing email or password" });
    }

    const r = await pool.query(
      `
      SELECT id, email, password_hash, role, status
      FROM admin_users
      WHERE email = $1
      `,
      [email]
    );

    if (!r.rowCount) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const admin = r.rows[0];
    if (admin.status !== "active") {
      return res.status(403).json({ error: "Admin disabled" });
    }

    const okPass = await bcrypt.compare(password, admin.password_hash);
    if (!okPass) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const token = jwt.sign(
      {
        id: admin.id,
        role: admin.role,
      },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: "7d" }
    );

    await pool.query(
      "UPDATE admin_users SET last_login_at = now() WHERE id = $1",
      [admin.id]
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error("❌ admin login error:", err);
    res.status(500).json({ error: "Server error" });
  }
}
