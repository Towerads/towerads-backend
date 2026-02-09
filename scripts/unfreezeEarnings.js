// towerads-backend/scripts/unfreezeEarnings.js
const { unfreezeDueEarnings } = require("../app/services/earningsService");

async function main() {
  const r = await unfreezeDueEarnings();
  console.log(JSON.stringify({ ok: true, ...r }, null, 2));
}

main().catch((e) => {
  console.error("unfreezeEarnings failed:", e);
  process.exit(1);
});
