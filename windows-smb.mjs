import { execFile } from 'node:child_process';
import path from 'node:path';
import { validateEndpoint } from './direct-broker.mjs';

export class WindowsShareError extends Error {
  constructor(code, message, status = 503, windowsCode) {
    super(message);
    this.code = code;
    this.status = status;
    if (Number.isInteger(windowsCode)) this.windowsCode = windowsCode;
  }
}

// Standard Windows APIs only. No Select/Enabler library, password retrieval,
// interactive prompt, drive letter, saved mapping or existing-session removal.
const helper = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$stage = 'input'
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $server = [string]$request.server
  if ($server -notmatch '\A[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}\z') { throw 'Invalid server' }
  $share = '\\' + $server + '\enabler'
  $stage = 'windows-api'
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EnablerShareWindowsApi {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 private struct Resource {
  public int scope,type,displayType,usage;
  public string localName,remoteName,comment,provider;
 }
 [DllImport("mpr.dll", CharSet=CharSet.Unicode)]
 private static extern int WNetAddConnection2(ref Resource resource,string password,string username,int flags);
 [DllImport("mpr.dll", CharSet=CharSet.Unicode)]
 private static extern int WNetGetUser(string resource,StringBuilder user,ref int length);
 public static int Connect(string share) {
  var resource=new Resource {type=1,remoteName=share};
  return WNetAddConnection2(ref resource,null,null,0);
 }
 public static int Identity(string share,out string user) {
  int length=256;
  var buffer=new StringBuilder(length);
  int result=WNetGetUser(share,buffer,ref length);
  if(result==234 && length>0 && length<=4096) {
   buffer=new StringBuilder(length);
   result=WNetGetUser(share,buffer,ref length);
  }
  user=result==0?buffer.ToString():null;
  return result;
 }
}
'@
  $stage = 'connect'
  $code = [EnablerShareWindowsApi]::Connect($share)
  if ($code -ne 0) { @{ok=$false;stage=$stage;windowsCode=$code} | ConvertTo-Json -Compress; exit 1 }
  $stage = 'identity'
  $identity = $null
  $code = [EnablerShareWindowsApi]::Identity($share,[ref]$identity)
  if ($code -ne 0) { @{ok=$false;stage=$stage;windowsCode=$code} | ConvertTo-Json -Compress; exit 1 }
  $stage = 'share-read'
  $file = [IO.File]::Open($share + '\omsbroker',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
  try { if ($file.ReadByte() -lt 0) { throw 'Empty broker metadata' } } finally { $file.Dispose() }
  @{ok=$true;identity=$identity;shareReadable=$true} | ConvertTo-Json -Compress
} catch {
  @{ok=$false;stage=$stage;windowsCode=($_.Exception.HResult -band 65535)} | ConvertTo-Json -Compress
  exit 1
}
`;

function executeHelper(server) {
  if (!process.env.WINDIR) throw new WindowsShareError('WINDOWS_RUNTIME', 'Nie je dostupná systémová konfigurácia Windows.');
  const executable = path.win32.join(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', helper], {
      windowsHide: true, encoding: 'utf8', timeout: 15000, maxBuffer: 32768,
    }, (error, stdout, stderr) => {
      let result;
      try { result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()); }
      catch { reject(new WindowsShareError('WINDOWS_RUNTIME', 'Windows overenie nevrátilo platný výsledok. Žiadne údaje ani heslá sa nelogovali.')); return; }
      if ((error && result.ok !== false) || stderr.trim()) {
        reject(new WindowsShareError('WINDOWS_RUNTIME', 'Systémové overenie Windows nebolo úspešne dokončené.'));
        return;
      }
      resolve(result);
    });
    child.stdin.on('error', () => reject(new WindowsShareError('WINDOWS_RUNTIME', 'Windows overenie nemohlo prijať názov servera.')));
    child.stdin.end(JSON.stringify({ server }));
  });
}

export async function authenticateWindowsShare(server, { platform = process.platform, runHelper = executeHelper } = {}) {
  if (platform !== 'win32') throw new WindowsShareError('WINDOWS_REQUIRED', 'Automatické Windows/SMB pripojenie vyžaduje Windows.', 501);
  validateEndpoint(server, 9700);
  let result;
  try { result = await runHelper(server); }
  catch (error) {
    if (error instanceof WindowsShareError) throw error;
    throw new WindowsShareError('WINDOWS_RUNTIME', 'Windows overenie sa nepodarilo. Podrobnosti systémového procesu sa z dôvodu ochrany údajov nelogujú.');
  }
  if (result?.ok !== true) {
    const code = Number.isInteger(result?.windowsCode) ? result.windowsCode : undefined;
    if (code === 1219) throw new WindowsShareError('WINDOWS_CONFLICT', 'Windows hlási konflikt existujúcich sieťových pripojení. Žiadne pripojenie sa neodpojilo ani nenahradilo.', 409, code);
    throw new WindowsShareError('WINDOWS_ACCESS', 'Windows nepovolil prístup k zdieľaniu enabler alebo nezistil jeho overenú sieťovú identitu. UserIdent sa ako náhrada nespustil.', 403, code);
  }
  if (result.shareReadable !== true || typeof result.identity !== 'string' || !result.identity ||
      /[\u0000-\u001f\u007f]/.test(result.identity) || !/^[^\\]+\\[^\\]+$/.test(result.identity))
    throw new WindowsShareError('WINDOWS_IDENTITY', 'Windows nevrátil jednoznačnú overenú sieťovú identitu. Účet procesu sa za ňu nedosadil.');
  return {
    method: 'windows-smb', server, share: `\\\\${server}\\enabler`, verifiedUserId: result.identity,
    shareReadable: true, networkIdentityVerified: true, credentialsRequested: false, persistentMapping: false,
  };
}
