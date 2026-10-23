$ErrorActionPreference = 'Stop'

$node = Get-Command node.exe -ErrorAction Stop
$taskName = 'Dhan Desk Local Dashboard'
$action = New-ScheduledTaskAction -Execute $node.Source -Argument 'server.js' -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -DontStopOnIdleEnd

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Keep the loopback-only Dhan Desk dashboard available during this Windows user session and restart it after failures.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$port = $env:PORT
if (-not $port) { $port = '3000' }
Write-Host "Installed and started '$taskName'. The dashboard is available at http://localhost:$port/."
