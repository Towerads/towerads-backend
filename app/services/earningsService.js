// towerads-backend/app/services/earningsService.js
import pkg from "pg";
const { Pool } = pkg;

// ✅ pool на тех же env
const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

pool
  .query("SELECT 1")
  .then(() => console.log("✅ earningsService: PostgreSQL connected"))
  .catch((err) =>
    console.error("❌ earningsService: PostgreSQL connection error:", err)
  );

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ====== MSK helpers ======
// МСК = UTC+3 (без DST)
const MSK_OFFSET_MIN = 180;

function pad2(x) {
  return String(x).padStart(2, "0");
}

// YYYY-MM-DD из даты по МСК
function mskDayKeyFromUtcDate(dateUtc) {
  const d = new Date(dateUtc);
  const msk = new Date(d.getTime() + MSK_OFFSET_MIN * 60 * 1000);

  const y = msk.getUTCFullYear();
  const m = pad2(msk.getUTCMonth() + 1);
  const day = pad2(msk.getUTCDate());
  return `${y}-${m}-${day}`;
}

// В UTC-таймштамп начала МСК-дня (03:00 MSK) для date_key
// date_key = YYYY-MM-DD (по МСК)
// startUtc = date_key 00:00 MSK - 3h => date_key 21:00Z предыдущего дня
function mskDayStartUtc(dateKey /* YYYY-MM-DD */) {
  // берём "dateKeyT00:00:00Z" как опорную UTC-дату
  // и сдвигаем на -3 часа, чтобы это было 00:00 MSK => 21:00Z предыдущего
  const base = new Date(`${dateKey}T00:00:00.000Z`);
  return new Date(base.getTime() - MSK_OFFSET_MIN * 60 * 1000);
}

function addDays(dateObj, days) {
  return new Date(dateObj.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * accrueDailyEarnings
 * day: YYYY-MM-DD (это МСК date_key!)
 */
export async function accrueDailyEarnings({
  day,
  revshare = 0.7,
  freezeDays = 5,
} = {}) {
  if (!day) throw new Error("accrueDailyEarnings: day is required");

  // ✅ границы суток по ТЗ: 03:00 MSK -> 03:00 MSK
  const dayStartUtc = mskDayStartUtc(String(day));
  const nextDayUtc = addDays(dayStartUtc, 1);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ====== 1) Собираем агрегацию по placements из impressions ======
    // income_usd = SUM(revenue_usd) * revshare (net)
    const agg = await client.query(
      `
      WITH agg AS (
        SELECT
          p.publisher_id,
          i.placement_id,
          COUNT(*)::int AS imps,
          COALESCE(SUM(i.revenue_usd),0)::numeric AS gross_usd
        FROM impressions i
        JOIN placements p ON p.id = i.placement_id
        WHERE p.moderation_status='approved'
          AND i.is_fraud=false
          AND i.status IN ('impression','completed')
          AND i.created_at >= $1
          AND i.created_at <  $2
        GROUP BY 1,2
      )
      SELECT *
      FROM agg
      WHERE imps > 0
      `,
      [dayStartUtc.toISOString(), nextDayUtc.toISOString()]
    );

    // ====== 2) Апсерчим дневную таблицу placement_daily_stats (по ТЗ) ======
    // Храним net income (income_usd) и impressions.
    for (const r of agg.rows) {
      const publisherId = r.publisher_id;
      const placementId = r.placement_id;
      const imps = Number(r.imps) || 0;
      const grossUsd = toNumber(r.gross_usd);
      const netUsd = Number((grossUsd * revshare).toFixed(6));

      await client.query(
        `
        INSERT INTO placement_daily_stats
          (date_key, placement_id, publisher_id, impressions, income_usd, updated_at)
        VALUES
          ($1::date, $2, $3, $4, $5, now())
        ON CONFLICT (date_key, placement_id)
        DO UPDATE SET
          publisher_id = EXCLUDED.publisher_id,
          impressions  = EXCLUDED.impressions,
          income_usd   = EXCLUDED.income_usd,
          updated_at   = now()
        `,
        [day, placementId, publisherId, imps, netUsd]
      );
    }

    // ====== 3) Пишем ledger (твоя логика, но day/meta теперь по МСК) ======
    const q = await client.query(
      `
      WITH agg AS (
        SELECT
          p.publisher_id,
          i.placement_id,
          COUNT(*)::int AS imps,
          COALESCE(SUM(i.revenue_usd),0)::numeric AS gross_usd
        FROM impressions i
        JOIN placements p ON p.id = i.placement_id
        WHERE p.moderation_status='approved'
          AND i.is_fraud=false
          AND i.status IN ('impression','completed')
          AND i.created_at >= $1
          AND i.created_at <  $2
        GROUP BY 1,2
      ),
      ins AS (
        INSERT INTO publisher_ledger
          (publisher_id, placement_id, amount_usd, currency, entry_type, status, earned_at, available_at, ledger_key, meta)
        SELECT
          a.publisher_id,
          a.placement_id,
          ROUND(a.gross_usd * $3, 6) AS net_usd,
          'USD',
          'EARN_NET_FROZEN',
          'posted',
          $1::timestamptz AS earned_at,
          ($1::timestamptz + ($4 || ' days')::interval) AS available_at,
          ('earn:pub=' || a.publisher_id || ':pl=' || a.placement_id || ':day=' || $5 || ':net') AS ledger_key,
          jsonb_build_object(
            'day', $5,
            'impressions', a.imps,
            'gross_usd', a.gross_usd,
            'revshare', $3,
            'net_usd', ROUND(a.gross_usd * $3, 6),
            'cpm_gross', CASE WHEN a.imps>0 THEN ROUND((a.gross_usd/a.imps)*1000, 6) ELSE 0 END,
            'cpm_net',   CASE WHEN a.imps>0 THEN ROUND(((a.gross_usd*$3)/a.imps)*1000, 6) ELSE 0 END
          )
        FROM agg a
        WHERE a.imps > 0
        ON CONFLICT (ledger_key) DO NOTHING
        RETURNING publisher_id, amount_usd, available_at
      )
      SELECT
        COUNT(*)::int AS inserted,
        COALESCE(SUM(amount_usd),0)::numeric AS total_net
      FROM ins;
      `,
      [
        dayStartUtc.toISOString(),
        nextDayUtc.toISOString(),
        revshare,
        freezeDays,
        String(day),
      ]
    );

    const inserted = q.rows[0]?.inserted ?? 0;
    const totalNet = toNumber(q.rows[0]?.total_net);

    if (inserted > 0) {
      await client.query(
        `
        INSERT INTO publisher_balances (publisher_id)
        SELECT DISTINCT publisher_id FROM publisher_ledger
        ON CONFLICT (publisher_id) DO NOTHING;
        `
      );

      await client.query(
        `
        WITH addm AS (
          SELECT publisher_id, SUM(amount_usd)::numeric AS add_net
          FROM publisher_ledger
          WHERE entry_type='EARN_NET_FROZEN'
            AND meta->>'day' = $1
          GROUP BY publisher_id
        )
        UPDATE publisher_balances b
        SET frozen_usd = b.frozen_usd + addm.add_net,
            updated_at = now()
        FROM addm
        WHERE b.publisher_id = addm.publisher_id;
        `,
        [String(day)]
      );
    }

    await client.query("COMMIT");
    return { inserted, totalNet };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function unfreezeDueEarnings() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const due = await client.query(
      `
      SELECT id, publisher_id, amount_usd
      FROM publisher_ledger
      WHERE entry_type='EARN_NET_FROZEN'
        AND status='posted'
        AND available_at IS NOT NULL
        AND available_at <= now()
      FOR UPDATE SKIP LOCKED
      `
    );

    if (!due.rows.length) {
      await client.query("COMMIT");
      return { unfrozenPublishers: 0, unfrozenTotal: 0 };
    }

    const map = new Map();
    for (const r of due.rows) {
      const pid = r.publisher_id;
      const amt = toNumber(r.amount_usd);
      map.set(pid, (map.get(pid) || 0) + amt);
    }

    await client.query(
      `
      UPDATE publisher_ledger
      SET status='settled'
      WHERE id = ANY($1::bigint[])
      `,
      [due.rows.map((r) => r.id)]
    );

    for (const [publisherId, sumAmt] of map.entries()) {
      await client.query(
        `
        INSERT INTO publisher_ledger
          (publisher_id, amount_usd, currency, entry_type, status, earned_at, available_at, ledger_key, meta)
        VALUES
          ($1, $2, 'USD', 'UNFREEZE_NET', 'posted', now(), now(),
           ('unfreeze:pub=' || $1 || ':ts=' || extract(epoch from now())::bigint),
           jsonb_build_object('unfrozen_from_count', $3))
        `,
        [
          publisherId,
          sumAmt.toFixed(6),
          due.rows.filter((x) => x.publisher_id === publisherId).length,
        ]
      );

      await client.query(
        `
        INSERT INTO publisher_balances (publisher_id)
        VALUES ($1)
        ON CONFLICT (publisher_id) DO NOTHING;
        `,
        [publisherId]
      );

      await client.query(
        `
        UPDATE publisher_balances
        SET frozen_usd = GREATEST(0, frozen_usd - $2::numeric),
            available_usd = available_usd + $2::numeric,
            updated_at = now()
        WHERE publisher_id = $1
        `,
        [publisherId, sumAmt.toFixed(6)]
      );
    }

    await client.query("COMMIT");

    const unfrozenPublishers = map.size;
    const unfrozenTotal = [...map.values()].reduce((a, b) => a + b, 0);

    return { unfrozenPublishers, unfrozenTotal };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

