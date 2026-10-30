Add-Type -Namespace Win32 -Name Pwr -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);'
while($true){ [Win32.Pwr]::SetThreadExecutionState(0x80000003) | Out-Null; Start-Sleep -Seconds 20 }
