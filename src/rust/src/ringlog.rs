//! 有界日志存储：内存环形缓存 + 带大小上限的文件写入。
//!
//! # 为什么单独成模块
//!
//! 「日志页看得到的历史」原来分两块：后端内存环形缓冲（`logger`）与
//! 通知日志文件（`notify` 的 `log_file`，默认 `/tmp/at-notifications.log`）。
//! 后者是**纯 append、没有任何上限** —— 短信/来电/信号巡检每来一条就追加几行，
//! 长期跑会把 tmpfs（内存）吃掉，严重时整机的 `/tmp` 满了会连带影响其它服务。
//!
//! 本模块把「有界」这件事收敛成两个可复用件，供上面两块共用：
//!   - [`RingLog`]：内存环形缓存，**默认**的日志载体，按条数与总字节双上限淘汰；
//!   - [`append_capped`]：写文件时先按上限裁剪，保证文件永不超过设定大小。
//!
//! # 为什么是「双上限」
//!
//! 只限条数不够：一条短信正文可以很长、URC 原始行也可能被整段记入，
//! 1200 条长消息一样能撑爆内存；只限字节则会出现「淘汰得只剩几条」的抖动。
//! 两个上限同时生效，先到先淘汰。

use std::collections::VecDeque;
use std::io::Write;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;

/// 内存环形缓存的默认条数上限。
pub const DEFAULT_RING_ENTRIES: usize = 1200;
/// 内存环形缓存的默认总字节上限（512 KiB）。
pub const DEFAULT_RING_BYTES: usize = 512 * 1024;
/// 日志文件的默认大小上限（256 KiB）。
///
/// 取 256 KiB 而不是几 MB：`/tmp` 在多数路由器上是 tmpfs（占内存），
/// 而日志页的价值主要在「最近发生了什么」，留最近几百条足够排障。
pub const DEFAULT_MAX_LOG_FILE_BYTES: u64 = 256 * 1024;

/// 一条日志记录。
///
/// 字段与前端已消费的 JSON 结构一致（`seq` / `ts` / `level` / `msg`），
/// `logger` 直接把它作为 `LogRecord` 暴露，序列化结果不变。
#[derive(Clone, Debug, serde::Serialize)]
pub struct Entry {
    /// 单调递增序号，前端据此做增量拉取。
    pub seq: u64,
    /// 毫秒时间戳（前端本地格式化，避免时区/时钟不同源）。
    pub ts: i64,
    /// DBG / INF / WRN / ERR
    pub level: String,
    pub msg: String,
}

impl Entry {
    /// 这条记录占用的近似字节数（用于字节上限，不必精确到序列化后大小）。
    fn weight(&self) -> usize {
        self.level.len() + self.msg.len() + 32
    }
}

/// 内存环形日志：超出上限从队首淘汰最旧记录。
pub struct RingLog {
    cap_entries: usize,
    cap_bytes: usize,
    seq: AtomicU64,
    bytes: AtomicUsize,
    inner: Mutex<VecDeque<Entry>>,
}

impl RingLog {
    pub fn new(cap_entries: usize, cap_bytes: usize) -> RingLog {
        RingLog {
            cap_entries: cap_entries.max(1),
            cap_bytes: cap_bytes.max(1),
            seq: AtomicU64::new(0),
            bytes: AtomicUsize::new(0),
            inner: Mutex::new(VecDeque::new()),
        }
    }

    /// 按默认上限构造（1200 条 / 512 KiB）。
    pub fn with_defaults() -> RingLog {
        RingLog::new(DEFAULT_RING_ENTRIES, DEFAULT_RING_BYTES)
    }

    /// 追加一条记录，返回它的 seq。
    pub fn push(&self, ts: i64, level: &str, msg: &str) -> u64 {
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let entry = Entry { seq, ts, level: level.to_string(), msg: msg.to_string() };
        let w = entry.weight();
        let mut guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.push_back(entry);
        let mut total = self.bytes.load(Ordering::Relaxed) + w;
        // 双上限淘汰：条数超了或字节超了都从队首丢，直到两个条件都满足
        while guard.len() > self.cap_entries || total > self.cap_bytes {
            match guard.pop_front() {
                Some(old) => total = total.saturating_sub(old.weight()),
                None => break,
            }
        }
        self.bytes.store(total, Ordering::Relaxed);
        seq
    }

    /// 取快照：`(当前最新 seq, seq > since 的记录，最多 limit 条)`。
    ///
    /// `limit` 超出时保留**最新**的部分（排障看最新的更有用）。
    pub fn snapshot(&self, since: u64, limit: usize) -> (u64, Vec<Entry>) {
        let guard = match self.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let seq = self.seq.load(Ordering::Relaxed);
        let mut out: Vec<Entry> = guard.iter().filter(|e| e.seq > since).cloned().collect();
        if limit > 0 && out.len() > limit {
            let keep_from = out.len() - limit;
            out.drain(..keep_from);
        }
        (seq, out)
    }

    /// 当前条数（给单测与后续状态展示用）。
    #[allow(dead_code)]
    pub fn len(&self) -> usize {
        self.inner.lock().map(|g| g.len()).unwrap_or(0)
    }

    /// 当前占用字节（给单测与后续状态展示用）。
    #[allow(dead_code)]
    pub fn bytes(&self) -> usize {
        self.bytes.load(Ordering::Relaxed)
    }

}

/* --------------------------- 文件大小受控的写入 --------------------------- */

/// 追加写入，并保证文件不超过 `max_bytes`。
///
/// 流程：当前大小 + 本次内容 超过上限时，先按行边界把文件裁到上限的一半，
/// 再追加 —— 这样既不会出现「半个 UTF-8 字符 / 半行」，也不会每写一条都裁一次。
pub fn append_capped(path: &str, body: &str, max_bytes: u64) -> std::io::Result<()> {
    let need = body.len() as u64;
    if let Ok(md) = std::fs::metadata(path) {
        if md.len().saturating_add(need) > max_bytes {
            trim_file(path, max_bytes / 2)?;
        }
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(path)?;
    f.write_all(body.as_bytes())
}

/// 把文件裁剪到只保留尾部 `keep` 字节（**按行边界对齐**，绝不切出半行）。
///
/// 裁剪而不是删除：日志的价值全在「最近发生了什么」，丢最新的才是灾难。
pub fn trim_file(path: &str, keep: u64) -> std::io::Result<()> {
    let bytes = std::fs::read(path)?;
    if bytes.len() as u64 <= keep {
        return Ok(());
    }
    let start = bytes.len().saturating_sub(keep as usize);
    // 从候选位置向后找到第一个换行，裁到它之后 —— 保证留下来的第一行是完整的
    let mut cut = start;
    while cut < bytes.len() && bytes[cut] != b'\n' {
        cut += 1;
    }
    if cut >= bytes.len() {
        // 整个尾部没有换行（极端：一行超长日志）→ 整行保留，不做破坏性裁剪
        return Ok(());
    }
    cut += 1;
    std::fs::write(path, &bytes[cut..])
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64 as Counter;

    static TEST_ID: Counter = Counter::new(0);

    fn tmp_path(tag: &str) -> String {
        let n = TEST_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir()
            .join(format!("ringlog-test-{tag}-{}-{n}.log", std::process::id()))
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn ring_evicts_by_entry_count() {
        let ring = RingLog::new(3, 1024 * 1024);
        for i in 0..10 {
            ring.push(1000 + i as i64, "INF", &format!("m{i}"));
        }
        assert_eq!(ring.len(), 3, "条数上限生效");
        let (_, all) = ring.snapshot(0, 0);
        assert_eq!(all[0].msg, "m7");
        assert_eq!(all[2].msg, "m9", "保留的是最新的三条");
    }

    #[test]
    fn ring_evicts_by_bytes_even_when_few_entries() {
        // 3 条长消息就把字节上限撑爆 → 即使没到条数上限也要淘汰
        let ring = RingLog::new(100, 200);
        ring.push(1, "INF", &"x".repeat(100));
        ring.push(2, "INF", &"y".repeat(100));
        ring.push(3, "INF", &"z".repeat(100));
        assert!(ring.len() < 3, "字节上限应先触发淘汰");
        assert!(ring.bytes() <= 200);
    }

    #[test]
    fn snapshot_respects_since_and_limit() {
        let ring = RingLog::with_defaults();
        for i in 1..=5 {
            ring.push(i, "INF", &format!("m{i}"));
        }
        let (seq, all) = ring.snapshot(0, 0);
        assert_eq!(seq, 5);
        assert_eq!(all.len(), 5);
        let (_, since3) = ring.snapshot(3, 0);
        assert_eq!(since3.len(), 2, "只要 seq > 3 的");
        let (_, limited) = ring.snapshot(0, 2);
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[1].msg, "m5", "limit 时保留最新的");
    }

    #[test]
    fn byte_accounting_tracks_payload_size() {
        let ring = RingLog::with_defaults();
        assert_eq!(ring.len(), 0);
        assert_eq!(ring.bytes(), 0);
        ring.push(1, "INF", "hello");
        assert_eq!(ring.len(), 1);
        assert!(ring.bytes() > 0, "字节账要跟着记录走，否则字节上限失效");
    }

    #[test]
    fn append_capped_keeps_file_within_limit() {
        let p = tmp_path("append");
        let _ = std::fs::remove_file(&p);
        for i in 0..200 {
            append_capped(&p, &format!("[{i}] 发送者: 10086\n内容: 这是一条测试通知内容，用来把文件写大一点\n{}\n", "-".repeat(50)), 4096)
                .expect("写入应成功");
        }
        let size = std::fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        assert!(size <= 4096, "文件不得超过上限，实际 {size}");
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.contains("[199]"), "最新一条必须还在");
        assert!(!text.contains("[0]"), "最旧的应当已被裁掉");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn trim_never_cuts_a_line_in_half() {
        let p = tmp_path("trim");
        let mut body = String::new();
        for i in 0..50 {
            body.push_str(&format!("line-{i:02}-{}\n", "x".repeat(20)));
        }
        std::fs::write(&p, &body).unwrap();
        trim_file(&p, 200).unwrap();
        let text = std::fs::read_to_string(&p).unwrap();
        assert!(text.len() <= 200, "裁剪后不超过目标大小");
        assert!(text.ends_with('\n'), "结尾应完整");
        for line in text.lines() {
            assert!(line.starts_with("line-"), "不能有半行: {line}");
            assert_eq!(line.len(), 28, "每行应完整（line-NN + 20 个 x）: {line}");
        }
        assert!(text.contains("line-49"), "最新一行必须保留");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn trim_is_noop_when_already_small() {
        let p = tmp_path("noop");
        std::fs::write(&p, "tiny\n").unwrap();
        trim_file(&p, 4096).unwrap();
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "tiny\n");
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn defaults_are_sane() {
        assert!(DEFAULT_RING_ENTRIES > 0);
        assert!(DEFAULT_RING_BYTES > DEFAULT_RING_ENTRIES, "字节上限要容得下满额短消息");
        assert!(DEFAULT_MAX_LOG_FILE_BYTES >= 4096, "至少要能放下几十条通知");
    }
}
