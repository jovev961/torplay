#ifndef StageDir
  #error StageDir must be supplied by the release script
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the release script
#endif
#ifndef AppVersion
  #error AppVersion must be supplied by the release script
#endif
#ifndef VersionInfoVersion
  #error VersionInfoVersion must be supplied by the release script
#endif

#define AppGuid "{{8DA50D54-84AA-49E9-994F-0E82F5B7E88F}"

[Setup]
AppId={#AppGuid}
AppName=TorPlay
AppVersion={#AppVersion}
AppPublisher=TorPlay
DefaultDirName={localappdata}\Programs\TorPlay
DefaultGroupName=TorPlay
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupLogging=yes
UninstallLogging=yes
OutputDir={#OutputDir}
OutputBaseFilename=TorPlay-Setup-{#AppVersion}
UninstallDisplayName=TorPlay
VersionInfoVersion={#VersionInfoVersion}

[Dirs]
Name: "{localappdata}\TorPlay\config"; Flags: uninsneveruninstall
Name: "{localappdata}\TorPlay\data"; Flags: uninsneveruninstall
Name: "{localappdata}\TorPlay\cache"; Flags: uninsneveruninstall
Name: "{localappdata}\TorPlay\runtime"; Flags: uninsneveruninstall
Name: "{localappdata}\TorPlay\logs"; Flags: uninsneveruninstall

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Excludes: "config\*"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#StageDir}\config\torplay.env"; DestDir: "{localappdata}\TorPlay\config"; Flags: onlyifdoesntexist uninsneveruninstall

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "TorPlay"; ValueData: """{sys}\wscript.exe"" ""{app}\runtime\torplay-tray.vbs"""; Flags: uninsdeletevalue

[Icons]
Name: "{group}\Open TorPlay"; Filename: "http://localhost"
Name: "{group}\TorPlay Tray"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\torplay-tray.vbs"""; WorkingDir: "{app}"
Name: "{group}\TorPlay Status"; Filename: "{app}\runtime\torplay-status.cmd"; WorkingDir: "{app}"
Name: "{group}\Start or Restart TorPlay"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\torplay-launcher.vbs"" restart"; WorkingDir: "{app}"
Name: "{group}\Stop TorPlay"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\torplay-launcher.vbs"" stop"; WorkingDir: "{app}"

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\runtime\windows-firewall.ps1"" -NodePath ""{app}\runtime\node.exe"" -PublicPort 80"; Verb: runas; Flags: shellexec waituntilterminated; StatusMsg: "Configuring the Private-network firewall rules..."
Filename: "{sys}\wscript.exe"; Parameters: """{app}\runtime\torplay-tray.vbs"""; WorkingDir: "{app}"; Flags: nowait skipifsilent; StatusMsg: "Starting TorPlay..."

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\runtime\torplay-tray.ps1"" -StopExisting"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "StopTorPlayTray"
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\runtime\windows-control.mjs"" stop"; WorkingDir: "{app}"; Flags: runhidden waituntilterminated skipifdoesntexist; RunOnceId: "StopTorPlay"
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\runtime\windows-firewall.ps1"" -Remove"; Verb: runas; Flags: shellexec waituntilterminated skipifdoesntexist; RunOnceId: "RemoveTorPlayFirewall"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  NodePath: String;
  ControlPath: String;
  TrayPath: String;
begin
  Result := '';
  TrayPath := ExpandConstant('{app}\runtime\torplay-tray.ps1');
  if FileExists(TrayPath) then
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' + TrayPath + '" -StopExisting',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
  NodePath := ExpandConstant('{app}\runtime\node.exe');
  ControlPath := ExpandConstant('{app}\runtime\windows-control.mjs');
  if FileExists(NodePath) and FileExists(ControlPath) then
    Exec(NodePath, '"' + ControlPath + '" stop', ExpandConstant('{app}'), SW_HIDE,
      ewWaitUntilTerminated, ResultCode);
end;

procedure DeinitializeSetup;
var
  LogPath: String;
begin
  LogPath := ExpandConstant('{log}');
  if (LogPath <> '') and FileExists(LogPath) then begin
    ForceDirectories(ExpandConstant('{localappdata}\TorPlay\logs'));
    FileCopy(LogPath, ExpandConstant('{localappdata}\TorPlay\logs\install.log'), False);
  end;
end;

procedure DeinitializeUninstall;
var
  LogPath: String;
begin
  LogPath := ExpandConstant('{log}');
  if (LogPath <> '') and FileExists(LogPath) then begin
    ForceDirectories(ExpandConstant('{localappdata}\TorPlay\logs'));
    FileCopy(LogPath, ExpandConstant('{localappdata}\TorPlay\logs\uninstall.log'), False);
  end;
end;
