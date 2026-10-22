// Pack.exe - build-time only. Compresses ThermalBridge.exe into the setup's
// payload with the codec the setup unpacks it with (Lzms.cs).
//
//   Pack.exe <input> <output>
//
// Built and run by scripts/build-exe.mjs; never shipped.

using System;
using System.Diagnostics;
using System.IO;

static class Pack
{
    static int Main(string[] args)
    {
        if (args.Length != 2)
        {
            Console.Error.WriteLine("usage: Pack.exe <input> <output>");
            return 2;
        }

        Stopwatch clock = Stopwatch.StartNew();
        byte[] data = File.ReadAllBytes(args[0]);
        byte[] packed = Lzms.Compress(data);
        File.WriteAllBytes(args[1], packed);

        Console.WriteLine(string.Format("  {0:F1} MB -> {1:F1} MB in {2:F0} s",
            data.Length / 1048576.0, packed.Length / 1048576.0, clock.Elapsed.TotalSeconds));
        return 0;
    }
}
