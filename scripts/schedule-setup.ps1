# Margin Feishu Surface - Windows Task Scheduler setup
# Run this script once as Administrator to register the two scheduled tasks.
# After setup, tasks can be managed via Task Scheduler GUI or by re-running this script.

$NodeExe   = "C:\Program Files\nodejs\node.exe"
$WorkDir   = "D:\Echo"
$ScriptArg = "scripts/run-feishu-surface.js"
$BriefUrl  = "http://127.0.0.1:3200/feishu/send-brief"

# ── Task 1: Start feishu surface on logon ──────────────────────────────────────
$action1  = New-ScheduledTaskAction -Execute $NodeExe -Argument $ScriptArg -WorkingDirectory $WorkDir
$trigger1 = New-ScheduledTaskTrigger -AtLogon
$settings1 = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal1 = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest

$null = Register-ScheduledTask `
  -TaskName   "Margin\FeishuSurface" `
  -Action     $action1 `
  -Trigger    $trigger1 `
  -Settings   $settings1 `
  -Principal  $principal1 `
  -Description "Margin Feishu surface - start on logon" `
  -Force

Write-Host "[1/2] FeishuSurface task registered (starts at logon)"

# ── Task 2: Send Morning Brief daily at 08:00 ─────────────────────────────────
# Uses curl (built-in on Windows 10+) to POST to the local brief endpoint
$curlExe  = "C:\Windows\System32\curl.exe"
if (-not (Test-Path $curlExe)) { $curlExe = "curl" }

$action2  = New-ScheduledTaskAction -Execute $curlExe -Argument "-s -X POST $BriefUrl"
$trigger2 = New-ScheduledTaskTrigger -Daily -At "08:00"
$settings2 = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$principal2 = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest

$null = Register-ScheduledTask `
  -TaskName   "Margin\MorningBrief" `
  -Action     $action2 `
  -Trigger    $trigger2 `
  -Settings   $settings2 `
  -Principal  $principal2 `
  -Description "Margin Morning Brief - push to Feishu daily at 08:00" `
  -Force

Write-Host "[2/2] MorningBrief task registered (runs daily at 08:00)"
Write-Host ""
Write-Host "Done. View tasks in Task Scheduler under the 'Margin' folder."
Write-Host "To change the brief time: Task Scheduler > Margin > MorningBrief > Properties > Triggers"
