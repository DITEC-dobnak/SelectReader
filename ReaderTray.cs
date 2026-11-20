using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public sealed class ReaderTray : IDisposable
{
    readonly Form console = new Form { Text = "Select Reader", Width = 900, Height = 500 };
    readonly TextBox log = new TextBox { Dock = DockStyle.Fill, Multiline = true, ReadOnly = true,
        ScrollBars = ScrollBars.Both, WordWrap = false, BackColor = Color.FromArgb(25, 30, 40),
        ForeColor = Color.White };
    readonly NotifyIcon tray = new NotifyIcon { Text = "Select Reader" };
    readonly Timer timer = new Timer { Interval = 200 };
    readonly ConcurrentQueue<string> output = new ConcurrentQueue<string>();
    readonly Icon icon;
    Process server;

    [DllImport("user32.dll")]
    static extern bool DestroyIcon(IntPtr handle);

    static Icon MakeIcon()
    {
        using (var bitmap = new Bitmap(32, 32))
        using (var g = Graphics.FromImage(bitmap))
        using (var font = new Font("Segoe UI", 22, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
        {
            g.Clear(Color.RoyalBlue);
            g.DrawString("S", font, Brushes.White, new RectangleF(0, 0, 32, 32), format);
            IntPtr handle = bitmap.GetHicon();
            try { using (var borrowed = Icon.FromHandle(handle)) return (Icon)borrowed.Clone(); }
            finally { DestroyIcon(handle); }
        }
    }

    ReaderTray()
    {
        icon = MakeIcon();
        console.Icon = tray.Icon = icon;
        console.Controls.Add(log);
        console.Resize += delegate { if (console.WindowState == FormWindowState.Minimized) console.Hide(); };
        console.FormClosing += (s, e) => {
            if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; console.Hide(); }
        };
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowConsole(); };
        timer.Tick += (s, e) => CheckServer();
    }

    void ShowConsole()
    {
        console.WindowState = FormWindowState.Normal;
        console.Show();
        console.Activate();
    }

    void Launch(bool open)
    {
        var start = new ProcessStartInfo("node.exe", "server.mjs --serve" + (open ? " --open" : "")) {
            WorkingDirectory = Environment.CurrentDirectory, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
        };
        server = new Process { StartInfo = start };
        DataReceivedEventHandler receive = (s, e) => { if (e.Data != null) output.Enqueue(e.Data); };
        server.OutputDataReceived += receive;
        server.ErrorDataReceived += receive;
        server.Start();
        server.BeginOutputReadLine();
        server.BeginErrorReadLine();
    }

    void CheckServer()
    {
        bool done = server.HasExited;
        if (done) server.WaitForExit(); // Drain both redirected streams before reading the final lines.
        string line;
        while (output.TryDequeue(out line)) log.AppendText(line + Environment.NewLine);
        if (log.TextLength > 120000) log.Text = log.Text.Substring(log.TextLength - 80000);
        if (!done) return;
        int code = server.ExitCode;
        server.Dispose();
        server = null;
        if (code == 75) { Launch(false); return; }
        timer.Stop();
        if (code != 0) {
            ShowConsole();
            MessageBox.Show(console, "Reader sa nepodarilo spustiť alebo bol prerušený. Pozri výpis konzoly.",
                "Select Reader", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        Application.ExitThread();
    }

    public static void Run()
    {
        Application.EnableVisualStyles();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
        using (var host = new ReaderTray()) {
            host.Launch(true);
            host.tray.Visible = true;
            host.timer.Start();
            Application.Run();
        }
    }

    public void Dispose()
    {
        timer.Dispose();
        tray.Visible = false;
        tray.Dispose();
        console.Dispose();
        icon.Dispose();
        if (server != null) server.Dispose();
    }
}
