$base = "https://towerads-backend.onrender.com"

$login = Invoke-RestMethod -Method POST `
  -Uri "$base/admin/auth/login" `
  -ContentType "application/json" `
  -Body '{"email":"admin@towerads.io","password":"admin_123"}'

$h = @{ Authorization = "Bearer $($login.token)" }

Write-Host "== /admin/stats =="
Invoke-RestMethod -Method GET -Uri "$base/admin/stats" -Headers $h | ConvertTo-Json -Depth 10

Write-Host "== /admin/providers/availability =="
Invoke-RestMethod -Method GET -Uri "$base/admin/providers/availability?period=today" -Headers $h | ConvertTo-Json -Depth 10
