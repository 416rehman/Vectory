//! Replace the Windows discretionary ACL instead of amending existing broad grants.
use std::{os::windows::ffi::OsStrExt, path::Path, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, LocalFree},
    Security::{
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            SDDL_REVISION_1, SE_FILE_OBJECT, SetNamedSecurityInfoW,
        },
        DACL_SECURITY_INFORMATION, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
        GetTokenInformation, OWNER_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION,
        TOKEN_QUERY, TOKEN_USER, TokenUser,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};
fn error() -> anyhow::Error {
    std::io::Error::last_os_error().into()
}
fn user_sid() -> anyhow::Result<String> {
    unsafe {
        let mut token = ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(error());
        }
        let mut size = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut size);
        let mut storage = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            CloseHandle(token);
            return Err(error());
        }
        let user = &*storage.as_ptr().cast::<TOKEN_USER>();
        let mut encoded = ptr::null_mut();
        if ConvertSidToStringSidW(user.User.Sid, &mut encoded) == 0 {
            CloseHandle(token);
            return Err(error());
        }
        let mut length = 0;
        while *encoded.add(length) != 0 {
            length += 1
        }
        let sid = String::from_utf16(std::slice::from_raw_parts(encoded, length));
        LocalFree(encoded.cast());
        CloseHandle(token);
        Ok(sid?)
    }
}
pub fn protect(path: &Path, directory: bool) -> anyhow::Result<()> {
    let sid = user_sid()?;
    let inheritance = if directory { "OICI" } else { "" };
    let sddl = format!("O:{sid}D:P(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;{sid})");
    let encoded = sddl.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let name = path
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    unsafe {
        let mut descriptor = ptr::null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            encoded.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            ptr::null_mut(),
        ) == 0
        {
            return Err(error());
        }
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = ptr::null_mut();
        if GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted) == 0
            || present == 0
            || acl.is_null()
        {
            LocalFree(descriptor);
            anyhow::bail!("Cannot construct private state ACL")
        }
        let mut owner = ptr::null_mut();
        if GetSecurityDescriptorOwner(descriptor, &mut owner, &mut defaulted) == 0
            || owner.is_null()
        {
            LocalFree(descriptor);
            anyhow::bail!("Cannot construct private state owner")
        }
        let result = SetNamedSecurityInfoW(
            name.as_ptr(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            owner,
            ptr::null_mut(),
            acl,
            ptr::null_mut(),
        );
        LocalFree(descriptor);
        if result != 0 {
            return Err(std::io::Error::from_raw_os_error(result as i32).into());
        }
    }
    Ok(())
}
