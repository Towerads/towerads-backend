// towerads-backend/app/services/earningsService.js
const db = require("../config/db");

function toNumber(v) {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dayKey(dateObj) {
  // YYYY-MM-DD (UTC)
  const d = new Date(dateObj);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Начисление net (frozen) по показам за конкретный день (UTC).
 * Идемпотентность: ledger_key = earn:pub=<id>:pl=<placement>:day=<YYYY-MM-DD>:net
 *
 * @param {Object} opts
 * @param {string|Date} opts.day - день начисления (UTC). Например "2026-02-08" или Date.
 * @param {number} opts.revshare - доля паблишера (0..1)
 * @param {number} opts.freezeDays - дни заморозки (например 5)
 * @returns {Promise<{inserted:number, totalNet:number}>}
 */
async function accrueDailyEarnings({ day, revshare = 0.7, freezeDays = 5 } = {}) {
  if (!day) throw new Error("accrueDailyEarnings: day is required");

  // Делаем границы дня в UTC: [day 00:00, next day 00:00)
  const dayStart = new Date(`${typeof day === "string" ? day : dayKey(day)}T00:00:00.000Z`);
  const nextDay = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Находим агрегаты по approved placements
    // Считаем только impression/completed, is_fraud=false
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
      [dayStart.toISOString(), nextDay.toISOString(), revshare, freezeDays, dayKey(dayStart)]
    );

    const inserted = agg.rows[0]?.inserted ?? 0;
    const totalNet = toNumber(agg.rows[0]?.total_net);

    // Обновим frozen_usd в balances на сумму новых начислений (только если что-то вставили)
    if (inserted > 0) {
      await client.query(
        `
        INSERT INTO publisher_balances (publisher_id)
        SELECT DISTINCT publisher_id FROM publisher_ledger
        ON CONFLICT (publisher_id) DO NOTHING;
        `
      );

      // суммируем именно за этот dayKey, чтобы не пересчитывать лишнее
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
        [dayKey(dayStart)]
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

/**
 * Разморозка всех due начислений:
 * - находит EARN_NET_FROZEN, где available_at <= now() и status='posted'
 * - переводит их в settled
 * - добавляет одну запись UNFREEZE_NET на сумму (по publisher_id)
 * - обновляет publisher_balances: frozen -= sum, available += sum
 *
 * @returns {Promise<{unfrozenPublishers:number, unfrozenTotal:number}>}
 */
async function unfreezeDueEarnings() {
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Берём всё, что созрело, блокируем строки, чтобы параллельный ран не трогал их
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

    // Группируем по publisher
    const map = new Map();
    for (const r of due.rows) {
      const pid = r.publisher_id;
      const amt = toNumber(r.amount_usd);
      map.set(pid, (map.get(pid) || 0) + amt);
    }

    // Помечаем исходные как settled
    await client.query(
      `
      UPDATE publisher_ledger
      SET status='settled'
      WHERE id = ANY($1::bigint[])
      `,
      [due.rows.map((r) => r.id)]
    );

    // Вставляем UNFREEZE_NET (идемпотентность по времени не нужна, т.к. due уже settled)
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
        [publisherId, sumAmt.toFixed(6), due.rows.filter((x) => x.publisher_id === publisherId).length]
      );

      // Обновляем balances
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

module.exports = {
  accrueDailyEarnings,
  unfreezeDueEarnings,
};
