//! Small OS integration helpers for child processes.

use std::process::{Child, Command};

/// Prevents console windows from flashing up for helper processes on Windows.
pub fn configure_command(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Ties the lifetime of `child` to the current process so an encoder can never keep
/// recording after ClipLock crashes. On Windows this uses a job object with
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; the job handle is intentionally never closed so
/// the kernel closes it (and kills members) when ClipLock exits for any reason.
pub fn bind_child_to_process(child: &Child) {
    #[cfg(windows)]
    windows_job::assign(child);
    #[cfg(not(windows))]
    {
        let _ = child;
    }
}

#[cfg(windows)]
mod windows_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;

    use windows::core::PCWSTR;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    struct Job(isize);

    fn job() -> Option<HANDLE> {
        static JOB: OnceLock<Option<Job>> = OnceLock::new();
        JOB.get_or_init(|| unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null()).ok()?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .ok()?;
            Some(Job(handle.0 as isize))
        })
        .as_ref()
        .map(|j| HANDLE(j.0 as *mut core::ffi::c_void))
    }

    pub fn assign(child: &Child) {
        let Some(job) = job() else {
            tracing::warn!("could not create job object; encoder may outlive a crash");
            return;
        };
        let process = HANDLE(child.as_raw_handle());
        if let Err(e) = unsafe { AssignProcessToJobObject(job, process) } {
            tracing::warn!("AssignProcessToJobObject failed: {e}");
        }
    }
}
