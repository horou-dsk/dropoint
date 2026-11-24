pub mod chat;
pub mod files;
pub mod frontend;
pub mod health;

// The request limit includes multipart headers and boundaries. The file limit
// remains 5 GiB, with room for a normal multipart envelope.
pub const MAX_UPLOAD_FILE_SIZE: u64 = 5 * 1024 * 1024 * 1024;
pub const MAX_UPLOAD_BODY_SIZE: usize = MAX_UPLOAD_FILE_SIZE as usize + 16 * 1024 * 1024;
