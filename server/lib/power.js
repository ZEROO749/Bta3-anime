'use strict';
// يمنع سكون اللابتوب أثناء وجود مهام تحميل/ضغط (best-effort على كل نظام).
const { spawn } = require('child_process');

let proc = null;

function on() {
  if (proc) return;
  try {
    if (process.platform === 'win32') {
      const script = "$s='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint f);';" +
        "$t=Add-Type -MemberDefinition $s -Name K -Namespace W -PassThru;" +
        'while($true){[void]$t::SetThreadExecutionState(0x80000001);Start-Sleep -Seconds 30}';
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      proc = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    } else {
      proc = spawn('systemd-inhibit', ['--what=sleep:idle', '--who=Bta3 Anime', '--why=Downloads in progress', 'sleep', '2147483647'], { stdio: 'ignore' });
    }
    proc.on('error', () => { proc = null; });
    proc.on('close', () => { proc = null; });
  } catch (_) { proc = null; }
}

function off() {
  if (!proc) return;
  try { proc.kill(); } catch (_) { /* ignore */ }
  proc = null;
}

process.on('exit', off);

module.exports = { on, off };
