/**
 * Winspool P/Invoke source, shared by the printing and enumeration paths.
 *
 * Why this exists as a fallback
 * ----------------------------
 * A field machine reported:
 *
 *     Could not enumerate printers: Invalid class "Win32_Printer"
 *     Could not enumerate USB printing devices: Invalid class "Win32_PnPEntity"
 *
 * That is a damaged WMI repository — the classes are simply not registered in
 * root\cimv2 any more. It is a well-known Windows failure, it is not rare
 * across a fleet, and it took printer detection *and* printing down with it
 * even though the Print Spooler itself was running perfectly.
 *
 * winspool.drv is the API the spooler itself exposes. It does not involve WMI
 * at all, so it keeps working on exactly those machines. EnumPrinters at level
 * 2 returns more than Get-Printer does, including the WorkOffline flag via the
 * attributes bitfield, so the fallback loses very little:
 *
 *     Generic / Text Only|USB016|Generic / Text Only|576|0|0
 *     Canon G3020 series |WSD-…|Canon G3020 series |2624|128|0
 *
 * Both classes live in one source string so a single pre-compiled assembly
 * serves printing and enumeration alike.
 */

/** PRINTER_INFO_2.Attributes bit flags. */
export const PRINTER_ATTRIBUTE = {
  QUEUED: 0x00000001,
  DIRECT: 0x00000002,
  DEFAULT: 0x00000004,
  SHARED: 0x00000008,
  NETWORK: 0x00000010,
  HIDDEN: 0x00000020,
  LOCAL: 0x00000040,
  ENABLE_DEVQ: 0x00000080,
  KEEP_PRINTED_JOBS: 0x00000100,
  DO_COMPLETE_FIRST: 0x00000200,
  WORK_OFFLINE: 0x00000400,
  ENABLE_BIDI: 0x00000800
} as const;

/** Name of the pre-compiled assembly cached under the data directory. */
export const HELPER_ASSEMBLY_NAME = 'RawPrinterHelper.dll';

/**
 * C# source for both helpers.
 *
 * PRINTER_INFO_2.Status uses the same PRINTER_STATUS_* bit values as WMI's
 * Win32_Printer.PrinterState, so the existing status classifier consumes the
 * fallback output without any special-casing.
 */
export const WINSPOOL_SOURCE = `
using System;
using System.Runtime.InteropServices;

public class RawPrinterHelper
{
    [StructLayout(LayoutKind.Sequential)]
    public struct DOCINFOA
    {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDatatype;
    }

    [DllImport("winspool.drv", EntryPoint = "OpenPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.drv", EntryPoint = "ClosePrinter", SetLastError = true)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartDocPrinterA", SetLastError = true, CharSet = CharSet.Ansi)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOA di);

    [DllImport("winspool.drv", EntryPoint = "EndDocPrinter", SetLastError = true)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "StartPagePrinter", SetLastError = true)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "EndPagePrinter", SetLastError = true)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.drv", EntryPoint = "WritePrinter", SetLastError = true)]
    public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);

    // Returns null on success, or a description of the failing step so the
    // service can report something more useful than "it did not work".
    public static string SendBytesToPrinter(string printerName, byte[] bytes)
    {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "XP Thermal Document";
        di.pDatatype = "RAW";

        if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero))
            return "OpenPrinter failed (win32 error " + Marshal.GetLastWin32Error() + ")";

        try
        {
            if (!StartDocPrinter(hPrinter, 1, ref di))
                return "StartDocPrinter failed (win32 error " + Marshal.GetLastWin32Error() + ")";

            if (!StartPagePrinter(hPrinter))
                return "StartPagePrinter failed (win32 error " + Marshal.GetLastWin32Error() + ")";

            int written;
            bool ok = WritePrinter(hPrinter, bytes, bytes.Length, out written);
            int err = Marshal.GetLastWin32Error();

            EndPagePrinter(hPrinter);
            EndDocPrinter(hPrinter);

            if (!ok)
                return "WritePrinter failed (win32 error " + err + ")";
            if (written != bytes.Length)
                return "Short write: " + written + " of " + bytes.Length + " bytes reached the spooler";

            return null;
        }
        finally
        {
            ClosePrinter(hPrinter);
        }
    }
}

// Enumerates print queues straight from the spooler, with no WMI involved.
// This is what keeps a machine with a damaged WMI repository working.
public class PrinterEnum
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PRINTER_INFO_2
    {
        public string pServerName;
        public string pPrinterName;
        public string pShareName;
        public string pPortName;
        public string pDriverName;
        public string pComment;
        public string pLocation;
        public IntPtr pDevMode;
        public string pSepFile;
        public string pPrintProcessor;
        public string pDatatype;
        public string pParameters;
        public IntPtr pSecurityDescriptor;
        public uint Attributes;
        public uint Priority;
        public uint DefaultPriority;
        public uint StartTime;
        public uint UntilTime;
        public uint Status;
        public uint cJobs;
        public uint AveragePPM;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct PORT_INFO_1
    {
        public string pName;
    }

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool EnumPrinters(uint Flags, string Name, uint Level, IntPtr pBuf,
                                           uint cbBuf, ref uint pcbNeeded, ref uint pcReturned);

    [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool EnumPorts(string pName, uint Level, IntPtr pBuf,
                                        uint cbBuf, ref uint pcbNeeded, ref uint pcReturned);

    public static string[] ListPrinters()
    {
        uint needed = 0, returned = 0;
        // PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS
        uint flags = 0x00000002 | 0x00000004;

        EnumPrinters(flags, null, 2, IntPtr.Zero, 0, ref needed, ref returned);
        if (needed == 0) return new string[0];

        IntPtr buf = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!EnumPrinters(flags, null, 2, buf, needed, ref needed, ref returned))
                return new string[] { "ERR|" + Marshal.GetLastWin32Error() };

            string[] result = new string[returned];
            int size = Marshal.SizeOf(typeof(PRINTER_INFO_2));
            for (int i = 0; i < returned; i++)
            {
                PRINTER_INFO_2 info = (PRINTER_INFO_2)Marshal.PtrToStructure(
                    new IntPtr(buf.ToInt64() + i * size), typeof(PRINTER_INFO_2));
                result[i] = string.Join("|", new string[] {
                    info.pPrinterName, info.pPortName, info.pDriverName,
                    info.Attributes.ToString(), info.Status.ToString(),
                    info.cJobs.ToString(), info.pShareName
                });
            }
            return result;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    public static string[] ListPorts()
    {
        uint needed = 0, returned = 0;
        EnumPorts(null, 1, IntPtr.Zero, 0, ref needed, ref returned);
        if (needed == 0) return new string[0];

        IntPtr buf = Marshal.AllocHGlobal((int)needed);
        try
        {
            if (!EnumPorts(null, 1, buf, needed, ref needed, ref returned))
                return new string[0];

            string[] result = new string[returned];
            int size = Marshal.SizeOf(typeof(PORT_INFO_1));
            for (int i = 0; i < returned; i++)
            {
                PORT_INFO_1 info = (PORT_INFO_1)Marshal.PtrToStructure(
                    new IntPtr(buf.ToInt64() + i * size), typeof(PORT_INFO_1));
                result[i] = info.pName;
            }
            return result;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }
}
`.trim();
