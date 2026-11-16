using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

internal sealed class CodexCompanion : NativeWindow, IDisposable
{
    private const int HotkeyId = 1;
    private const int WmHotkey = 0x0312;
    private const uint EventSystemForeground = 3;
    private const uint ModControlNoRepeat = 0x4002;
    private const uint VkTab = 0x09;

    private readonly string project = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
    private readonly string electron;
    private readonly int session = Process.GetCurrentProcess().SessionId;
    private readonly System.Windows.Forms.Timer timer;
    private readonly WinEventProc onForeground;
    private readonly IntPtr foregroundHook;
    private bool hotkeyRegistered;
    private int codexId;

    [STAThread]
    private static void Main()
    {
        using (var singleInstance = new Mutex(false, @"Local\MapLive.CodexCompanion"))
        {
            if (!singleInstance.WaitOne(0)) return;
            try
            {
                using (var companion = new CodexCompanion()) Application.Run();
            }
            finally { singleInstance.ReleaseMutex(); }
        }
    }

    private CodexCompanion()
    {
        electron = Path.Combine(project, @"node_modules\electron\dist\electron.exe");
        CreateHandle(new CreateParams { Parent = new IntPtr(-3) });
        onForeground = (hook, eventType, window, objectId, childId, thread, time) => RefreshHotkey();
        foregroundHook = SetWinEventHook(EventSystemForeground, EventSystemForeground, IntPtr.Zero,
            onForeground, 0, 0, 0);
        timer = new System.Windows.Forms.Timer { Interval = 850 };
        timer.Tick += (sender, args) => CheckCodex();
        timer.Start();
        CheckCodex();
    }

    private void CheckCodex()
    {
        int visibleCodex = 0;
        var instances = Process.GetProcessesByName("ChatGPT");
        foreach (var process in instances)
        {
            using (process)
            {
                try
                {
                    if (process.SessionId != session || process.MainWindowHandle == IntPtr.Zero || !IsCodex(process)) continue;
                    if (visibleCodex == 0 || process.Id == codexId) visibleCodex = process.Id;
                }
                catch (Win32Exception) { }
                catch (InvalidOperationException) { }
            }
        }
        if (visibleCodex != codexId)
        {
            codexId = visibleCodex;
            if (codexId != 0) Launch("--show-on-launch");
        }
        RefreshHotkey();
    }

    private bool ShouldHandleShortcut()
    {
        uint foregroundId;
        GetWindowThreadProcessId(GetForegroundWindow(), out foregroundId);
        if (foregroundId == 0) return false;
        if (foregroundId == codexId) return true;
        try
        {
            using (var process = Process.GetProcessById((int)foregroundId))
            {
                if (process.ProcessName == "ChatGPT") return IsCodex(process);
                return process.ProcessName == "electron" &&
                    string.Equals(ProcessPath(process), electron, StringComparison.OrdinalIgnoreCase);
            }
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    private void RefreshHotkey()
    {
        bool shouldRegister = ShouldHandleShortcut();
        if (shouldRegister == hotkeyRegistered) return;
        if (shouldRegister) hotkeyRegistered = RegisterHotKey(Handle, HotkeyId, ModControlNoRepeat, VkTab);
        else
        {
            UnregisterHotKey(Handle, HotkeyId);
            hotkeyRegistered = false;
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WmHotkey && message.WParam.ToInt32() == HotkeyId && ShouldHandleShortcut())
        {
            Launch("--cycle-view");
            return;
        }
        base.WndProc(ref message);
    }

    private void Launch(string argument)
    {
        if (!File.Exists(electron) || !File.Exists(Path.Combine(project, @"dist\renderer.js"))) return;
        try
        {
            using (Process.Start(new ProcessStartInfo(electron, ". " + argument) {
                WorkingDirectory = project,
                UseShellExecute = false,
                CreateNoWindow = true
            })) { }
        }
        catch (Win32Exception) { }
    }

    private static string ProcessPath(Process process)
    {
        try { return process.MainModule.FileName; }
        catch (Win32Exception) { return ""; }
        catch (InvalidOperationException) { return ""; }
    }

    private static bool IsCodex(Process process)
    {
        var image = ProcessPath(process);
        return image.IndexOf(@"\WindowsApps\OpenAI.Codex_", StringComparison.OrdinalIgnoreCase) >= 0 &&
            image.EndsWith(@"\app\ChatGPT.exe", StringComparison.OrdinalIgnoreCase);
    }

    public void Dispose()
    {
        timer.Dispose();
        if (foregroundHook != IntPtr.Zero) UnhookWinEvent(foregroundHook);
        if (hotkeyRegistered) UnregisterHotKey(Handle, HotkeyId);
        DestroyHandle();
    }

    private delegate void WinEventProc(IntPtr hook, uint eventType, IntPtr window,
        int objectId, int childId, uint thread, uint time);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool RegisterHotKey(IntPtr window, int id, uint modifiers, uint key);
    [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr window, int id);
    [DllImport("user32.dll")] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module,
        WinEventProc callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
}
