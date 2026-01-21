// app/services/decision-service.js
// Решает какой провайдер показывать по mediation_config (проценты)

export async function decideProvider(pool, placement_id) {
  const r = await pool.query(
    `
    SELECT network, traffic_percentage
    FROM mediation_config
    WHERE placement_id = $1
      AND status = 'active'
    ORDER BY priority DESC
    `,
    [placement_id]
  );

  // Если конфигов нет — всегда tower
  if (!r.rowCount) return { provider: "tower" };

  const roll = Math.random() * 100;
  let acc = 0;

  for (const row of r.rows) {
    acc += Number(row.traffic_percentage);
    if (roll <= acc) return { provider: row.network };
  }

  // Если сумма процентов < 100 — остаток уходит в tower
  return { provider: "tower" };
}
