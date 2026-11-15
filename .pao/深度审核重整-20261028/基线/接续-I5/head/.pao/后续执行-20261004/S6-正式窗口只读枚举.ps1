# 用途：只读枚举指定进程的顶层窗口；输入目标PID，输出可见性和标题；不激活、不修改窗口。
param([int]$TargetProcessId = 14616)
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class PaoWindowRead {
 public delegate bool Callback(IntPtr hwnd, IntPtr arg);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr arg);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
}
'@
$callback = [PaoWindowRead+Callback]{param($handle,$unused)
 [uint32]$windowProcess = 0
 [void][PaoWindowRead]::GetWindowThreadProcessId($handle,[ref]$windowProcess)
 if ($windowProcess -eq $TargetProcessId) {
  $title = [Text.StringBuilder]::new(512)
  $class = [Text.StringBuilder]::new(512)
  [void][PaoWindowRead]::GetWindowText($handle,$title,512)
  [void][PaoWindowRead]::GetClassName($handle,$class,512)
  [Console]::WriteLine("handle={0} visible={1} class={2} title={3}",$handle,[PaoWindowRead]::IsWindowVisible($handle),$class,$title)
 }
 return $true
}
[void][PaoWindowRead]::EnumWindows($callback,[IntPtr]::Zero)
