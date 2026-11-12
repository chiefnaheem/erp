# Register (or repair) the erp-sync watchdog scheduled task.
#
# Run once, from an ADMINISTRATOR PowerShell prompt:
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\ServerPC\Documents\erp\ops\install-watchdog-task.ps1
#
# ─── Why this exists ─────────────────────────────────────────────────────────
#
# On 2026-11-12 the machine rebooted at 01:34 (Windows Update: three restart
# transitions logged at 01:31, 01:32 and 01:34) and the sync did not come back
# until 10:12, when somebody logged in. Eight and a half hours with no data, and
# the ERP gateway log shows the silence exactly: last request 01:30, next 10:21.
#
# Nothing was wrong with the worker. The task that keeps it alive was registered
# with three settings that each stop it dead after an unattended reboot:
#
#   LogonType = Interactive        only runs while someone is logged ON. After a
#                                  reboot the machine sits at the sign-in screen
#                                  and the task never fires.
#   triggers  = time only          no AtStartup trigger, so nothing happens at
#                                  boot even in principle.
#   batteries = DisallowStartIfOnBatteries + StopIfGoingOnBatteries
#                                  on a laptop, refuses to start on battery and
#                                  kills a run the moment power is pulled.
#
# This script fixes all three:
#
#   * an AtStartup trigger (60s delay so the network stack is up), PLUS the
#     5-minute repeat that catches a crash between boots;
#   * LogonType S4U — "run whether the user is logged on or not" WITHOUT storing
#     a password. The task runs as ServerPC, so it uses the same pm2 home
#     (C:\Users\ServerPC\.pm2) and the same saved process list. Running it as
#     SYSTEM instead would start a SECOND pm2 daemon with its own process list,
#     and two workers sweeping one object delete each other's rows — see the
#     note in ops/run-job.js;
#   * battery restrictions off, and StartWhenAvailable so a missed run is taken
#     as soon as the machine is back.
#
# MultipleInstances=IgnoreNew means a slow run is never doubled up.

$ErrorActionPreference = 'Stop'

$TaskName = 'erp-sync-watchdog'
$Script   = 'C:\Users\ServerPC\Documents\erp\ops\ensure-erp-sync.cmd'
$RunAs    = 'ServerPC'

if (-not (Test-Path $Script)) { throw "Cannot find $Script" }

$action = New-ScheduledTaskAction -Execute $Script

# At boot, after a short delay for the network.
$atStartup = New-ScheduledTaskTrigger -AtStartup
$atStartup.Delay = 'PT60S'

# And every five minutes thereafter, for crashes between boots.
$everyFive = New-ScheduledTaskTrigger -Once -At (Get-Date).Date.AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# S4U: runs without an interactive session and without a stored password.
$principal = New-ScheduledTaskPrincipal -UserId $RunAs -LogonType S4U -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName $TaskName -Action $action `
    -Trigger @($atStartup, $everyFive) -Principal $principal -Settings $settings -Force | Out-Null

Write-Host "Registered '$TaskName'." -ForegroundColor Green

$t = Get-ScheduledTask -TaskName $TaskName
$i = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ("  runs as      : {0}  (LogonType {1})" -f $t.Principal.UserId, $t.Principal.LogonType)
Write-Host ("  triggers     : {0}" -f (($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '))
Write-Host ("  on batteries : start={0} stop={1}" -f `
    (-not $t.Settings.DisallowStartIfOnBatteries), $t.Settings.StopIfGoingOnBatteries)
Write-Host ("  next run     : {0}" -f $i.NextRunTime)
Write-Host ""
Write-Host "Verify after the next reboot with:" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName' | Select LastRunTime,LastTaskResult"
Write-Host "  type C:\Users\ServerPC\Documents\erp\logs\ensure-up.log"
