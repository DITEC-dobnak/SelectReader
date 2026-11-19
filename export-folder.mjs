import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class ExportFolder {
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
      int hr = dialog.Show(IntPtr.Zero);
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
[Console]::Write([ExportFolder]::Choose())
`;

export async function chooseExportFolder() {
  if (process.platform !== 'win32') throw new Error('Výber priečinka je dostupný vo Windows.');
  const exe = path.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await promisify(execFile)(exe, ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true });
  return stdout || null;
}
