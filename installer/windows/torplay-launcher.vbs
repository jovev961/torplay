Option Explicit

Dim shell, fileSystem, runtimeDir, appDir, verb, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

runtimeDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
appDir = fileSystem.GetParentFolderName(runtimeDir)
verb = "launch"
If WScript.Arguments.Count > 0 Then verb = LCase(WScript.Arguments(0))

If verb = "start" Then
  command = Quote(runtimeDir & "\node.exe") & " " & Quote(runtimeDir & "\windows-runner.mjs")
  shell.CurrentDirectory = appDir
  shell.Run command, 0, False
  WScript.Quit 0
End If

shell.CurrentDirectory = appDir
command = Quote(runtimeDir & "\node.exe") & " " & _
  Quote(runtimeDir & "\windows-control.mjs") & " start"
exitCode = shell.Run(command, 0, True)

' Restore the tray after Exit or a tray crash. Its mutex prevents duplicates.
shell.Run Quote(runtimeDir & "\torplay-tray.vbs"), 0, False

If exitCode = 0 Then
  shell.Run "explorer.exe " & Quote("http://localhost"), 1, False
Else
  shell.Popup "TorPlay could not start. Check " & _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\TorPlay\logs\torplay.log") & _
    " for details.", 0, "TorPlay", 16
End If

WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
