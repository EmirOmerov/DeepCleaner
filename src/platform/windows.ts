/**
 * Thin Windows adapters (PowerShell, reg.exe). Kept out of src/core so the
 * logic there stays testable. Untrusted values (paths, keys, uninstall
 * strings) are always passed as argv entries or environment variables —
 * never concatenated into a shell command line.
 */
import { execFile } from 'node:child_process';
import type { RegistryOps } from '../core/quarantine/quarantine';
import type { RawUninstallEntry } from '../core/uninstall/programs';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], env?: Record<string, string>, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function powershell(script: string, env?: Record<string, string>, timeoutMs?: number): Promise<RunResult> {
  const prelude = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = "Stop"; ';
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', prelude + script],
    env,
    timeoutMs,
  );
}

const LIST_PROGRAMS = `
$roots = @(
  @{ P = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; S = 'machine' },
  @{ P = 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; S = 'machine' },
  @{ P = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'; S = 'user' }
)
$out = foreach ($r in $roots) {
  if (Test-Path $r.P) {
    Get-ChildItem $r.P -ErrorAction SilentlyContinue | ForEach-Object {
      $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
      if ($p) {
        [pscustomobject]@{
          KeyPath = $_.Name; KeyName = $_.PSChildName; Scope = $r.S
          DisplayName = $p.DisplayName; DisplayVersion = $p.DisplayVersion; Publisher = $p.Publisher
          InstallLocation = $p.InstallLocation; InstallDate = $p.InstallDate; EstimatedSize = $p.EstimatedSize
          UninstallString = $p.UninstallString; QuietUninstallString = $p.QuietUninstallString
          DisplayIcon = $p.DisplayIcon; SystemComponent = $p.SystemComponent; WindowsInstaller = $p.WindowsInstaller
          ParentKeyName = $p.ParentKeyName; ReleaseType = $p.ReleaseType; NoRemove = $p.NoRemove
        }
      }
    }
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 3
`;

export async function listInstalledPrograms(): Promise<RawUninstallEntry[]> {
  const r = await powershell(LIST_PROGRAMS, undefined, 120_000);
  if (r.code !== 0) throw new Error('Could not read installed programs: ' + r.stderr.trim().slice(0, 300));
  const parsed = JSON.parse(r.stdout.trim() || '[]');
  return Array.isArray(parsed) ? parsed : [parsed];
}

// Start-Process waits for the uninstaller (and the processes it spawns).
// Values arrive via environment variables, so nothing is interpolated into the script.
const RUN_UNINSTALLER = `
$a = @{ FilePath = $env:DC_FILE; Wait = $true; PassThru = $true }
if ($env:DC_ARGS) { $a.ArgumentList = $env:DC_ARGS }
if ($env:DC_ELEVATE -eq '1') { $a.Verb = 'RunAs' }
try { $p = Start-Process @a; exit [int]$p.ExitCode }
catch { if ($_.Exception.Message -match 'cancel') { exit 1223 } else { Write-Error $_; exit 1 } }
`;

export interface UninstallerResult {
  exitCode: number;
  /** User declined the UAC prompt. */
  cancelled: boolean;
  error?: string;
}

export async function runUninstaller(file: string, args: string, elevate: boolean): Promise<UninstallerResult> {
  const r = await powershell(
    RUN_UNINSTALLER,
    { DC_FILE: file, DC_ARGS: args, DC_ELEVATE: elevate ? '1' : '0' },
    60 * 60_000, // uninstallers can take a while; give them an hour
  );
  return {
    exitCode: r.code,
    cancelled: r.code === 1223,
    error: r.code !== 0 && r.code !== 1223 ? r.stderr.trim().slice(0, 300) || undefined : undefined,
  };
}

// --------------------------------------------------------------- registry

/** Direct child key names. Missing key → []. */
export async function regListSubkeys(key: string): Promise<string[]> {
  const r = await run('reg.exe', ['query', key], undefined, 30_000);
  if (r.code !== 0) return [];
  const prefix = key.toLowerCase().replace(/\\$/, '') + '\\';
  const out: string[] = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const l = line.trim();
    // reg prints full hive names (HKEY_CURRENT_USER\...) even when queried with HKCU\...
    const short = l.replace(/^HKEY_CURRENT_USER/i, 'HKCU').replace(/^HKEY_LOCAL_MACHINE/i, 'HKLM');
    if (short.toLowerCase().startsWith(prefix)) {
      const rest = short.slice(prefix.length);
      if (rest && !rest.includes('\\')) out.push(rest);
    }
  }
  return out;
}

export async function regKeyExists(key: string): Promise<boolean> {
  return (await run('reg.exe', ['query', key], undefined, 30_000)).code === 0;
}

async function regOrThrow(args: string[]) {
  const r = await run('reg.exe', args, undefined, 60_000);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    const denied = /access is denied|pristup.*odbijen/i.test(msg);
    throw Object.assign(new Error(msg || `reg ${args[0]} failed`), denied ? { code: 'EACCES' } : {});
  }
}

export const windowsRegistry: RegistryOps = {
  exportKey: (key, file) => regOrThrow(['export', key, file, '/y']),
  deleteKey: (key) => regOrThrow(['delete', key, '/f']),
  importFile: (file) => regOrThrow(['import', file]),
};
