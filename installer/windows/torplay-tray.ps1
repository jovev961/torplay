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
$trayPidPath = Join-Path $stateDir "tray.pid"
$logPath = Join-Path $dataDir "logs\torplay.log"
$nodePath = Join-Path $runtimeDir "node.exe"
$controlPath = Join-Path $runtimeDir "windows-control.mjs"
$trayLauncherPath = Join-Path $runtimeDir "torplay-tray.vbs"
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
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class TorPlayNativeIcon {
  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  public static extern bool DestroyIcon(IntPtr handle);
}
"@

function New-TorPlayIcon {
  $bitmap = [Drawing.Bitmap]::new(32, 32)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $background = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(111, 66, 193))
  $border = [Drawing.Pen]::new([Drawing.Color]::FromArgb(125, 238, 255), 2)
  try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.Color]::Transparent)
    $graphics.FillEllipse($background, 1, 1, 30, 30)
    $graphics.DrawEllipse($border, 3, 3, 26, 26)
    $points = [Drawing.PointF[]]@(
      [Drawing.PointF]::new(12, 9),
      [Drawing.PointF]::new(12, 23),
      [Drawing.PointF]::new(23, 16)
    )
    $graphics.FillPolygon([Drawing.Brushes]::White, $points)
    $handle = $bitmap.GetHicon()
    try {
      return ([Drawing.Icon]::FromHandle($handle)).Clone()
    } finally {
      [TorPlayNativeIcon]::DestroyIcon($handle) | Out-Null
    }
  } finally {
    $border.Dispose()
    $background.Dispose()
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

function Test-TorPlayRunning {
  try {
    if (-not (Test-Path -LiteralPath $statusPath -PathType Leaf)) {
      return $false
    }
    $status = Get-Content -LiteralPath $statusPath -Raw | ConvertFrom-Json
    $runtimePid = [int]$status.pid
    if ($runtimePid -le 0) {
      return $false
    }
    Get-Process -Id $runtimePid -ErrorAction Stop | Out-Null
    return $true
  } catch {
    return $false
  }
}

function Invoke-TorPlayControl([string]$Command) {
  if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw "The TorPlay Node runtime is missing."
  }
  if (-not (Test-Path -LiteralPath $controlPath -PathType Leaf)) {
    throw "The TorPlay control script is missing."
  }
  $arguments = '"{0}" {1}' -f $controlPath, $Command
  $process = Start-Process -FilePath $nodePath -ArgumentList $arguments -WorkingDirectory $installDir -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "TorPlay could not $Command. Open Logs for details."
  }
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

function Update-TrayStatus {
  $running = Test-TorPlayRunning
  $statusItem.Text = if ($running) { "Status: Running" } else { "Status: Stopped" }
  $runtimeItem.Text = if ($running) { "Restart TorPlay" } else { "Start TorPlay" }
  $stopItem.Enabled = $running
  $startupItem.Checked = Test-StartWithWindows
  $notifyIcon.Text = if ($running) { "TorPlay - Running" } else { "TorPlay - Stopped" }
}

$menu.add_Opening({ Update-TrayStatus })
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
  $command = if (Test-TorPlayRunning) { "restart" } else { "start" }
  $statusItem.Text = "Status: Working..."
  [Windows.Forms.Application]::DoEvents()
  try {
    Invoke-TorPlayControl $command
  } catch {
    Show-TrayError $_.Exception.Message
  }
  Update-TrayStatus
})
$stopItem.add_Click({
  $statusItem.Text = "Status: Stopping..."
  [Windows.Forms.Application]::DoEvents()
  try {
    Invoke-TorPlayControl "stop"
  } catch {
    Show-TrayError $_.Exception.Message
  }
  Update-TrayStatus
})
$startupItem.add_Click({
  try {
    Set-StartWithWindows (-not (Test-StartWithWindows))
  } catch {
    Show-TrayError "The login startup setting could not be changed."
  }
  Update-TrayStatus
})
$exitItem.add_Click({ [Windows.Forms.Application]::Exit() })

try {
  if (-not (Test-TorPlayRunning)) {
    try {
      Invoke-TorPlayControl "start"
    } catch {
      Show-TrayError $_.Exception.Message
    }
  }
  Update-TrayStatus
  [Windows.Forms.Application]::Run()
} finally {
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  $menu.Dispose()
  $icon.Dispose()
  Remove-Item -LiteralPath $trayPidPath -Force -ErrorAction SilentlyContinue
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
