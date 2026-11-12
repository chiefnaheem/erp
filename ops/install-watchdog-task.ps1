# Register (or repair) the erp-sync watchdog scheduled task.
#
# Run once, from an ADMINISTRATOR PowerShell prompt:
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\ServerPC\Documents\erp\ops\install-watchdog-task.ps1
#
# ─── Why this exists ─────────────────────────────────────────────────────────
#
# On 2026-11-12 the machine rebooted at 01:34 (Windows Update: restart
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
#   triggers  = time only          no boot trigger, so nothing happens at
#                                  startup even in principle.
#   batteries = DisallowStartIfOnBatteries + StopIfGoingOnBatteries
#                                  on a laptop, refuses to start on battery and
#                                  kills a run the moment power is pulled.
#
# This script fixes all three.
#
# ─── Why raw XML and not New-ScheduledTaskTrigger ────────────────────────────
#
# Because the cmdlet cannot express "repeat every 5 minutes, for ever".
# -RepetitionDuration ([TimeSpan]::MaxValue) serialises to P99999999DT23H59M59S
# and Task Scheduler rejects it:
#
#   Register-ScheduledTask : The task XML contains a value which is incorrectly
#   formatted or out of range. (12,42):Duration:P99999999DT23H59M59S
#
# In the XML an OMITTED <Duration> is what means indefinitely, so the task is
# built directly and registered with -Xml. That also pins every other setting
# explicitly rather than inheriting a default.
#
# It deliberately runs as the CURRENT USER with LogonType S4U — "run whether the
# user is logged on or not", without storing a password. Not SYSTEM: pm2's home
# and its saved process list are per-user (C:\Users\<you>\.pm2), so a SYSTEM
# daemon would be a SECOND pm2 with its own list, and two workers sweeping one
# object delete each other's rows (see the note in ops/run-job.js).

$ErrorActionPreference = 'Stop'

$TaskName = 'erp-sync-watchdog'
$Script   = 'C:\Users\ServerPC\Documents\erp\ops\ensure-erp-sync.cmd'
$RunAs    = "$env:USERDOMAIN\$env:USERNAME"

if (-not (Test-Path $Script)) { throw "Cannot find $Script" }

# <Duration> is omitted on purpose: that is how the schema says "indefinitely".
# StartBoundary is a fixed past date so the repetition is already in effect.
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Keeps the erp-sync worker running: restores it after a reboot, a pm2 daemon death, a crash, or a wedged process. See ops/ensure-up.js.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
      <Delay>PT1M</Delay>
    </BootTrigger>
    <TimeTrigger>
      <StartBoundary>2026-01-01T00:01:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$RunAs</UserId>
      <LogonType>S4U</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$Script</Command>
    </Exec>
  </Actions>
</Task>
"@

Write-Host "Registering '$TaskName' to run as $RunAs ..." -ForegroundColor Cyan

try {
  Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force | Out-Null
} catch {
  Write-Host "S4U registration failed: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Retrying with a stored password (you will be prompted)..." -ForegroundColor Yellow
  # Some domain policies refuse S4U. Password logon is the fallback: same user,
  # same pm2 home, still runs with nobody logged on.
  $cred = Get-Credential -UserName $RunAs -Message "Password for $RunAs (stored by Task Scheduler)"
  $xmlPwd = $xml -replace '<LogonType>S4U</LogonType>', '<LogonType>Password</LogonType>'
  Register-ScheduledTask -TaskName $TaskName -Xml $xmlPwd -Force `
      -User $RunAs -Password $cred.GetNetworkCredential().Password | Out-Null
}

Write-Host "Registered." -ForegroundColor Green

$t = Get-ScheduledTask -TaskName $TaskName
$i = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ("  runs as      : {0}  (LogonType {1})" -f $t.Principal.UserId, $t.Principal.LogonType)
Write-Host ("  triggers     : {0}" -f (($t.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ', '))
Write-Host ("  repeat every : {0}" -f ($t.Triggers | Where-Object { $_.Repetition.Interval } | ForEach-Object { $_.Repetition.Interval }))
Write-Host ("  on batteries : may start={0}  stops={1}" -f `
    (-not $t.Settings.DisallowStartIfOnBatteries), $t.Settings.StopIfGoingOnBatteries)
Write-Host ("  next run     : {0}" -f $i.NextRunTime)

Write-Host ""
Write-Host "Prove it works now, without waiting for a reboot:" -ForegroundColor Cyan
Write-Host "  pm2 kill"
Write-Host "  Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Start-Sleep 45; pm2 list        # erp-sync should be back online"
Write-Host ""
Write-Host "And after the next restart:" -ForegroundColor Cyan
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName' | Select LastRunTime, LastTaskResult"
Write-Host "  type C:\Users\ServerPC\Documents\erp\logs\ensure-up.log"
