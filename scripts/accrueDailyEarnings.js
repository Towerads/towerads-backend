// towerads-backend/scripts/accrueDailyEarnings.js
import { accrueDailyEarnings } from "../app/services/earningsService.js";

const REVSHARE = process.env.REVSHARE ? Number(process.env.REVSHARE) : 0.7;
const FREEZE_DAYS = process.env.FREEZE_DAYS ? Number(process.env.FREEZE_DAYS) : 5;

// По умолчанию начисляем за "вчера" (UTC)
// ✅ Это и есть "день по МСК с границей 03:00", потому что 03:00 МСК == 00:00 UTC
function yesterdayUTCKey() {
  const now = new Date();
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  y.setUTCDate(y.getUTCDate() - 1);
  const yyyy = y.getUTCFullYear();
  const mm = String(y.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(y.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function main() {
  const day = process.env.DAY || yesterdayUTCKey();

  const r = await accrueDailyEarnings({
    day,
    revshare: REVSHARE,
    freezeDays: FREEZE_DAYS,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        day,
        revshare: REVSHARE,
        freeze_days: FREEZE_DAYS,
        inserted: r.inserted,
        total_net: r.totalNet,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error("accrueDailyEarnings failed:", e);
  process.exit(1);
});
