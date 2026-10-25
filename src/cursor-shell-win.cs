using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

internal static class CursorShellShim {
  private static int Main(string[] args) {
    var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy"
    };
    var drop = new Regex("key|token|secret|password|credential|proxy", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
      var name = (string)entry.Key;
      if (!keep.Contains(name) && drop.IsMatch(name)) Environment.SetEnvironmentVariable(name, null);
    }
    foreach (var name in new[] { "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV" }) Environment.SetEnvironmentVariable(name, null);
    // The installed shim is always <state>/cursor-shell/bin/{powershell,pwsh}.exe.
    // Derive tool HOME from that trusted location, never from inherited login inputs.
    var home = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
    Environment.SetEnvironmentVariable("HOME", home);
    Environment.SetEnvironmentVariable("USERPROFILE", home);
    Environment.SetEnvironmentVariable("APPDATA", Path.Combine(home, "AppData", "Roaming"));
    Environment.SetEnvironmentVariable("LOCALAPPDATA", Path.Combine(home, "AppData", "Local"));
    var drive = Path.GetPathRoot(home).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
    Environment.SetEnvironmentVariable("HOMEDRIVE", drive);
    Environment.SetEnvironmentVariable("HOMEPATH", home.Substring(drive.Length));
    var root = Environment.GetEnvironmentVariable("SystemRoot");
    if (string.IsNullOrEmpty(root)) root = @"C:\Windows";
    var exe = Path.Combine(root, @"System32\WindowsPowerShell\v1.0\powershell.exe");
    // Profiles must stay disabled even if the caller omits -NoProfile.
    var start = new ProcessStartInfo(exe) { UseShellExecute = false, Arguments = "-NoProfile " + Quote(args) };
    try {
      using (var child = Process.Start(start)) {
        if (child == null) return 127;
        child.WaitForExit();
        return child.ExitCode;
      }
    } catch (Exception) {
      return 127;
    }
  }

  private static string Quote(string[] args) {
    var parts = new string[args.Length];
    for (var i = 0; i < args.Length; i++) parts[i] = QuoteOne(args[i]);
    return string.Join(" ", parts);
  }

  private static string QuoteOne(string arg) {
    if (arg.Length == 0) return "\"\"";
    if (arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    // Windows argv parsing only treats backslashes specially before a quote.
    // Preserve ordinary slashes; double trailing ones before our closing quote.
    var quoted = new StringBuilder("\"");
    var slashes = 0;
    foreach (var ch in arg) {
      if (ch == '\\') { slashes++; continue; }
      quoted.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes);
      quoted.Append(ch);
      slashes = 0;
    }
    quoted.Append('\\', slashes * 2);
    return quoted.Append('"').ToString();
  }
}
