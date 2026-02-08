import app from "./app/server.js";

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`🚀 TowerAds API running on port ${PORT}`);
});
