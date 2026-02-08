$base = "https://towerads-backend.onrender.com"
$tg = "123456"   # любой TG user id

Write-Host "== TowerAds Advertiser Smoke Test =="

Write-Host "`n[1] GET /healthz"
(Invoke-RestMethod -Method GET -Uri "$base/healthz") | ConvertTo-Json -Depth 10

Write-Host "`n[2] GET /me"
(Invoke-RestMethod -Method GET -Uri "$base/me" -Headers @{ "X-TG-USER-ID" = $tg }) | ConvertTo-Json -Depth 10

Write-Host "`n[3] GET /advertiser/me"
(Invoke-RestMethod -Method GET -Uri "$base/advertiser/me" -Headers @{ "X-TG-USER-ID" = $tg }) | ConvertTo-Json -Depth 10

Write-Host "`n[4] POST /advertiser/creatives (create draft)"
$body = @{
  title = "Smoke creative"
  type = "video"
  media_url = "https://example.com/video.mp4"
  click_url = "https://example.com"
  duration = 15
} | ConvertTo-Json

$cr = Invoke-RestMethod -Method POST -Uri "$base/advertiser/creatives" `
  -Headers @{ "Content-Type"="application/json"; "X-TG-USER-ID"=$tg } `
  -Body $body

$cr | ConvertTo-Json -Depth 10

$cid = $cr.creative.id
if (-not $cid) { throw "No creative id returned" }

Write-Host "`n[5] GET /advertiser/creatives (list)"
(Invoke-RestMethod -Method GET -Uri "$base/advertiser/creatives" -Headers @{ "X-TG-USER-ID" = $tg }) | ConvertTo-Json -Depth 10

Write-Host "`n[6] POST /advertiser/creatives/{id}/submit"
(Invoke-RestMethod -Method POST -Uri "$base/advertiser/creatives/$cid/submit" -Headers @{ "X-TG-USER-ID" = $tg }) | ConvertTo-Json -Depth 10

Write-Host "`n[7] POST /advertiser/campaigns"
$campBody = @{
  name = "Smoke campaign"
  budget_usd = 10
} | ConvertTo-Json

(Invoke-RestMethod -Method POST -Uri "$base/advertiser/campaigns" `
  -Headers @{ "Content-Type"="application/json"; "X-TG-USER-ID"=$tg } `
  -Body $campBody) | ConvertTo-Json -Depth 10

Write-Host "`nOK: advertiser smoke finished"
