Option Explicit

Dim shell, fileSystem, runtimeDir, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

runtimeDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
scriptPath = runtimeDir & "\torplay-tray.ps1"
command = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Quote(scriptPath)

shell.CurrentDirectory = fileSystem.GetParentFolderName(runtimeDir)
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
