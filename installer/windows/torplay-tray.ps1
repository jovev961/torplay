param(
  [switch]$StopExisting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$runtimeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$trayScriptPath = $MyInvocation.MyCommand.Path
$installDir = Split-Path -Parent $runtimeDir
$dataDir = Join-Path $env:LOCALAPPDATA "TorPlay"
$stateDir = Join-Path $dataDir "runtime"
$statusPath = Join-Path $stateDir "status.json"
$lockPath = Join-Path $stateDir "home.lock"
$trayPidPath = Join-Path $stateDir "tray.pid"
$logPath = Join-Path $dataDir "logs\torplay.log"
$nodePath = Join-Path $runtimeDir "node.exe"
$controlPath = Join-Path $runtimeDir "windows-control.mjs"
$trayLauncherPath = Join-Path $runtimeDir "torplay-tray.vbs"
$iconPath = Join-Path $runtimeDir "torplay.ico"
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "TorPlay"
$wscriptPath = Join-Path $env:WINDIR "System32\wscript.exe"
$startupCommand = '"{0}" "{1}"' -f $wscriptPath, $trayLauncherPath

function Stop-ExistingTray {
  if (-not (Test-Path -LiteralPath $trayPidPath -PathType Leaf)) {
    return
  }

  try {
    $trayPid = 0
    $pidText = (Get-Content -LiteralPath $trayPidPath -Raw).Trim()
    if (-not [int]::TryParse($pidText, [ref]$trayPid) -or $trayPid -le 0) {
      return
    }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $trayPid" -ErrorAction Stop
    if ($process.CommandLine -and $process.CommandLine.IndexOf(
      $trayScriptPath,
      [StringComparison]::OrdinalIgnoreCase
    ) -ge 0) {
      Stop-Process -Id $trayPid -Force -ErrorAction Stop
    }
  } catch {
    # The tray is already gone or cannot be identified safely.
  } finally {
    Remove-Item -LiteralPath $trayPidPath -Force -ErrorAction SilentlyContinue
  }
}

if ($StopExisting) {
  Stop-ExistingTray
  exit 0
}

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, "Local\TorPlayTray", [ref]$createdNew)
if (-not $createdNew) {
  $mutex.Dispose()
  exit 0
}

New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
[IO.File]::WriteAllText($trayPidPath, [string]$PID, [Text.UTF8Encoding]::new($false))

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

function New-TorPlayIcon {
  if (-not (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
    throw "The TorPlay application icon is missing."
  }
  $sourceIcon = [Drawing.Icon]::new($iconPath, 32, 32)
  try {
    return $sourceIcon.Clone()
  } finally {
    $sourceIcon.Dispose()
  }
}

function Get-TorPlayRuntimeStatus {
  try {
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
      return $null
    }
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $runtimePid = [int]$status.pid
    if ($runtimePid -le 0 -or [string]$status.state -eq "stopped") {
      return $null
    }
    $instanceProperty = $status.PSObject.Properties["instanceId"]
    if ($null -ne $instanceProperty -and -not [string]::IsNullOrWhiteSpace([string]$instanceProperty.Value)) {
      if (-not (Test-Path -LiteralPath $lockPath -PathType Leaf)) {
        return $null
      }
      $lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
      if ([string]$lock.token -ne [string]$instanceProperty.Value -or [int]$lock.pid -ne $runtimePid) {
        return $null
      }
      $runnerProperty = $status.PSObject.Properties["runnerPid"]
      if ($null -eq $runnerProperty -or [int]$lock.runnerPid -ne [int]$runnerProperty.Value) {
        return $null
      }
      Get-Process -Id ([int]$runnerProperty.Value) -ErrorAction Stop | Out-Null
    }
    Get-Process -Id $runtimePid -ErrorAction Stop | Out-Null
    return $status
  } catch {
    return $null
  }
}

function Test-TorPlayRunning {
  return $null -ne (Get-TorPlayRuntimeStatus)
}

function Test-StartWithWindows {
  try {
    $current = (Get-ItemProperty -Path $runKeyPath -Name $runValueName -ErrorAction Stop).$runValueName
    return $current -eq $startupCommand
  } catch {
    return $false
  }
}

function Set-StartWithWindows([bool]$Enabled) {
  if ($Enabled) {
    New-Item -Path $runKeyPath -Force | Out-Null
    Set-ItemProperty -Path $runKeyPath -Name $runValueName -Value $startupCommand -Type String
  } else {
    Remove-ItemProperty -Path $runKeyPath -Name $runValueName -ErrorAction SilentlyContinue
  }
}

$icon = New-TorPlayIcon
$menu = [Windows.Forms.ContextMenuStrip]::new()
$titleItem = $menu.Items.Add("TorPlay")
$titleItem.Enabled = $false
$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new()) | Out-Null
$statusItem = $menu.Items.Add("Status: Checking...")
$statusItem.Enabled = $false
$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new()) | Out-Null
$openItem = $menu.Items.Add("Open TorPlay")
$logsItem = $menu.Items.Add("Open Logs")
$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new()) | Out-Null
$runtimeItem = $menu.Items.Add("Start TorPlay")
$stopItem = $menu.Items.Add("Stop TorPlay")
$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new()) | Out-Null
$startupItem = $menu.Items.Add("Start with Windows")
$startupItem.CheckOnClick = $false
$menu.Items.Add([Windows.Forms.ToolStripSeparator]::new()) | Out-Null
$exitItem = $menu.Items.Add("Exit")

$script:controlProcess = $null
$script:controlCommand = $null
$script:controlDeadline = [DateTime]::MinValue
$script:exitRequested = $false
$script:exitStarted = $false
$controlTimer = [Windows.Forms.Timer]::new()
$controlTimer.Interval = 250

$notifyIcon = [Windows.Forms.NotifyIcon]::new()
$notifyIcon.Icon = $icon
$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.Text = "TorPlay"
$notifyIcon.Visible = $true

function Show-TrayError([string]$Message) {
  $notifyIcon.BalloonTipTitle = "TorPlay"
  $notifyIcon.BalloonTipText = $Message
  $notifyIcon.BalloonTipIcon = [Windows.Forms.ToolTipIcon]::Error
  $notifyIcon.ShowBalloonTip(5000)
}

function Set-ControlBusy([string]$Command) {
  $runtimeItem.Enabled = $false
  $stopItem.Enabled = $false
  $statusItem.Text = switch ($Command) {
    "start" { "Status: Starting..." }
    "restart" { "Status: Restarting..." }
    default { "Status: Stopping..." }
  }
}

function Start-TorPlayControl([string]$Command) {
  if ($null -ne $script:controlProcess) {
    return $false
  }
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "The TorPlay Node runtime is missing."
  }
  if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) {
    throw "The TorPlay control script is missing."
  }
  $arguments = '"{0}" {1}' -f $controlPath, $Command
  $script:controlProcess = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $installDir -WindowStyle Hidden -PassThru
  $script:controlCommand = $Command
  $timeoutSeconds = if ($Command -eq "stop") { 20 } else { 75 }
  $script:controlDeadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  Set-ControlBusy $Command
  $controlTimer.Start()
  return $true
}

function Clear-TorPlayControl {
  $controlTimer.Stop()
  if ($null -ne $script:controlProcess) {
    $script:controlProcess.Dispose()
  }
  $script:controlProcess = $null
  $script:controlCommand = $null
  $script:controlDeadline = [DateTime]::MinValue
}

function Complete-TorPlayControl([int]$ExitCode, [bool]$TimedOut) {
  $completedCommand = $script:controlCommand
  Clear-TorPlayControl
  if ($TimedOut) {
    Show-TrayError "TorPlay could not $completedCommand before the operation timed out. Open Logs for details."
  } elseif ($ExitCode -ne 0) {
    Show-TrayError "TorPlay could not $completedCommand. Open Logs for details."
  }

  if ($script:exitRequested) {
    if ($completedCommand -eq "stop") {
      [Windows.Forms.Application]::Exit()
      return
    }
    try {
      Start-TorPlayControl "stop" | Out-Null
    } catch {
      [Windows.Forms.Application]::Exit()
    }
    return
  }
  Update-TrayStatus
}

$controlTimer.add_Tick({
  if ($null -eq $script:controlProcess) {
    $controlTimer.Stop()
    return
  }
  if ($script:controlProcess.HasExited) {
    Complete-TorPlayControl $script:controlProcess.ExitCode $false
    return
  }
  if ([DateTime]::UtcNow -ge $script:controlDeadline) {
    try {
      $script:controlProcess.Kill()
      $script:controlProcess.WaitForExit(2000) | Out-Null
    } catch {
      # The helper may have exited between the timeout check and termination.
    }
    Complete-TorPlayControl -1 $true
  }
})

function Update-TrayStatus {
  $runtimeStatus = Get-TorPlayRuntimeStatus
  $running = $null -ne $runtimeStatus
  $state = if ($running) { [string]$runtimeStatus.state } else { "stopped" }
  if ($state -eq "error") {
    $statusItem.Text = "Status: Error"
    $runtimeItem.Text = "Retry TorPlay"
  } elseif ($state -eq "recovering") {
    $statusItem.Text = "Status: Recovering..."
    $runtimeItem.Text = "Restart TorPlay"
  } elseif ($state -eq "starting") {
    $statusItem.Text = "Status: Starting..."
    $runtimeItem.Text = "Restart TorPlay"
  } elseif ($state -eq "stopping") {
    $statusItem.Text = "Status: Stopping..."
    $runtimeItem.Text = "Start TorPlay"
  } elseif ($running) {
    $statusItem.Text = "Status: Running"
    $runtimeItem.Text = "Restart TorPlay"
  } else {
    $statusItem.Text = "Status: Stopped"
    $runtimeItem.Text = "Start TorPlay"
  }
  $runtimeItem.Enabled = $true
  $stopItem.Enabled = $running
  $startupItem.Checked = Test-StartWithWindows
  $notifyIcon.Text = if ($state -eq "error") {
    "TorPlay - Error"
  } elseif ($state -eq "recovering") {
    "TorPlay - Recovering"
  } elseif ($running) {
    "TorPlay - Running"
  } else {
    "TorPlay - Stopped"
  }
}

function Stop-TorPlayAndExit {
  if ($script:exitStarted) {
    return
  }
  $script:exitStarted = $true
  $script:exitRequested = $true
  $statusItem.Text = "Status: Exiting..."
  $runtimeItem.Enabled = $false
  $stopItem.Enabled = $false
  if ($null -ne $script:controlProcess) {
    return
  }
  try {
    Start-TorPlayControl "stop" | Out-Null
  } catch {
    Show-TrayError $_.Exception.Message
    [Windows.Forms.Application]::Exit()
  }
}

$menu.add_Opening({ if ($null -eq $script:controlProcess) { Update-TrayStatus } })
$openItem.add_Click({ Start-Process "http://localhost" })
$notifyIcon.add_DoubleClick({ Start-Process "http://localhost" })
$logsItem.add_Click({
  try {
    $logDirectory = Split-Path -Parent $logPath
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    if (Test-Path -LiteralPath $logPath -PathType Leaf) {
      Start-Process -FilePath $logPath
    } else {
      Start-Process "explorer.exe" -ArgumentList ('"{0}"' -f $logDirectory)
    }
  } catch {
    Show-TrayError $_.Exception.Message
  }
})
$runtimeItem.add_Click({
  if ($null -ne $script:controlProcess) { return }
  $command = if (Test-TorPlayRunning) { "restart" } else { "start" }
  try {
    Start-TorPlayControl $command | Out-Null
  } catch {
    Show-TrayError $_.Exception.Message
    Update-TrayStatus
  }
})
$stopItem.add_Click({
  if ($null -ne $script:controlProcess) { return }
  try {
    Start-TorPlayControl "stop" | Out-Null
  } catch {
    Show-TrayError $_.Exception.Message
    Update-TrayStatus
  }
})
$startupItem.add_Click({
  try {
    Set-StartWithWindows (-not (Test-StartWithWindows))
  } catch {
    Show-TrayError "The login startup setting could not be changed."
  }
  Update-TrayStatus
})
$exitItem.add_Click({ Stop-TorPlayAndExit })
$sessionEndingHandler = [Microsoft.Win32.SessionEndingEventHandler]{
  param($sender, $eventArgs)
  $script:exitRequested = $true
  if ($null -eq $script:controlProcess) {
    try {
      Start-TorPlayControl "stop" | Out-Null
    } catch {
      # Windows is ending the session; do not block shutdown with UI.
    }
  }
}
[Microsoft.Win32.SystemEvents]::add_SessionEnding($sessionEndingHandler)

try {
  if (-not (Test-TorPlayRunning)) {
    try {
      Start-TorPlayControl "start" | Out-Null
    } catch {
      Show-TrayError $_.Exception.Message
    }
  }
  if ($null -eq $script:controlProcess) {
    Update-TrayStatus
  }
  [Windows.Forms.Application]::Run()
} finally {
  $controlTimer.Stop()
  $controlTimer.Dispose()
  [Microsoft.Win32.SystemEvents]::remove_SessionEnding($sessionEndingHandler)
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $menu.Dispose()
  $icon.Dispose()
  Remove-Item -LiteralPath $trayPidPath -Force -ErrorAction SilentlyContinue
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
