$base = "https://towerads-backend.onrender.com"

$email = "admin@towerads.io"
$pass  = "admin_123"

Write-Host "== TowerAds Admin Smoke Test =="

# Health
Write-Host "`n[1] GET /healthz"
$health = Invoke-RestMethod -Method GET -Uri "$base/healthz"
$health | ConvertTo-Json -Depth 10

# Login
Write-Host "`n[2] POST /admin/auth/login"
$login = Invoke-RestMethod -Method POST `
  -Uri "$base/admin/auth/login" `
  -ContentType "application/json" `
  -Body ("{""email"":""$email"",""password"":""$pass""}")

if (-not $login.token) {
  throw "Login failed: $($login | ConvertTo-Json -Depth 10)"
}

Write-Host "✅ Login OK"
$token = $login.token
$h = @{ Authorization = "Bearer $token" }

# Admin endpoints
Write-Host "`n[3] GET /admin/stats"
(Invoke-RestMethod -Method GET -Uri "$base/admin/stats" -Headers $h) | ConvertTo-Json -Depth 10

Write-Host "`n[4] GET /admin/creatives/pending"
(Invoke-RestMethod -Method GET -Uri "$base/admin/creatives/pending" -Headers $h) | ConvertTo-Json -Depth 10

Write-Host "`n[5] GET /admin/creatives?status=approved"
(Invoke-RestMethod -Method GET -Uri "$base/admin/creatives?status=approved" -Headers $h) | ConvertTo-Json -Depth 10

Write-Host "`n[6] GET /admin/pricing-plans"
(Invoke-RestMethod -Method GET -Uri "$base/admin/pricing-plans" -Headers $h) | ConvertTo-Json -Depth 10

Write-Host "`n[7] GET /admin/orders"
(Invoke-RestMethod -Method GET -Uri "$base/admin/orders" -Headers $h) | ConvertTo-Json -Depth 10

Write-Host "`n[8] GET /admin/mediation"
(Invoke-RestMethod -Method GET -Uri "$base/admin/mediation" -Headers $h) | ConvertTo-Json -Depth 10

Write-Host "`n[9] GET /admin/publishers"
(Invoke-RestMethod -Method GET -Uri "$base/admin/publishers" -Headers $h) | ConvertTo-Json -Depth 10

Write-Host "`n✅ Smoke test finished OK"
