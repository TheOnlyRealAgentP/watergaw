//! Watergaw core: NEXRAD decoders and radar geometry.
//!
//! Compiled to WebAssembly for the web app (see `ffi`), and usable as a normal
//! Rust library for a native Android build or command-line tools.

pub mod bytes;
pub mod ffi;
pub mod geo;
pub mod grib2;
pub mod level3;
pub mod nowcast;

#[derive(Debug, Clone, PartialEq)]
pub enum Error {
    Truncated(&'static str),
    Format(&'static str),
    Unsupported(i16),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Truncated(m) => write!(f, "truncated file: {m}"),
            Error::Format(m) => write!(f, "bad format: {m}"),
            Error::Unsupported(c) => write!(f, "unsupported product code {c}"),
        }
    }
}

impl std::error::Error for Error {}
