param([string]$Start = '', [switch]$CompileOnly)
# Modern Explorer-style folder picker (IFileOpenDialog with FOS_PICKFOLDERS)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class FolderPicker {
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellItem {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, out IntPtr ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr hwndOwner);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();

    public static string Pick(string start) {
        var dlg = (IFileOpenDialog)new FileOpenDialogRCW();
        uint opts; dlg.GetOptions(out opts);
        dlg.SetOptions(opts | 0x20 | 0x40 | 0x2000000); // PICKFOLDERS | FORCEFILESYSTEM | DONTADDTORECENT
        dlg.SetTitle("Choose a folder with videos/images");
        if (!string.IsNullOrEmpty(start) && System.IO.Directory.Exists(start)) {
            Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
            IShellItem item;
            SHCreateItemFromParsingName(start, IntPtr.Zero, ref iid, out item);
            dlg.SetFolder(item);
        }
        // owner = the browser window that was just clicked, so the dialog opens in front of it
        if (dlg.Show(GetForegroundWindow()) != 0) return "";
        IShellItem res; dlg.GetResult(out res);
        IntPtr p; res.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
        string s = Marshal.PtrToStringUni(p);
        Marshal.FreeCoTaskMem(p);
        return s;
    }
}
'@
if ($CompileOnly) { 'ok'; exit }
[FolderPicker]::Pick($Start)
