$ErrorActionPreference = "Stop"
Set-Location "F:\newapi\Orbit Control Center"
Write-Host "[orbit] prisma db push..."
npx prisma db push
Write-Host "[orbit] prisma generate..."
npx prisma generate
Write-Host "===DONE==="
