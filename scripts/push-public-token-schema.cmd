@echo off
cd /d "F:\newapi\Orbit Control Center"
echo [orbit] start > "F:\newapi\Orbit Control Center\scripts\push-schema.log"
call npx prisma db push >> "F:\newapi\Orbit Control Center\scripts\push-schema.log" 2>&1
echo [orbit] db push exit=%ERRORLEVEL% >> "F:\newapi\Orbit Control Center\scripts\push-schema.log"
call npx prisma generate >> "F:\newapi\Orbit Control Center\scripts\push-schema.log" 2>&1
echo [orbit] generate exit=%ERRORLEVEL% >> "F:\newapi\Orbit Control Center\scripts\push-schema.log"
echo ===DONE=== >> "F:\newapi\Orbit Control Center\scripts\push-schema.log"
