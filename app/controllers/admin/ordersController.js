import { pool } from "../../config/db.js";

export async function createCreativeOrder(req, res) {
  try {
    const { creative_id, pricing_plan_id, impressions_total, price_usd } =
      req.body || {};

    let impressions = impressions_total;
    let price = price_usd;

    if (pricing_plan_id) {
      const plan = await pool.query(
        `
        SELECT impressions, price_usd
        FROM pricing_plans
        WHERE id = $1::uuid
        `,
        [pricing_plan_id]
      );

      if (!plan.rowCount) {
        return res.status(400).json({ error: "Invalid pricing plan" });
      }

      impressions = plan.rows[0].impressions;
      price = plan.rows[0].price_usd;
    }

    if (!creative_id || !impressions || !price) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const cr = await pool.query(
      `
      SELECT id
      FROM creatives
      WHERE id = $1::uuid
        AND status = 'approved'
      `,
      [creative_id]
    );

    if (!cr.rowCount) {
      return res.status(400).json({ error: "Creative not approved" });
    }

    const pricePerImpression = price / impressions;

    const order = await pool.query(
      `
      INSERT INTO creative_orders (
        creative_id,
        impressions_total,
        impressions_left,
        price_usd,
        price_per_impression,
        status
      )
      VALUES ($1::uuid, $2, $2, $3, $4, 'active')
      RETURNING id
      `,
      [creative_id, impressions, price, pricePerImpression]
    );

    await pool.query(
      `
      INSERT INTO ads (
        id,
        placement_id,
        ad_type,
        media_url,
        click_url,
        duration,
        status,
        source,
        creative_id
      )
      SELECT
        'usl_' || replace(gen_random_uuid()::text, '-', ''),
        p.id,
        c.type,
        c.media_url,
        c.click_url,
        c.duration,
        'active',
        'usl',
        c.id
      FROM creatives c
      CROSS JOIN placements p
      WHERE c.id = $1::uuid
      LIMIT 1
      `,
      [creative_id]
    );

    res.json({ success: true, order_id: order.rows[0].id });
  } catch (err) {
    console.error("❌ create creative order error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function listOrders(req, res) {
  try {
    const { status, q, page = "1", limit = "20" } = req.query;

    const p = Math.max(1, Number(page));
    const l = Math.min(100, Math.max(1, Number(limit)));
    const offset = (p - 1) * l;

    const where = [];
    const params = [];

    if (status) {
      params.push(status);
      where.push(`co.status = $${params.length}`);
    }

    if (q) {
      params.push(`%${q.toLowerCase()}%`);
      where.push(`
        (
          LOWER(a.email) LIKE $${params.length}
          OR co.id::text LIKE $${params.length}
          OR c.id::text LIKE $${params.length}
        )
      `);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const total = await pool.query(
      `
      SELECT COUNT(*)::int AS total
      FROM creative_orders co
      JOIN creatives c ON c.id = co.creative_id
      JOIN advertisers a ON a.id = c.advertiser_id
      ${whereSql}
      `,
      params
    );

    params.push(l, offset);

    const r = await pool.query(
      `
      SELECT
        co.id,
        co.status,
        co.impressions_total,
        co.impressions_left,
        co.price_usd,
        co.created_at,
        c.id AS creative_id,
        c.type AS creative_type,
        a.email AS advertiser_email,
        (co.impressions_total - co.impressions_left)::int AS impressions_done
      FROM creative_orders co
      JOIN creatives c ON c.id = co.creative_id
      JOIN advertisers a ON a.id = c.advertiser_id
      ${whereSql}
      ORDER BY co.created_at DESC
      LIMIT $${params.length - 1}
      OFFSET $${params.length}
      `,
      params
    );

    res.json({
      items: r.rows,
      total: total.rows[0].total,
      page: p,
      limit: l,
    });
  } catch (err) {
    console.error("❌ admin orders error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function orderDetail(req, res) {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `
      SELECT
        co.*,
        c.media_url,
        c.click_url,
        c.type AS creative_type,
        a.email AS advertiser_email,
        (co.impressions_total - co.impressions_left)::int AS impressions_done
      FROM creative_orders co
      JOIN creatives c ON c.id = co.creative_id
      JOIN advertisers a ON a.id = c.advertiser_id
      WHERE co.id = $1::uuid
      `,
      [id]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Order not found" });

    res.json({ order: r.rows[0] });
  } catch (err) {
    console.error("❌ admin order detail error:", err);
    res.status(500).json({ error: "Server error" });
  }
}

export async function pauseOrder(req, res) {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `
      UPDATE creative_orders
      SET status = 'paused'
      WHERE id = $1::uuid AND status = 'active'
      RETURNING creative_id
      `,
      [id]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: "Order not active" });
    }

    await pool.query(
      `
      UPDATE ads
      SET status = 'paused'
      WHERE source = 'usl'
        AND creative_id = $1::uuid
      `,
      [r.rows[0].creative_id]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ PAUSE ORDER ERROR:", err);
    return res.status(500).json({ error: "Pause failed" });
  }
}

export async function resumeOrder(req, res) {
  try {
    const { id } = req.params;

    const r = await pool.query(
      `
      UPDATE creative_orders
      SET status = 'active'
      WHERE id = $1::uuid AND status = 'paused'
      RETURNING creative_id
      `,
      [id]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: "Order not paused" });
    }

    await pool.query(
      `
      UPDATE ads
      SET status = 'active'
      WHERE source = 'usl'
        AND creative_id = $1::uuid
      `,
      [r.rows[0].creative_id]
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("❌ RESUME ORDER ERROR:", err);
    return res.status(500).json({ error: "Resume failed" });
  }
}

export async function stopOrder(req, res) {
  const r = await pool.query(
    `
    UPDATE creative_orders
    SET status = 'completed',
        impressions_left = 0
    WHERE id = $1::uuid
      AND status IN ('active','paused')
    RETURNING creative_id
    `,
    [req.params.id]
  );

  if (!r.rowCount) return res.status(400).json({ error: "Order not stoppable" });

  await pool.query(
    `
    UPDATE ads
    SET status = 'paused'
    WHERE source = 'usl'
      AND creative_id = $1::uuid
    `,
    [r.rows[0].creative_id]
  );

  res.json({ success: true });
}
