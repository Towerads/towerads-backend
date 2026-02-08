import { pool } from "../../config/db.js";

export async function getOrCreateAdvertiserByTelegram(tgUserId) {
  const r = await pool.query(
    `
    SELECT id
    FROM advertisers
    WHERE telegram_user_id = $1
    `,
    [String(tgUserId)]
  );

  if (r.rowCount) {
    return r.rows[0].id;
  }

  const email = `tg_${String(tgUserId)}@tg.local`;

  const created = await pool.query(
    `
    INSERT INTO advertisers (email, telegram_user_id, status)
    VALUES ($1, $2, 'active')
    RETURNING id
    `,
    [email, String(tgUserId)]
  );

  return created.rows[0].id;
}

export async function advertiserMe(req, res) {
  try {
    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);

    const r = await pool.query(
      `
      SELECT id, telegram_user_id, email, status, created_at
      FROM advertisers
      WHERE id = $1
      `,
      [advertiserId]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Advertiser not found" });

    return res.json({ advertiser: r.rows[0] });
  } catch (err) {
    console.error("❌ /advertiser/me error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}

export async function me(req, res) {
  try {
    const advertiserId = await getOrCreateAdvertiserByTelegram(req.tgUserId);

    const r = await pool.query(
      `
      SELECT id, telegram_user_id, email, status, created_at
      FROM advertisers
      WHERE id = $1
      `,
      [advertiserId]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Advertiser not found" });

    return res.json({
      user: { telegram_user_id: req.tgUserId },
      role: "advertiser",
      onboarded: true,
      advertiser: r.rows[0],
    });
  } catch (err) {
    console.error("❌ /me error:", err);
    return res.status(500).json({ error: "Server error" });
  }
}
