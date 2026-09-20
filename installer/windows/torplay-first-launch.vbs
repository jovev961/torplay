Option Explicit

Dim shell, fileSystem, runtimeDir, appDir, controlCommand, exitCode
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

runtimeDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
appDir = fileSystem.GetParentFolderName(runtimeDir)
controlCommand = Quote(runtimeDir & "\node.exe") & " " & _
  Quote(runtimeDir & "\windows-control.mjs") & " start"

shell.CurrentDirectory = appDir
exitCode = shell.Run(controlCommand, 0, True)

' Keep the tray available even when startup failed so the user can retry or open logs.
shell.Run Quote(runtimeDir & "\torplay-tray.vbs"), 0, False

If exitCode = 0 Then
  shell.Run "explorer.exe " & Quote("http://localhost/setup"), 1, False
End If

WScript.Quit exitCode

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
