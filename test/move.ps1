# Move the mouse cursor. Used by diagnostics that need to drive the pet's
# hit-test from outside.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles non-ASCII bytes and breaks parsing.
# With -PetPid it also samples WS_EX_TRANSPARENT on the pet window over the
# next second, so the decision the poll thread made can be compared against the
# style that actually landed on the window.
# Args: -X <screen x> -Y <screen y> [-PetPid <pid>]
param([Parameter(Mandatory=$true)][int]$X, [Parameter(Mandatory=$true)][int]$Y, [int]$PetPid)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct RCM { public int L, T, R, B; }
public static class MV {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RCM r);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetExStyle(IntPtr h, int i);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<IntPtr> TopLevel(uint want) {
    var f = new List<IntPtr>();
    EnumWindows((h, p) => { uint pid; GetWindowThreadProcessId(h, out pid); if (pid == want && IsWindowVisible(h)) f.Add(h); return true; }, IntPtr.Zero);
    return f;
  }
}
"@
[void][MV]::SetProcessDPIAware()
[void][MV]::SetCursorPos($X, $Y)
if ($PetPid -gt 0) {
  $pet = $null; $best = -1
  foreach ($h in [MV]::TopLevel([uint32]$PetPid)) {
    $r = New-Object RCM
    if ([MV]::GetWindowRect($h, [ref]$r)) {
      $a = ($r.R - $r.L) * ($r.B - $r.T)
      if ($a -gt $best) { $best = $a; $pet = $h }
    }
  }
  if ($pet) {
    $seq = @()
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 1000) {
      $t = ((([int64][MV]::GetExStyle($pet, -20)) -band 0x20) -ne 0)
      $seq += ("{0}:{1}" -f $sw.ElapsedMilliseconds, [int]$t)
      Start-Sleep -Milliseconds 40
    }
    Write-Output ($seq -join " ")
  }
}
