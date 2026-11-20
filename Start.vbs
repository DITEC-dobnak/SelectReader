Option Explicit
Dim shell, fs, result
Set shell = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")
shell.CurrentDirectory = fs.GetParentFolderName(WScript.ScriptFullName)
result = shell.Run("powershell.exe -NoProfile -NonInteractive -STA -Command ""$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Windows.Forms; try { Add-Type -Path '.\ReaderTray.cs' -ReferencedAssemblies System.Windows.Forms,System.Drawing; [ReaderTray]::Run() } catch { [void][Windows.Forms.MessageBox]::Show($_.Exception.Message,'Select Reader'); exit 1 }""", 0, True)
WScript.Quit result
