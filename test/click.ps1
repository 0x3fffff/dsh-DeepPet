# Mouse injector for test/dblclick.mjs.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles non-ASCII bytes and breaks parsing.
# -Mode dblclick : two rapid clicks at (X, Y)
# -Mode drag     : press at (X, Y), move to (X2, Y) in steps, stay held
# -Mode release  : release the left button wherever the cursor is
param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [int]$X, [int]$Y, [int]$X2
)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct PT { public int X; public int Y; }
public static class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][M]::SetProcessDPIAware()

$DOWN = 0x0002
$UP   = 0x0004

# Remember where the user's cursor was so we can put it back.
$orig = New-Object PT
[void][M]::GetCursorPos([ref]$orig)

switch ($Mode) {
  'dblclick' {
    [void][M]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    for ($i = 0; $i -lt 2; $i++) {
      [M]::mouse_event($DOWN, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 30
      [M]::mouse_event($UP, 0, 0, 0, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 60
    }
    [void][M]::SetCursorPos($orig.X, $orig.Y)
  }
  'drag' {
    [void][M]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 120
    [M]::mouse_event($DOWN, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 80
    # Several small steps: one big jump can be swallowed as a single event.
    $steps = 8
    for ($i = 1; $i -le $steps; $i++) {
      $nx = $X + [int](($X2 - $X) * $i / $steps)
      [void][M]::SetCursorPos($nx, $Y)
      Start-Sleep -Milliseconds 25
    }
  }
  'release' {
    [M]::mouse_event($UP, 0, 0, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [void][M]::SetCursorPos($orig.X, $orig.Y)
  }
}
'{"ok":true}'
