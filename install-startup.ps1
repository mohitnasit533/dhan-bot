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

$taskXml = [xml](Export-ScheduledTask -TaskName $taskName)
$namespace = $taskXml.DocumentElement.NamespaceURI
$namespaceManager = New-Object System.Xml.XmlNamespaceManager($taskXml.NameTable)
$namespaceManager.AddNamespace('task', $namespace)
$triggers = $taskXml.SelectSingleNode('/task:Task/task:Triggers', $namespaceManager)
$subscription = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>'
$eventTrigger = $taskXml.CreateElement('EventTrigger', $namespace)
$enabled = $taskXml.CreateElement('Enabled', $namespace)
$enabled.InnerText = 'true'
$eventTrigger.AppendChild($enabled) | Out-Null
$subscriptionElement = $taskXml.CreateElement('Subscription', $namespace)
$subscriptionElement.InnerText = $subscription
$eventTrigger.AppendChild($subscriptionElement) | Out-Null
$triggers.AppendChild($eventTrigger) | Out-Null
Register-ScheduledTask -TaskName $taskName -Xml $taskXml.OuterXml -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$port = $env:PORT
if (-not $port) { $port = '3000' }
Write-Host "Installed and started '$taskName' for sign-in and resume. The dashboard is available at http://localhost:$port/."
