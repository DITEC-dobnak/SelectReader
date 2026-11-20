import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ExportFolder {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int capacity);
  static IntPtr BrowserOwner() {
    var window = GetForegroundWindow();
    var name = new System.Text.StringBuilder(128);
    GetClassName(window, name, name.Capacity);
    // Do not make an unrelated app modal if the user has already switched away.
    return name.ToString().StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal) ||
      name.ToString() == "MozillaWindowClass" ? window : IntPtr.Zero;
  }
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int how);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  public static bool Activate(IntPtr hwnd, IntPtr initiator) {
    if (IsIconic(hwnd)) {
      ShowWindowAsync(hwnd, 9); // SW_RESTORE
      for (int i=0; i<10 && IsIconic(hwnd); i++) System.Threading.Thread.Sleep(30);
    }
    if (GetForegroundWindow() == hwnd) return true;
    if (GetForegroundWindow() != initiator) return false;
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    for (int i=0; i<10; i++) {
      if (GetForegroundWindow() == hwnd) return true;
      System.Threading.Thread.Sleep(30);
    }
    return false;
  }
  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr owner);
    // Unused slots retain the order of the native IFileDialog interface.
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint flags); void GetOptions(out uint flags);
    void SetDefaultFolder(); void SetFolder(); void GetFolder(); void GetCurrentSelection(); void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem item);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint kind, [MarshalAs(UnmanagedType.LPWStr)] out string name);
  }
  public static string Choose() {
    var dialog = (IFileDialog)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")));
    IShellItem item = null;
    try {
      uint flags; dialog.GetOptions(out flags);
      dialog.SetOptions(flags | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
      dialog.SetTitle("Select Reader - Vybrať cieľový priečinok");
      int hr = dialog.Show(BrowserOwner());
      if (hr == unchecked((int)0x800704C7)) return null; // User cancelled.
      Marshal.ThrowExceptionForHR(hr);
      dialog.GetResult(out item);
      string path; item.GetDisplayName(0x80058000, out path); // SIGDN_FILESYSPATH
      return path;
    } finally {
      if (item != null) Marshal.ReleaseComObject(item);
      Marshal.ReleaseComObject(dialog);
    }
  }
}
'@
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
`;

async function runShell(command, env = process.env) {
  const exe = path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(exe, ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script + command, 'utf16le').toString('base64')], { windowsHide: true, env });
  return stdout;
}

export async function chooseExportFolder() {
  if (process.platform !== 'win32') throw new Error('Výber priečinka je dostupný vo Windows.');
  const stdout = await runShell('[Console]::Write([ExportFolder]::Choose())');
  return stdout || null;
}

export async function openExportFolder(folder, createDefault) {
  if (process.platform !== 'win32') throw new Error('Otvorenie priečinka je dostupné vo Windows.');
  if (createDefault) await mkdir(folder, { recursive: true });
  if (!(await stat(folder)).isDirectory()) throw new Error('Cieľ exportu nie je priečinok.');
  const opened = await runShell(`
$folder = $env:SELECT_READER_OPEN_FOLDER
$explorer = Join-Path $env:WINDIR 'explorer.exe'
$initiator = [ExportFolder]::GetForegroundWindow()
Start-Process -FilePath $explorer -ArgumentList ('"' + $folder + '"') -WindowStyle Normal
$shell = New-Object -ComObject Shell.Application
$deadline = [Diagnostics.Stopwatch]::StartNew()
do {
  foreach ($window in $shell.Windows()) {
    if ($window.FullName -ieq $explorer -and $window.Document.Folder.Self.Path -and $window.Document.Folder.Self.Path.TrimEnd('\\') -ieq $folder.TrimEnd('\\')) {
      if ([ExportFolder]::Activate([IntPtr]([long]$window.HWND), $initiator)) {
        [Console]::Write('foreground')
        return
      }
      $found = $true
    }
  }
  Start-Sleep -Milliseconds 150
} while ($deadline.Elapsed.TotalSeconds -lt 6)
if ($found) { [Console]::Write('background') }
`, { ...process.env, SELECT_READER_OPEN_FOLDER: path.resolve(folder) });
  if (opened === 'background') throw new Error('Priečinok je otvorený, ale Windows ponechal Prieskumníka na pozadí. Klikni naň na paneli úloh.');
  if (opened !== 'foreground') throw new Error('Prieskumník nepotvrdil otvorenie cieľového priečinka. Skontroluj jeho okno na paneli úloh.');
}
