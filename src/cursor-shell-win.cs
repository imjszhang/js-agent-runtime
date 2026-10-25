using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.RegularExpressions;

internal static class CursorShellShim {
  private static int Main(string[] args) {
    var keep = new HashSet<string>(StringComparer.Ordinal) {
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy"
    };
    var drop = new Regex("key|token|secret|password|credential|proxy", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
      var name = (string)entry.Key;
      if (!keep.Contains(name) && drop.IsMatch(name)) Environment.SetEnvironmentVariable(name, null);
    }
    foreach (var name in new[] { "NODE_OPTIONS", "NODE_PATH", "BASH_ENV", "ENV" }) Environment.SetEnvironmentVariable(name, null);
    var root = Environment.GetEnvironmentVariable("SystemRoot");
    if (string.IsNullOrEmpty(root)) root = @"C:\Windows";
    var exe = Path.Combine(root, @"System32\WindowsPowerShell\v1.0\powershell.exe");
    var start = new ProcessStartInfo(exe) { UseShellExecute = false, Arguments = Quote(args) };
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
    return "\"" + arg.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
  }
}
