// Lzms.cs - the installer's payload codec: LZMS through the Windows
// Compression API (cabinet.dll, Windows 8 and later).
//
// Built into Windows, so the installer carries no decompressor of its own,
// and close to LZMA for a file like ThermalBridge.exe: about a third of its
// size, unpacked in a second or two. Compressing is slow (tens of seconds),
// which only the build pays for (installer/Pack.cs).
//
// "Buffer mode": one call per direction, with a small header that the API
// writes and reads itself. The whole file is in memory either way, which at
// ~90 MB is fine on anything that can run Thermal Bridge.

using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

static class Lzms
{
    const uint COMPRESS_ALGORITHM_LZMS = 5;
    const int ERROR_INSUFFICIENT_BUFFER = 122;

    [DllImport("cabinet.dll", SetLastError = true)]
    static extern bool CreateCompressor(uint algorithm, IntPtr allocationRoutines, out IntPtr handle);

    [DllImport("cabinet.dll", EntryPoint = "Compress", SetLastError = true)]
    static extern bool NativeCompress(IntPtr handle, byte[] data, UIntPtr dataSize, byte[] buffer, UIntPtr bufferSize, out UIntPtr compressedSize);

    [DllImport("cabinet.dll", SetLastError = true)]
    static extern bool CloseCompressor(IntPtr handle);

    [DllImport("cabinet.dll", SetLastError = true)]
    static extern bool CreateDecompressor(uint algorithm, IntPtr allocationRoutines, out IntPtr handle);

    [DllImport("cabinet.dll", EntryPoint = "Decompress", SetLastError = true)]
    static extern bool NativeDecompress(IntPtr handle, byte[] data, UIntPtr dataSize, byte[] buffer, UIntPtr bufferSize, out UIntPtr uncompressedSize);

    [DllImport("cabinet.dll", SetLastError = true)]
    static extern bool CloseDecompressor(IntPtr handle);

    public static byte[] Compress(byte[] data)
    {
        IntPtr handle;
        if (!CreateCompressor(COMPRESS_ALGORITHM_LZMS, IntPtr.Zero, out handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not start the LZMS compressor.");
        try
        {
            // Ask for the size first; the API answers with ERROR_INSUFFICIENT_BUFFER.
            UIntPtr needed;
            if (!NativeCompress(handle, data, (UIntPtr)data.Length, null, UIntPtr.Zero, out needed)
                && Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER)
                throw new Win32Exception(Marshal.GetLastWin32Error());

            byte[] buffer = new byte[(long)needed.ToUInt64()];
            UIntPtr written;
            if (!NativeCompress(handle, data, (UIntPtr)data.Length, buffer, (UIntPtr)buffer.Length, out written))
                throw new Win32Exception(Marshal.GetLastWin32Error());

            byte[] result = new byte[(long)written.ToUInt64()];
            Buffer.BlockCopy(buffer, 0, result, 0, result.Length);
            return result;
        }
        finally
        {
            CloseCompressor(handle);
        }
    }

    public static byte[] Decompress(byte[] data, long size)
    {
        IntPtr handle;
        if (!CreateDecompressor(COMPRESS_ALGORITHM_LZMS, IntPtr.Zero, out handle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Windows could not start the LZMS decompressor.");
        try
        {
            byte[] buffer = new byte[size];
            UIntPtr written;
            if (!NativeDecompress(handle, data, (UIntPtr)data.Length, buffer, (UIntPtr)buffer.Length, out written))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            if ((long)written.ToUInt64() != size)
                throw new InvalidOperationException("The payload unpacked to the wrong size.");
            return buffer;
        }
        finally
        {
            CloseDecompressor(handle);
        }
    }
}
