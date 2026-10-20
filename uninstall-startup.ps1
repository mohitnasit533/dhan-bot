$ErrorActionPreference = 'Stop'

$taskName = 'Dhan Desk Local Dashboard'
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "Scheduled task '$taskName' is not installed."
  exit 0
}

if ($task.State -eq 'Running') {
  Stop-ScheduledTask -TaskName $taskName
}
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Removed '$taskName'. Local credentials and trading history were not deleted."
