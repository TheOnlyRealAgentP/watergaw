//! Big-endian cursor over a byte slice. Every read is bounds-checked and
//! returns an error instead of panicking, because radar files arrive from the
//! network and can be truncated.

use crate::Error;

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn at(buf: &'a [u8], pos: usize) -> Result<Self, Error> {
        if pos > buf.len() {
            return Err(Error::Truncated("offset past end of data"));
        }
        Ok(Self { buf, pos })
    }

    pub fn pos(&self) -> usize {
        self.pos
    }

    pub fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    pub fn skip(&mut self, n: usize) -> Result<(), Error> {
        self.take(n).map(|_| ())
    }

    pub fn take(&mut self, n: usize) -> Result<&'a [u8], Error> {
        if self.remaining() < n {
            return Err(Error::Truncated("unexpected end of data"));
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    pub fn u8(&mut self) -> Result<u8, Error> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Result<u16, Error> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    pub fn i16(&mut self) -> Result<i16, Error> {
        Ok(self.u16()? as i16)
    }

    pub fn u32(&mut self) -> Result<u32, Error> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i32(&mut self) -> Result<i32, Error> {
        Ok(self.u32()? as i32)
    }

    pub fn f32(&mut self) -> Result<f32, Error> {
        Ok(f32::from_bits(self.u32()?))
    }
}
