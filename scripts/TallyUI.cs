using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;

public class TallyUI2 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, uint extra);
    [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public const int SW_RESTORE = 9;
    public const byte VK_RETURN  = 0x0D;
    public const byte VK_ESCAPE  = 0x1B;
    public const byte VK_MENU    = 0x12;
    public const byte VK_CONTROL = 0x11;
    public const byte VK_SHIFT   = 0x10;
    public const byte VK_TAB     = 0x09;
    public const byte VK_BACK    = 0x08;
    public const byte VK_F1      = 0x70;
    public const byte VK_F2      = 0x71;
    public const byte VK_F3      = 0x72;
    public const byte VK_F4      = 0x73;
    public const byte VK_F5      = 0x74;
    public const byte VK_F10     = 0x79;
    public const byte VK_F12     = 0x7B;
    public const byte VK_DOWN    = 0x28;
    public const byte VK_UP      = 0x26;
    public const byte VK_LEFT    = 0x25;
    public const byte VK_RIGHT   = 0x27;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    public static bool ForceForeground(IntPtr hwnd) {
        IntPtr fg = GetForegroundWindow();
        if (fg == hwnd) return true;
        uint fgPid, tPid;
        uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
        uint tThread  = GetWindowThreadProcessId(hwnd, out tPid);
        if (fgThread != tThread) AttachThreadInput(fgThread, tThread, true);
        ShowWindow(hwnd, SW_RESTORE);
        BringWindowToTop(hwnd);
        bool ok = SetForegroundWindow(hwnd);
        if (fgThread != tThread) AttachThreadInput(fgThread, tThread, false);
        return ok;
    }

    public static void PressKey(byte vk) {
        keybd_event(vk, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(100);
    }

    public static void PressCombo(byte modifier, byte key) {
        keybd_event(modifier, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(key, 0, 0, 0);
        Thread.Sleep(30);
        keybd_event(key, 0, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(30);
        keybd_event(modifier, 0, KEYEVENTF_KEYUP, 0);
        Thread.Sleep(100);
    }

    public static void TypeString(string text) {
        foreach (char c in text) {
            short vk = VkKeyScan(c);
            byte lo = (byte)(vk & 0xFF);
            bool needShift = ((vk >> 8) & 1) != 0;
            if (needShift) keybd_event(VK_SHIFT, 0, 0, 0);
            keybd_event(lo, 0, 0, 0);
            Thread.Sleep(20);
            keybd_event(lo, 0, KEYEVENTF_KEYUP, 0);
            if (needShift) keybd_event(VK_SHIFT, 0, KEYEVENTF_KEYUP, 0);
            Thread.Sleep(40);
        }
    }

    public static Bitmap CaptureWindow(IntPtr hwnd) {
        RECT rect;
        GetWindowRect(hwnd, out rect);
        int width = rect.Right - rect.Left;
        int height = rect.Bottom - rect.Top;
        if (width <= 0 || height <= 0) return null;
        Bitmap bmp = new Bitmap(width, height, PixelFormat.Format24bppRgb);
        using (Graphics g = Graphics.FromImage(bmp)) {
            g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(width, height));
        }
        return bmp;
    }
}
