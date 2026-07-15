use std::path::PathBuf;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DesiredProcess {
    pub revision: u64,
    pub active: bool,
    pub data_root: PathBuf,
}

impl DesiredProcess {
    pub fn new(revision: u64, active: bool, data_root: PathBuf) -> Result<Self, &'static str> {
        if revision == 0 {
            return Err("desired_revision_invalid");
        }
        if data_root.as_os_str().is_empty() {
            return Err("conductor_data_root_missing");
        }
        Ok(Self { revision, active, data_root })
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ProcessStatus {
    #[default]
    Stopped,
    Running,
    NeedsAttention,
    Failed,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ObservedProcess {
    pub applied_revision: u64,
    pub status: ProcessStatus,
    pub crash_count: u8,
    pub error_code: Option<&'static str>,
}
