Option Explicit

Dim shell, fileSystem, runtimeDir, appDir, verb, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

runtimeDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
appDir = fileSystem.GetParentFolderName(runtimeDir)
verb = "start"
If WScript.Arguments.Count > 0 Then verb = LCase(WScript.Arguments(0))

If verb = "start" Then
  command = Quote(runtimeDir & "\node.exe") & " " & Quote(runtimeDir & "\windows-runner.mjs")
Else
  command = Quote(runtimeDir & "\node.exe") & " " & Quote(runtimeDir & "\windows-control.mjs") & " " & verb
End If

shell.CurrentDirectory = appDir
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
