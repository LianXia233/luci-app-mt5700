//! 到模组的字节通道：TCP 网络口或 Linux 串口。
//! 拆成独立的 reader / writer，读循环与命令写入可并发（与 Go 语义一致）。

use crate::config::AtConfig;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

#[async_trait::async_trait]
pub trait Transport: Send {
    /// 拆成读写两半。读侧由唯一读循环独占，写侧由命令锁保护。
    fn into_parts(self: Box<Self>) -> TransportParts;
    fn describe(&self) -> String;
}

pub struct TransportParts {
    pub reader: Box<dyn AsyncRead + Unpin + Send>,
    pub writer: Box<dyn AsyncWrite + Unpin + Send>,
}

pub struct TcpTransport {
    stream: tokio::net::TcpStream,
    addr: String,
}

impl TcpTransport {
    pub async fn connect(host: &str, port: u16, timeout: Duration) -> std::io::Result<TcpTransport> {
        let addr = format!("{host}:{port}");
        let stream = tokio::time::timeout(timeout, tokio::net::TcpStream::connect(&addr))
            .await
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "连接超时"))??;
        stream.set_nodelay(true).ok();
        Ok(TcpTransport { stream, addr })
    }
}

struct TcpWriter {
    stream: Box<dyn AsyncWrite + Unpin + Send>,
}

impl AsyncWrite for TcpWriter {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        // 写超时由上层 send_command / RPC 写路径负责；此处不可每 poll 重建 timeout future
        let this = self.get_mut();
        std::pin::Pin::new(&mut this.stream).poll_write(cx, buf)
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        // 每次写入都直接落 socket，无内部缓冲，flush 无事可做。
        std::task::Poll::Ready(Ok(()))
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        _cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::task::Poll::Ready(Ok(()))
    }
}

#[async_trait::async_trait]
impl Transport for TcpTransport {
    fn into_parts(self: Box<Self>) -> TransportParts {
        let (reader, stream) = self.stream.into_split();
        let writer = TcpWriter { stream: Box::new(stream) };
        TransportParts {
            reader: Box::new(reader),
            writer: Box::new(writer),
        }
    }

    fn describe(&self) -> String {
        format!("网络 {}", self.addr)
    }
}

/// 按配置建立到模组的连接。
pub async fn open_transport(cfg: &AtConfig) -> Result<Box<dyn Transport>, String> {
    if cfg.type_ != "SERIAL" {
        let tp = TcpTransport::connect(&cfg.network.host, cfg.network.port, cfg.network.timeout)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Box::new(tp));
    }

    #[cfg(target_os = "linux")]
    {
        if cfg.serial.port == crate::config::AUTO_SERIAL_PORT {
            return crate::serialdetect::detect_at_port(&cfg.serial).await;
        }
        return crate::serial_linux::open_serial(&cfg.serial).await;
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = cfg;
        Err("当前平台不支持串口".into())
    }
}
