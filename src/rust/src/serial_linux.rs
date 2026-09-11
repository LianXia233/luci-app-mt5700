//! Linux 串口传输（termios raw 模式）。
//! 打开后拆成读写两半：读侧由 tokio AsyncFd 事件驱动，空闲不占 CPU。

use crate::config::SerialConfig;
use crate::log_error;
use crate::transport::{Transport, TransportParts};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::pin::Pin;
use std::task::{Context, Poll, ready};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

const BAUDS: &[(u32, libc::speed_t)] = &[
    (9600, libc::B9600),
    (19200, libc::B19200),
    (38400, libc::B38400),
    (57600, libc::B57600),
    (115200, libc::B115200),
    (230400, libc::B230400),
    (460800, libc::B460800),
    (921600, libc::B921600),
    (1500000, libc::B1500000),
    (3000000, libc::B3000000),
    (4000000, libc::B4000000),
];

fn ioctl_tcgetattr(fd: i32) -> std::io::Result<libc::termios> {
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    if unsafe { libc::tcgetattr(fd, &mut t) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(t)
}

fn ioctl_tcsetattr(fd: i32, t: &libc::termios) -> std::io::Result<()> {
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, t) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

fn configure_termios(fd: i32, speed: libc::speed_t) -> std::io::Result<()> {
    let mut t = ioctl_tcgetattr(fd)?;

    t.c_iflag &= !(libc::IGNBRK | libc::BRKINT | libc::PARMRK | libc::ISTRIP
        | libc::INLCR | libc::IGNCR | libc::ICRNL | libc::IXON | libc::IXOFF);
    t.c_oflag &= !libc::OPOST;
    t.c_lflag &= !(libc::ECHO | libc::ECHONL | libc::ICANON | libc::ISIG | libc::IEXTEN);
    t.c_cflag &= !(libc::CSIZE | libc::PARENB | libc::CSTOPB | libc::CRTSCTS);
    t.c_cflag |= libc::CS8 | libc::CREAD | libc::CLOCAL;

    // 阻塞语义交给 tokio AsyncFd，termios 层设成立即返回。
    t.c_cc[libc::VMIN] = 0;
    t.c_cc[libc::VTIME] = 0;

    // 波特率写进 c_cflag 的 CBAUD 位（与 Go 实现对 Linux 的处理一致）。
    t.c_cflag = (t.c_cflag & !libc::CBAUD) | speed;

    ioctl_tcsetattr(fd, &t)
}

pub struct SerialReader {
    afd: tokio::io::unix::AsyncFd<OwnedFd>,
}

impl AsyncRead for SerialReader {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        loop {
            let mut guard = ready!(self.afd.poll_read_ready(cx))?;
            match guard.try_io(|inner| {
                let fd = inner.as_raw_fd();
                let n = unsafe { libc::read(fd, buf.unfilled_mut().as_mut_ptr() as *mut _, buf.remaining()) };
                if n < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(n as usize)
                }
            }) {
                Ok(Ok(n)) => {
                    unsafe { buf.assume_init(n) };
                    buf.advance(n);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(e)) => return Poll::Ready(Err(e)),
                Err(_would_block) => continue,
            }
        }
    }
}

#[allow(dead_code)] // write_timeout 保留（写超时扩展位）
pub struct SerialWriter {
    afd: tokio::io::unix::AsyncFd<OwnedFd>,
    write_timeout: Duration,
}

impl AsyncWrite for SerialWriter {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        loop {
            let mut guard = ready!(self.afd.poll_write_ready(cx))?;
            match guard.try_io(|inner| {
                let fd = inner.as_raw_fd();
                let n = unsafe { libc::write(fd, buf.as_ptr() as *const _, buf.len()) };
                if n < 0 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(n as usize)
                }
            }) {
                Ok(res) => return Poll::Ready(res),
                Err(_would_block) => continue,
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

pub struct SerialTransport {
    reader_fd: Option<OwnedFd>,
    writer_fd: Option<OwnedFd>,
    port: String,
    write_timeout: Duration,
}

pub async fn open_serial(cfg: &SerialConfig) -> Result<Box<dyn Transport>, String> {
    let speed = BAUDS
        .iter()
        .find(|(b, _)| *b == cfg.baudrate)
        .map(|(_, s)| *s)
        .ok_or_else(|| format!("不支持的波特率 {}", cfg.baudrate))?;

    let cpath = std::ffi::CString::new(cfg.port.as_str()).map_err(|e| e.to_string())?;
    let fd = unsafe { libc::open(cpath.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_NONBLOCK) };
    if fd < 0 {
        return Err(format!("打开串口 {} 失败: {}", cfg.port, std::io::Error::last_os_error()));
    }

    if let Err(e) = configure_termios(fd, speed) {
        unsafe { libc::close(fd) };
        return Err(format!("配置串口 {} 失败: {e}", cfg.port));
    }

    let write_fd = unsafe { libc::dup(fd) };
    if write_fd < 0 {
        unsafe { libc::close(fd) };
        return Err(format!("复制串口 fd 失败: {}", std::io::Error::last_os_error()));
    }

    Ok(Box::new(SerialTransport {
        reader_fd: Some(unsafe { OwnedFd::from_raw_fd(fd) }),
        writer_fd: Some(unsafe { OwnedFd::from_raw_fd(write_fd) }),
        port: cfg.port.clone(),
        write_timeout: cfg.timeout,
    }))
}

#[async_trait::async_trait]
impl Transport for SerialTransport {
    fn into_parts(mut self: Box<Self>) -> TransportParts {
        // Option::take 避免 OwnedFd::from_raw_fd(-1)（该断言会 panic / abort）
        let reader_fd = self
            .reader_fd
            .take()
            .expect("SerialTransport reader_fd missing");
        let writer_fd = self
            .writer_fd
            .take()
            .expect("SerialTransport writer_fd missing");
        let reader_afd = match tokio::io::unix::AsyncFd::new(reader_fd) {
            Ok(a) => a,
            Err(e) => {
                log_error!("串口读侧 AsyncFd 失败: {e}");
                // 用 /dev/null 退化，避免进程 abort
                let null = std::fs::File::open("/dev/null").expect("open /dev/null");
                let owned: OwnedFd = null.into();
                tokio::io::unix::AsyncFd::new(owned).expect("null async fd")
            }
        };
        let writer_afd = match tokio::io::unix::AsyncFd::new(writer_fd) {
            Ok(a) => a,
            Err(e) => {
                log_error!("串口写侧 AsyncFd 失败: {e}");
                let null = std::fs::File::open("/dev/null").expect("open /dev/null");
                let owned: OwnedFd = null.into();
                tokio::io::unix::AsyncFd::new(owned).expect("null async fd")
            }
        };
        TransportParts {
            reader: Box::new(SerialReader { afd: reader_afd }),
            writer: Box::new(SerialWriter {
                afd: writer_afd,
                write_timeout: self.write_timeout,
            }),
        }
    }

    fn describe(&self) -> String {
        format!("串口 {}", self.port)
    }
}
