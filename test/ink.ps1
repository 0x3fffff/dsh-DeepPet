# Vertical+horizontal ink extents of the pet window, via PrintWindow.
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI,
# which mangles non-ASCII bytes and breaks parsing.
# Args: -PetPid <pid> [-Shot <path>]. Emits one line of JSON.
param([Parameter(Mandatory=$true)][int]$PetPid, [string]$Shot)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public struct RC2 { public int L, T, R, B; }
public static class E2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RC2 r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  public static List<IntPtr> TopLevel(uint want) {
    var found = new List<IntPtr>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == want && IsWindowVisible(h)) found.Add(h);
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

[void][E2]::SetProcessDPIAware()

$hwnds = [E2]::TopLevel([uint32]$PetPid)
$pet = $null; $rect = New-Object RC2; $best = -1
foreach ($h in $hwnds) {
  $r = New-Object RC2
  if ([E2]::GetWindowRect($h, [ref]$r)) {
    $area = ($r.R - $r.L) * ($r.B - $r.T)
    if ($area -gt $best) { $best = $area; $pet = $h; $rect = $r }
  }
}
if (-not $pet) { '{"ok":false,"reason":"no pet window found"}'; exit }

$w = $rect.R - $rect.L
$h = $rect.B - $rect.T
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
# Layered window: only PrintWindow with PW_RENDERFULLCONTENT captures it.
[void][E2]::PrintWindow($pet, $dc, 2)
$g.ReleaseHdc($dc)
$g.Dispose()
if ($Shot) { $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png) }

# The alpha channel of a PrintWindow capture comes back opaque, so scan
# luminance instead -- transparent areas render as black. The character has
# no pure-black pixels, so nothing real is missed.
$rc = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $bmp.LockBits($rc, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
$bmp.UnlockBits($data)
$bmp.Dispose()

$inkL = $w; $inkR = -1; $inkT = $h; $inkB = -1; $n = 0
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x++) {
    $i = $row + $x * 4
    if (($bytes[$i] + $bytes[$i+1] + $bytes[$i+2]) -gt 24) {
      $n++
      if ($x -lt $inkL) { $inkL = $x }
      if ($x -gt $inkR) { $inkR = $x }
      if ($y -lt $inkT) { $inkT = $y }
      if ($y -gt $inkB) { $inkB = $y }
    }
  }
}

$o = [ordered]@{
  ok = $true
  win = [ordered]@{ x = $rect.L; y = $rect.T; w = $w; h = $h }
  inkL = $inkL; inkR = $inkR; inkT = $inkT; inkB = $inkB; pixels = $n
}
$o | ConvertTo-Json -Compress
