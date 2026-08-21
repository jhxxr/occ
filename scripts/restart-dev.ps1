$ErrorActionPreference = 'SilentlyContinue'

# Kill known stuck next dev PID and any next dev for this project
$targets = @(18700)
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match 'node|npm' -and $_.CommandLine -and (
    $_.CommandLine -match 'next dev' -or
    $_.CommandLine -match 'next-development' -or
    ($_.CommandLine -match 'next' -and $_.CommandLine -match 'Orbit Control Center')
  )
} | ForEach-Object {
  $targets += $_.ProcessId
  Write-Output ("FOUND pid={0} cmd={1}" -f $_.ProcessId, $_.CommandLine.Substring(0, [Math]::Min(160, $_.CommandLine.Length)))
}

$targets = $targets | Select-Object -Unique
foreach ($pid in $targets) {
  try {
    Stop-Process -Id $pid -Force
    Write-Output ("KILLED {0}" -f $pid)
  } catch {
    Write-Output ("SKIP {0}" -f $pid)
  }
}

Start-Sleep -Seconds 2

$ports = 3000, 3001, 3002
foreach ($p in $ports) {
  $conns = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
  if ($conns) {
    foreach ($c in $conns) {
      Write-Output ("STILL_LISTEN port={0} pid={1}" -f $p, $c.OwningProcess)
      try { Stop-Process -Id $c.OwningProcess -Force } catch {}
    }
  } else {
    Write-Output ("FREE port={0}" -f $p)
  }
}

Start-Sleep -Seconds 1
$left = Get-NetTCPConnection -LocalPort 3000,3001 -State Listen -ErrorAction SilentlyContinue
if ($left) {
  $left | ForEach-Object { Write-Output ("REMAIN port={0} pid={1}" -f $_.LocalPort, $_.OwningProcess) }
  exit 1
}

Write-Output 'READY_TO_START'
exit 0
