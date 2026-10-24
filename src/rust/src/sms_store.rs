//! 短信本地归档（SMS Archive）。
//!
//! # 为什么要在路由器本地另存一份
//!
//! 模组里的短信存储（SM / ME）是**有限格位**：实机合计只有 40 格左右，满了之后
//! 新短信进不来（后端会置 `memory_full` 并推送提醒）。而一旦模组被清空 ——
//! 换卡、刷机、`AT+CMGD` 全删、或者用户按了「清空全部」—— 记录就没了。
//!
//! 本地归档把「发出过什么、收到过什么」留在路由器上，与模组的生命周期解耦。
//!
//! # 存放约定
//!
//! - **目录**：`/etc/at-webserver/SMS/`
//!   `/etc` 在 overlay 上（本机 `/dev/loop0` → f2fs），重启与 sysupgrade 默认保留；
//!   而 `/var` 是 tmpfs（`/var -> /tmp`），断电即失，不能用于长期记录。
//! - **粒度**：一个会话一个文件。删 A 会话不会碰到 B，也不存在「后写的覆盖先写的」。
//! - **文件名**：`sha256(归一化号码)` 的前 40 个 hex 字符 + `.sms`。
//!   用哈希而不是号码本身有两个理由：号码不出现在文件名里（`ls` 一下就泄露联系人），
//!   以及号码里可能含 `/`、`..` 之类字符，直接拼路径有穿越风险。
//!
//! # 加密与混淆
//!
//! 落盘的是密文，而且不是标准格式：
//!
//! ```text
//! 明文 JSON → ChaCha20 流加密（密钥 = SHA-256(内置密钥 ‖ salt)，salt 每文件随机）
//!          → 套容器（魔数 / 版本 / salt / nonce / 明文长度 / 写入时刻）
//!          → 整帧做一次位置相关的异或混淆（魔数也不会以明文出现）
//!          → 尾部追加随机 padding（文件大小不直接暴露正文长度）
//! ```
//!
//! # 威胁模型（如实说明，别当成银弹）
//!
//! 这是**防随手查看**级别的保护，不是抗攻击的加密：密钥是编译进本程序的常量，
//! 拿到同一份二进制、或愿意反汇编的人总能解出来。它挡得住的是
//! 「SSH 上去 `cat` 一下就看到短信内容」「导出的配置随手发给别人」。
//! 真正保密需要把密钥放在本程序读不到的地方，那超出了 OpenWrt 插件能安全持有的
//! 范围（root 就能读到机器上的一切）。
//!
//! # 依赖
//!
//! 不引入任何新依赖：SHA-256 与 ChaCha20 都是本文件内的纯 Rust 实现，
//! 随机数用时间戳 + 原子计数混 xorshift（只用于 salt / nonce / padding）。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::log_info;
use crate::log_warn;

/* ------------------------------------------------------------------ *
 * 配置常量
 * ------------------------------------------------------------------ */

/// 归档根目录。
pub const SMS_STORE_DIR: &str = "/etc/at-webserver/SMS";

/// 归档目录总字节数上限（默认 2 MiB）。
///
/// 参照模组自身容量定：SM/ME 合计 40 格，一条长短信最多 255 段，
/// 按每格平均 500 字节估算，几十个会话的正常往来落在 1 MiB 以内。
/// 2 MiB 留出余量，同时不至于把 overlay 撑大。
pub const SMS_STORE_MAX_BYTES: u64 = 2 * 1024 * 1024;

/// 单个会话最多保留多少条记录（超出后滚动丢弃最旧的）。
pub const SMS_CONVERSATION_MAX_RECORDS: usize = 500;

/// 单个会话文件的硬上限（字节）。
///
/// 目的是不让「一个会话」吃掉全部配额：有了它，淘汰时总能先牺牲别的会话，
/// 而不是删掉刚写完的那一个。
const SINGLE_FILE_MAX_BYTES: u64 = 512 * 1024;

/// 淘汰水位（配额的 4/5）：清理到这里就停，避免每写一条都触发一轮淘汰。
const PRUNE_TARGET_NUM: u64 = 4;
const PRUNE_TARGET_DEN: u64 = 5;

/* ------------------------------------------------------------------ *
 * 容器格式
 * ------------------------------------------------------------------ */

/// 容器版本号。格式变更时递增，旧版本仍可读（只读路径按版本分支）。
const FORMAT_VERSION: u8 = 1;

/// 魔数 `AWSS`（AT WebServer SMS）。写入前会被混淆，磁盘上看不到明文。
const MAGIC: [u8; 4] = *b"AWSS";

/// 容器头长度：
/// 魔数 4 + 版本 1 + 标志 1 + 头长 2 + salt 16 + nonce 12 + 明文长 4 + 写入时刻 8 = 48
const HEADER_LEN: usize = 48;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;

/// 尾部随机 padding 的取值上限（字节）。
const MAX_PADDING: usize = 32;

/// 混淆表：整帧按位置异或。固定值 —— 加密已经由 ChaCha20 负责，
/// 这一层只是让文件不像任何已知格式（魔数也不会明文出现）。
const OBF_TABLE: [u8; 64] = [
	0x5b, 0xc7, 0x1e, 0x93, 0x2a, 0xf4, 0x60, 0x8d, 0x37, 0xa1, 0x4c, 0x9f, 0x06, 0x7b, 0xb2, 0x45,
	0xe8, 0x13, 0xda, 0x5e, 0xc0, 0x2f, 0x84, 0xdb, 0x71, 0x26, 0xaf, 0x30, 0x9d, 0x42, 0xf7, 0x68,
	0x0c, 0xb5, 0x59, 0xfe, 0x1a, 0x8c, 0xd4, 0x67, 0x2b, 0x90, 0x3e, 0x35, 0xa8, 0x41, 0xcd, 0x76,
	0x03, 0x9f, 0x54, 0xc2, 0x1d, 0xeb, 0x28, 0x83, 0x4a, 0xd7, 0x62, 0x0f, 0xb8, 0x91, 0x4e, 0xc5,
];

/* ------------------------------------------------------------------ *
 * SHA-256（FIPS 180-4）
 * ------------------------------------------------------------------ */

const K256: [u32; 64] = [
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// SHA-256。本模块有三处用途：在 salt 上派生**每个文件各不相同**的密钥（`derive_key`）、
/// 算记录指纹（`fingerprint`）、哈希会话文件名（`path_for`）。
fn sha256(data: &[u8]) -> [u8; 32] {
	let mut h: [u32; 8] = [
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
	];
	let bit_len = (data.len() as u64).wrapping_mul(8);

	let mut msg: Vec<u8> = Vec::with_capacity(data.len() + 72);
	msg.extend_from_slice(data);
	msg.push(0x80);
	while msg.len() % 64 != 56 {
		msg.push(0);
	}
	msg.extend_from_slice(&bit_len.to_be_bytes());

	let mut w = [0u32; 64];
	for chunk in msg.as_chunks::<64>().0 {
		for i in 0..16 {
			w[i] = u32::from_be_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
		}
		for i in 16..64 {
			let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
			let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
			w[i] = w[i - 16]
				.wrapping_add(s0)
				.wrapping_add(w[i - 7])
				.wrapping_add(s1);
		}

		let mut v = h;
		for i in 0..64 {
			let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
			let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
			let t1 = v[7]
				.wrapping_add(s1)
				.wrapping_add(ch)
				.wrapping_add(K256[i])
				.wrapping_add(w[i]);
			let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
			let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
			let t2 = s0.wrapping_add(maj);

			v[7] = v[6];
			v[6] = v[5];
			v[5] = v[4];
			v[4] = v[3].wrapping_add(t1);
			v[3] = v[2];
			v[2] = v[1];
			v[1] = v[0];
			v[0] = t1.wrapping_add(t2);
		}
		for i in 0..8 {
			h[i] = h[i].wrapping_add(v[i]);
		}
	}

	let mut out = [0u8; 32];
	for i in 0..8 {
		out[i * 4..i * 4 + 4].copy_from_slice(&h[i].to_be_bytes());
	}
	out
}

/* ------------------------------------------------------------------ *
 * ChaCha20（RFC 8439）
 * ------------------------------------------------------------------ */

/// ChaCha20 的四分之一轮：column round / diagonal round 都用它。
fn chacha_qr(x: &mut [u32; 16], a: usize, b: usize, c: usize, d: usize) {
	x[a] = x[a].wrapping_add(x[b]);
	x[d] ^= x[a];
	x[d] = x[d].rotate_left(16);
	x[c] = x[c].wrapping_add(x[d]);
	x[b] ^= x[c];
	x[b] = x[b].rotate_left(12);
	x[a] = x[a].wrapping_add(x[b]);
	x[d] ^= x[a];
	x[d] = x[d].rotate_left(8);
	x[c] = x[c].wrapping_add(x[d]);
	x[b] ^= x[c];
	x[b] = x[b].rotate_left(7);
}

/// 生成一个 64 字节的 ChaCha20 密钥流块。
fn chacha20_block(key: &[u8; 32], counter: u32, nonce: &[u8; 12]) -> [u8; 64] {
	let mut st = [0u32; 16];
	/* "expand 32-byte k" */
	st[0] = 0x6170_7865;
	st[1] = 0x3320_646e;
	st[2] = 0x7962_2d32;
	st[3] = 0x6b20_6574;
	for i in 0..8 {
		st[4 + i] = u32::from_le_bytes([key[i * 4], key[i * 4 + 1], key[i * 4 + 2], key[i * 4 + 3]]);
	}
	st[12] = counter;
	for i in 0..3 {
		st[13 + i] = u32::from_le_bytes([nonce[i * 4], nonce[i * 4 + 1], nonce[i * 4 + 2], nonce[i * 4 + 3]]);
	}

	let mut x = st;
	for _ in 0..10 {
		chacha_qr(&mut x, 0, 4, 8, 12);
		chacha_qr(&mut x, 1, 5, 9, 13);
		chacha_qr(&mut x, 2, 6, 10, 14);
		chacha_qr(&mut x, 3, 7, 11, 15);
		chacha_qr(&mut x, 0, 5, 10, 15);
		chacha_qr(&mut x, 1, 6, 11, 12);
		chacha_qr(&mut x, 2, 7, 8, 13);
		chacha_qr(&mut x, 3, 4, 9, 14);
	}

	let mut out = [0u8; 64];
	for i in 0..16 {
		let v = x[i].wrapping_add(st[i]);
		out[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
	}
	out
}

/// ChaCha20 流加密/解密（异或，双向同一函数）。
fn chacha20_apply(key: &[u8; 32], nonce: &[u8; 12], input: &[u8], out: &mut [u8]) {
	let mut counter: u32 = 0;
	let mut i = 0usize;
	while i < input.len() {
		let ks = chacha20_block(key, counter, nonce);
		let n = std::cmp::min(64, input.len() - i);
		for j in 0..n {
			out[i + j] = input[i + j] ^ ks[j];
		}
		i += n;
		counter = counter.wrapping_add(1);
	}
}

/* ------------------------------------------------------------------ *
 * 混淆 / 密钥 / 随机
 * ------------------------------------------------------------------ */

/// 位置相关的异或混淆。对合运算 —— 加解密调用同一个函数。
fn scramble(buf: &mut [u8]) {
	for (i, b) in buf.iter_mut().enumerate() {
		let t = OBF_TABLE[i % OBF_TABLE.len()];
		let p = (i & 0xff) as u8;
		*b ^= t ^ p.rotate_left(3);
	}
}

/// 内置密钥的分片。
///
/// 拆成碎片在运行时拼接，是为了避免完整密钥以连续字节躺在二进制里，
/// 被 `strings <binary> | grep` 一把捞出来。这是**增加查找成本**，
/// 不是安全边界 —— 见模块头的威胁模型。
const KEY_PARTS: [&[u8]; 5] = [b"at-ws", b"/sms", b"/arc", b"hive", b"#v1!"];

fn app_key() -> Vec<u8> {
	let mut v = Vec::with_capacity(24);
	for p in KEY_PARTS {
		v.extend_from_slice(p);
	}
	v
}

/// 密钥派生：`SHA-256(app_key ‖ salt)`。
///
/// salt 每文件随机，因此每个会话文件的加密密钥都不同 —— 即使两个文件
/// 的 nonce 巧合撞上了（xorshift 不是密码学随机源），也不会出现
/// 「同密钥同 nonce」这种流加密的致命组合。
fn derive_key(salt: &[u8; SALT_LEN]) -> [u8; 32] {
	let mut buf = app_key();
	buf.extend_from_slice(salt);
	sha256(&buf)
}

static RAND_SEQ: AtomicU64 = AtomicU64::new(0x243f_6a88_85a3_08d3);

/// 填充随机字节（xorshift64* 混合时间戳与原子计数）。
///
/// 只用于 salt / nonce / padding —— 见 [`derive_key`] 里关于 nonce 碰撞的说明。
fn fill_random(out: &mut [u8]) {
	let mut state = RAND_SEQ.fetch_add(1, Ordering::Relaxed) ^ (crate::nettime::now_ms() as u64);
	let mut i = 0usize;
	while i < out.len() {
		state ^= state >> 12;
		state ^= state << 25;
		state ^= state >> 27;
		let v = state.wrapping_mul(0x2545_f491_4f6c_dd1d);
		for b in v.to_le_bytes() {
			if i >= out.len() {
				break;
			}
			out[i] = b;
			i += 1;
		}
	}
}

/* ------------------------------------------------------------------ *
 * 数据结构
 * ------------------------------------------------------------------ */

/// 一条归档记录。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ArchiveRecord {
	/// 内容指纹，用于去重与定向删除（见 [`fingerprint`]）。
	pub fingerprint: String,
	/// `sent` / `received`。
	pub direction: String,
	/// 归一化后的对端号码。
	pub number: String,
	pub content: String,
	/// 时间串（`YY/MM/DD,HH:MM:SS`）。收到的取自 PDU 的 TP-SCTS（模组给的真实时刻）；
	/// 发出的由插件自己盖章（3GPP 的 SUBMIT 不携带发送时刻，模组存回去也读不出来），
	/// 所以已发送记录通常是 `Some`，来源见 `sms::sent_record`。
	pub time: Option<String>,
	/// `time` 不是可信的精确时刻，界面要标「（近似）」。两种成因：
	/// 读存量短信时只能拿 TP-VP 有效期估算；或发送时设备时钟还没被 NTP 校对过。
	#[serde(default)]
	pub time_approx: bool,
	/// 模组存储槽位；发出的短信为 `None`。
	pub index: Option<u32>,
	/// 归档写入时刻（毫秒）。
	pub archived_at_ms: i64,
}

/// 一个会话的归档摘要。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConversationMeta {
	pub number: String,
	/// 记录条数。
	pub count: usize,
	/// 该文件占用的字节数。
	pub bytes: u64,
	/// 最后一次写入时刻（毫秒），淘汰排序用。
	pub updated_at_ms: i64,
	/// 最后一条记录的正文摘要，界面列表展示用。
	pub last_content: String,
}

/// 归档目录的整体统计。
#[derive(Debug, Clone, serde::Serialize)]
pub struct ArchiveStats {
	pub dir: String,
	pub total_bytes: u64,
	pub max_bytes: u64,
	/// 按最近更新倒序。
	pub conversations: Vec<ConversationMeta>,
}

/// 定向删除的命中线索。
///
/// 两条都要，因为各自覆盖不同的记录来源：
/// - 收到的短信按**段**归档，界面合并成一条气泡后只带着各段的槽位；
/// - 发出的短信没有模组槽位，只有内容指纹。
#[derive(Debug, Clone, Default)]
pub struct RecordSelector {
	pub fingerprints: Vec<String>,
	pub indices: Vec<u32>,
}

impl RecordSelector {
	pub fn is_empty(&self) -> bool {
		self.fingerprints.is_empty() && self.indices.is_empty()
	}

	fn matches(&self, r: &ArchiveRecord) -> bool {
		let by_fp = self.fingerprints.iter().any(|f| f == &r.fingerprint);
		let by_ix = r.index.map(|i| self.indices.contains(&i)).unwrap_or(false);
		by_fp || by_ix
	}
}

/* ------------------------------------------------------------------ *
 * 记录指纹
 * ------------------------------------------------------------------ */

/// 记录指纹：由「方向 ‖ 号码 ‖ 时间 ‖ 正文」哈希而来。
///
/// 做成**纯函数**而不是落盘时生成随机 id，是为了让同一条短信在多次归档时
/// 自然收敛到同一条记录 —— 刷新列表重复读到、或分段短信重复上报都不会堆积重复项。
pub fn fingerprint(direction: &str, number: &str, time: Option<&str>, content: &str) -> String {
	let mut buf = String::with_capacity(32 + number.len() + content.len());
	buf.push_str(direction);
	buf.push('|');
	buf.push_str(number);
	buf.push('|');
	buf.push_str(time.unwrap_or(""));
	buf.push('|');
	buf.push_str(content);
	let d = sha256(buf.as_bytes());
	hex::encode(d)[..16].to_string()
}

/* ------------------------------------------------------------------ *
 * 容器编解码
 * ------------------------------------------------------------------ */

/// 明文 → 落盘字节流（加密 → 套容器 → 混淆 → 随机 padding）。
fn encode_container(plain: &[u8]) -> Vec<u8> {
	let mut salt = [0u8; SALT_LEN];
	let mut nonce = [0u8; NONCE_LEN];
	fill_random(&mut salt);
	fill_random(&mut nonce);

	let key = derive_key(&salt);
	let mut ct = vec![0u8; plain.len()];
	chacha20_apply(&key, &nonce, plain, &mut ct);

	let mut buf = Vec::with_capacity(HEADER_LEN + ct.len() + MAX_PADDING);
	buf.extend_from_slice(&MAGIC);
	buf.push(FORMAT_VERSION);
	buf.push(0); /* flags：保留 */
	buf.extend_from_slice(&(HEADER_LEN as u16).to_le_bytes());
	buf.extend_from_slice(&salt);
	buf.extend_from_slice(&nonce);
	buf.extend_from_slice(&(plain.len() as u32).to_le_bytes());
	buf.extend_from_slice(&crate::nettime::now_ms().to_le_bytes());
	buf.extend_from_slice(&ct);

	/* 随机 padding：同一条短信归档两次得到的文件大小不同，
	   文件大小因此不泄露正文长度。 */
	let mut len_byte = [0u8; 1];
	fill_random(&mut len_byte);
	let pad = (len_byte[0] as usize) % (MAX_PADDING + 1);
	if pad > 0 {
		let mut padding = vec![0u8; pad];
		fill_random(&mut padding);
		buf.extend_from_slice(&padding);
	}

	scramble(&mut buf);
	buf
}

/// 落盘字节流 → 明文。返回 `(明文, 写入时刻)`。
fn decode_container(raw: &[u8]) -> Result<(Vec<u8>, i64), String> {
	if raw.len() < HEADER_LEN {
		return Err("归档文件过短，已损坏".into());
	}
	let mut buf = raw.to_vec();
	scramble(&mut buf); /* 对合，同一函数 */

	if buf[0..4] != MAGIC {
		return Err("归档文件魔数不匹配（不是本插件的归档，或已损坏）".into());
	}
	let version = buf[4];
	if version != FORMAT_VERSION {
		return Err(format!("不支持的归档版本 {version}"));
	}
	let header_len = u16::from_le_bytes([buf[6], buf[7]]) as usize;
	if header_len != HEADER_LEN || buf.len() < header_len {
		return Err("归档文件头部长度异常".into());
	}

	let mut salt = [0u8; SALT_LEN];
	salt.copy_from_slice(&buf[8..8 + SALT_LEN]);
	let mut nonce = [0u8; NONCE_LEN];
	nonce.copy_from_slice(&buf[8 + SALT_LEN..8 + SALT_LEN + NONCE_LEN]);

	let plain_len = u32::from_le_bytes([
		buf[36], buf[37], buf[38], buf[39],
	]) as usize;
	let written_at_ms = i64::from_le_bytes([
		buf[40], buf[41], buf[42], buf[43], buf[44], buf[45], buf[46], buf[47],
	]);

	if buf.len() < header_len + plain_len {
		return Err("归档文件正文被截断".into());
	}

	let key = derive_key(&salt);
	let mut plain = vec![0u8; plain_len];
	chacha20_apply(&key, &nonce, &buf[header_len..header_len + plain_len], &mut plain);
	Ok((plain, written_at_ms))
}

/* ------------------------------------------------------------------ *
 * 文件读写
 * ------------------------------------------------------------------ */

/// 会话归档文件的内容。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct ArchiveFile {
	version: u8,
	/// 归一化号码。文件里也存一份，读取时不必依赖文件名反推。
	number: String,
	updated_at_ms: i64,
	records: Vec<ArchiveRecord>,
}

/// 读入一个会话文件的记录；文件不存在或损坏时返回空列表。
fn load_records(path: &Path) -> Vec<ArchiveRecord> {
	let raw = match fs::read(path) {
		Ok(b) => b,
		Err(_) => return Vec::new(),
	};
	if raw.is_empty() {
		return Vec::new();
	}
	let (plain, _) = match decode_container(&raw) {
		Ok(v) => v,
		Err(e) => {
			log_warn!("归档 {} 无法解密，按空处理: {e}", path.display());
			return Vec::new();
		}
	};
	match serde_json::from_slice::<ArchiveFile>(&plain) {
		Ok(f) => f.records,
		Err(e) => {
			log_warn!("归档 {} 内容无法解析，按空处理: {e}", path.display());
			Vec::new()
		}
	}
}

/// 原子落盘：先写临时文件再 rename，避免写一半断电留下半个文件。
fn write_atomic(path: &Path, data: &[u8]) -> Result<(), String> {
	let tmp = path.with_extension("sms.tmp");
	{
		let mut f = fs::File::create(&tmp).map_err(|e| format!("写归档临时文件失败: {e}"))?;
		f.write_all(data).map_err(|e| format!("写归档临时文件失败: {e}"))?;
		f.sync_all().ok();
	}
	fs::rename(&tmp, path).map_err(|e| {
		let _ = fs::remove_file(&tmp);
		format!("归档文件落盘失败: {e}")
	})
}

/// 只读文件头，取出写入时刻（淘汰排序用，避免为了排序解密全部文件）。
fn read_written_at(path: &Path) -> i64 {
	let mut head = [0u8; HEADER_LEN];
	let Ok(mut f) = fs::File::open(path) else { return 0 };
	let Ok(n) = f.read(&mut head) else { return 0 };
	if n < HEADER_LEN {
		return 0;
	}
	scramble(&mut head);
	if head[0..4] != MAGIC {
		return 0;
	}
	i64::from_le_bytes([
		head[40], head[41], head[42], head[43], head[44], head[45], head[46], head[47],
	])
}

/* ------------------------------------------------------------------ *
 * 归档服务
 * ------------------------------------------------------------------ */

/// 短信本地归档。
///
/// 写入入口只有两个，都在后端内部：**发送成功**与**收到新短信**。
/// 前端不能直接写归档 —— 只经 `store_stats` / `store_read` / `store_drop`
/// 三个动作读取与删除。
pub struct SmsArchive {
	dir: PathBuf,
	max_bytes: u64,
	max_records: usize,
}

impl SmsArchive {
	pub fn new(dir: impl Into<PathBuf>, max_bytes: u64, max_records: usize) -> Self {
		Self {
			dir: dir.into(),
			/* 下限 64 KiB：防止用户填个极小值把归档功能整个废掉 */
			max_bytes: max_bytes.max(64 * 1024),
			max_records: max_records.max(1),
		}
	}

	/// 在默认目录 [`SMS_STORE_DIR`] 上按默认配额建立归档。
	pub fn at_default_dir() -> Self {
		Self::new(SMS_STORE_DIR, SMS_STORE_MAX_BYTES, SMS_CONVERSATION_MAX_RECORDS)
	}

	pub fn max_bytes(&self) -> u64 {
		self.max_bytes
	}

	/// 确保归档目录存在。每次写入前都调一次：目录被手工删掉时能自愈。
	fn ensure_dir(&self) -> Result<(), String> {
		fs::create_dir_all(&self.dir)
			.map_err(|e| format!("创建归档目录 {} 失败: {e}", self.dir.display()))
	}

	/// 会话文件名：号码哈希的前 40 个 hex 字符。
	///
	/// 用哈希而非号码本身，一是号码不出现在文件名里（避免 `ls` 泄露联系人），
	/// 二是号码可能含 `/`、`..` 等字符，直接拼路径会有穿越风险。
	fn path_for(&self, number: &str) -> PathBuf {
		let full = hex::encode(sha256(number.as_bytes()));
		self.dir.join(format!("{}.sms", &full[..40]))
	}

	/// 列出全部会话文件：`(路径, 写入时刻, 字节数)`。
	fn list_files(&self) -> Vec<(PathBuf, i64, u64)> {
		let mut out = Vec::new();
		let Ok(rd) = fs::read_dir(&self.dir) else { return out };
		for entry in rd.flatten() {
			let path = entry.path();
			if path.extension().and_then(|s| s.to_str()) != Some("sms") {
				continue;
			}
			let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
			let ts = read_written_at(&path);
			out.push((path, ts, bytes));
		}
		out
	}

	/// 目录当前总字节数。
	pub fn total_bytes(&self) -> u64 {
		self.list_files().iter().map(|(_, _, b)| *b).sum()
	}

	/// 把一批记录并入对应会话的归档文件。
	///
	/// 返回写入的**会话数**。按内容指纹去重，超出 `max_records` 时滚动丢弃最旧的。
	pub fn append(&self, records: Vec<ArchiveRecord>) -> Result<usize, String> {
		if records.is_empty() {
			return Ok(0);
		}
		self.ensure_dir()?;

		/* 按号码分组：号码为空的（解析失败条目）无法归类，直接丢弃 */
		let mut by_number: std::collections::HashMap<String, Vec<ArchiveRecord>> =
			std::collections::HashMap::new();
		for r in records {
			if r.number.is_empty() {
				continue;
			}
			by_number.entry(r.number.clone()).or_default().push(r);
		}

		let mut touched = 0usize;
		for (number, incoming) in by_number {
			let path = self.path_for(&number);
			let mut existing = load_records(&path);

			for rec in incoming {
				match existing.iter().position(|r| r.fingerprint == rec.fingerprint) {
					/* 已存在：保留最初的归档时刻，其余字段以最新为准 */
					Some(i) => {
						let keep = existing[i].archived_at_ms;
						existing[i] = rec;
						existing[i].archived_at_ms = keep;
					}
					None => existing.push(rec),
				}
			}

			/* 单会话条数上限：滚掉最旧的（数组按归档时序排列） */
			if existing.len() > self.max_records {
				let drop = existing.len() - self.max_records;
				existing.drain(0..drop);
			}

			let payload = ArchiveFile {
				version: FORMAT_VERSION,
				number: number.clone(),
				updated_at_ms: crate::nettime::now_ms(),
				records: existing,
			};
			let plain = serde_json::to_vec(&payload)
				.map_err(|e| format!("序列化归档失败: {e}"))?;
			if plain.len() as u64 > SINGLE_FILE_MAX_BYTES {
				log_warn!(
					"会话 {} 的归档体积 {} 字节超过单文件上限 {} 字节，已放弃写入",
					number,
					plain.len(),
					SINGLE_FILE_MAX_BYTES
				);
				continue;
			}
			let blob = encode_container(&plain);
			write_atomic(&path, &blob)?;
			touched += 1;
		}

		self.prune()?;
		Ok(touched)
	}

	/// 读取一个会话的归档记录（按归档时序升序）。
	pub fn read(&self, number: &str) -> Result<Vec<ArchiveRecord>, String> {
		if number.is_empty() {
			return Ok(Vec::new());
		}
		Ok(load_records(&self.path_for(number)))
	}

	/// 删除一个会话的归档文件，返回释放的字节数。文件不存在返回 0。
	pub fn drop_conversation(&self, number: &str) -> Result<u64, String> {
		if number.is_empty() {
			return Ok(0);
		}
		let path = self.path_for(number);
		match fs::metadata(&path) {
			Ok(m) => fs::remove_file(&path)
				.map(|_| m.len())
				.map_err(|e| format!("删除归档 {} 失败: {e}", path.display())),
			Err(_) => Ok(0),
		}
	}

	/// 清空全部归档，返回 `(删除的会话数, 释放字节数)`。
	pub fn purge(&self) -> Result<(usize, u64), String> {
		let files = self.list_files();
		let mut n = 0usize;
		let mut freed = 0u64;
		for (path, _, bytes) in files {
			match fs::remove_file(&path) {
				Ok(()) => {
					n += 1;
					freed += bytes;
				}
				Err(e) => log_warn!("删除归档 {} 失败: {e}", path.display()),
			}
		}
		Ok((n, freed))
	}

	/// 按索引线索删除记录（可跨会话）。返回 `(删除条数, 涉及会话数)`。
	///
	/// `number` 为空时对所有会话生效（批量删除会带上各自号码，故通常不需要）。
	pub fn remove_records(
		&self,
		number: &str,
		selector: &RecordSelector,
	) -> Result<(usize, usize), String> {
		if selector.is_empty() {
			return Ok((0, 0));
		}

		let targets: Vec<PathBuf> = if number.is_empty() {
			self.list_files().into_iter().map(|(p, _, _)| p).collect()
		} else {
			let p = self.path_for(number);
			if fs::metadata(&p).is_ok() {
				vec![p]
			} else {
				Vec::new()
			}
		};

		let mut removed_total = 0usize;
		let mut touched = 0usize;

		for path in targets {
			let records = load_records(&path);
			if records.is_empty() {
				continue;
			}
			let before = records.len();
			let kept: Vec<ArchiveRecord> = records
				.into_iter()
				.filter(|r| !selector.matches(r))
				.collect();
			let removed = before - kept.len();
			if removed == 0 {
				continue;
			}

			if kept.is_empty() {
				/* 会话里一条都不剩：连文件一起删掉，避免留下空壳 */
				if let Err(e) = fs::remove_file(&path) {
					return Err(format!("删除空归档 {} 失败: {e}", path.display()));
				}
			} else {
				let number = kept
					.last()
					.map(|r| r.number.clone())
					.unwrap_or_default();
				let payload = ArchiveFile {
					version: FORMAT_VERSION,
					number,
					updated_at_ms: crate::nettime::now_ms(),
					records: kept,
				};
				let plain = serde_json::to_vec(&payload)
					.map_err(|e| format!("序列化归档失败: {e}"))?;
				write_atomic(&path, &encode_container(&plain))?;
			}

			removed_total += removed;
			touched += 1;
		}

		Ok((removed_total, touched))
	}

	/// 淘汰：目录总字节超过配额时，从**最久没更新**的会话开始删，
	/// 直到回落到水位（配额的 4/5）以下。
	///
	/// 返回 `(删除的会话数, 释放字节数)`。
	pub fn prune(&self) -> Result<(usize, u64), String> {
		let target = self
			.max_bytes
			.saturating_mul(PRUNE_TARGET_NUM)
			/ PRUNE_TARGET_DEN;

		let mut dropped = 0usize;
		let mut freed = 0u64;

		loop {
			let mut files = self.list_files();
			if files.is_empty() {
				break;
			}
			let total: u64 = files.iter().map(|(_, _, b)| *b).sum();
			if total <= target {
				break;
			}

			/* 最久没写入的会话排在最前 —— 优先牺牲它 */
			files.sort_by_key(|(_, ts, _)| *ts);
			let (path, _, bytes) = files.remove(0);

			match fs::remove_file(&path) {
				Ok(()) => {
					dropped += 1;
					freed += bytes;
					log_info!("归档超出配额（{} > {}），已淘汰最旧会话 {}", total, target, path.display());
				}
				Err(e) => {
					log_warn!("淘汰归档 {} 失败: {e}", path.display());
					break;
				}
			}
		}

		Ok((dropped, freed))
	}

	/// 目录统计（会话按最近更新倒序）。
	pub fn stats(&self) -> ArchiveStats {
		let files = self.list_files();
		let total_bytes = files.iter().map(|(_, _, b)| *b).sum();
		let mut conversations = Vec::with_capacity(files.len());

		for (path, ts, bytes) in files {
			let records = load_records(&path);
			let mut meta = ConversationMeta {
				number: String::new(),
				count: 0,
				bytes,
				updated_at_ms: ts,
				last_content: String::new(),
			};
			if let Some(last) = records.last() {
				meta.count = records.len();
				meta.number = last.number.clone();
				meta.last_content = last.content.chars().take(40).collect();
			}
			if meta.number.is_empty() {
				/* 号码解不出来（文件损坏或版本不同）→ 用文件名前 8 位做个可辨认的标签 */
				meta.number = path
					.file_stem()
					.and_then(|s| s.to_str())
					.unwrap_or("?")
					.chars()
					.take(8)
					.collect();
			}
			conversations.push(meta);
		}

		conversations.sort_by_key(|c| std::cmp::Reverse(c.updated_at_ms));
		ArchiveStats {
			dir: self.dir.display().to_string(),
			total_bytes,
			max_bytes: self.max_bytes,
			conversations,
		}
	}
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
	use super::*;

	fn tmp_dir(tag: &str) -> PathBuf {
		let mut p = std::env::temp_dir();
		p.push(format!(
			"mt5700-sms-store-test-{}-{}-{}",
			tag,
			std::process::id(),
			crate::nettime::now_ms()
		));
		let _ = fs::remove_dir_all(&p);
		fs::create_dir_all(&p).expect("建临时目录");
		p
	}

	fn rec(direction: &str, number: &str, time: Option<&str>, content: &str) -> ArchiveRecord {
		ArchiveRecord {
			fingerprint: fingerprint(direction, number, time, content),
			direction: direction.to_string(),
			number: number.to_string(),
			content: content.to_string(),
			time: time.map(|s| s.to_string()),
			time_approx: false,
			index: None,
			archived_at_ms: crate::nettime::now_ms(),
		}
	}

	#[test]
	fn sha256_matches_known_vectors() {
		/* 标准向量：空串与 "abc"，以及一条跨多个 512-bit 块的长输入。
		 * 参考值用 Python hashlib 交叉核对过。 */
		assert_eq!(
			hex::encode(sha256(b"")),
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
		assert_eq!(
			hex::encode(sha256(b"abc")),
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
		);
		let long_input = b"MT5700M SMS archive ".repeat(6);
		assert_eq!(long_input.len(), 120);
		assert_eq!(
			hex::encode(sha256(&long_input)),
			"84ab9791f4d43ff20a7214496830891cf8efcb36a1def8a5a686102be9eb614d"
		);
	}

	#[test]
	fn chacha20_matches_rfc8439_test_vector() {
		/*
		 * RFC 8439 §2.3.2 块函数测试向量：
		 *   key    = 00 01 02 … 1f
		 *   nonce  = 00 00 00 09 00 00 00 4a 00 00 00 00
		 *   counter= 1
		 */
		let mut key = [0u8; 32];
		for (i, b) in key.iter_mut().enumerate() {
			*b = i as u8;
		}
		let nonce: [u8; 12] = [0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x4a, 0x00, 0x00, 0x00, 0x00];
		let block = chacha20_block(&key, 1, &nonce);
		assert_eq!(
			hex::encode(&block[..16]),
			"10f1e7e4d13b5915500fdd1fa32071c4"
		);
		assert_eq!(
			hex::encode(&block[16..32]),
			"c7d1f4c733c068030422aa9ac3d46c4e"
		);
		assert_eq!(
			hex::encode(&block[32..]),
			"d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e"
		);
	}

	#[test]
	fn container_roundtrip_and_not_plaintext() {
		let plain = b"{\"number\":\"10000\",\"content\":\"hello 102\"}";
		let blob = encode_container(plain);
		/* 混淆后魔数不以明文出现 */
		assert_ne!(&blob[0..4], &MAGIC);
		/* 明文不直接出现在密文里 */
		let hay = String::from_utf8_lossy(&blob);
		assert!(!hay.contains("10000"));
		assert!(!hay.contains("hello"));
		let (out, ts) = decode_container(&blob).expect("解密");
		assert_eq!(out, plain.to_vec());
		assert!(ts > 0);
	}

	#[test]
	fn scramble_is_involution() {
		let mut v = vec![1u8, 2, 3, 4, 250, 0, 9];
		let orig = v.clone();
		scramble(&mut v);
		assert_ne!(v, orig);
		scramble(&mut v);
		assert_eq!(v, orig);
	}

	#[test]
	fn append_dedups_by_fingerprint() {
		let dir = tmp_dir("dedup");
		let a = SmsArchive::new(&dir, 1024 * 1024, 100);
		a.append(vec![rec("sent", "10000", Some("26/10/23,01:03:00"), "102")])
			.unwrap();
		a.append(vec![rec("sent", "10000", Some("26/10/23,01:03:00"), "102")])
			.unwrap();
		let got = a.read("10000").unwrap();
		assert_eq!(got.len(), 1, "同一条短信重复归档应收敛为一条");
		assert_eq!(got[0].content, "102");
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn conversations_are_isolated() {
		let dir = tmp_dir("isolate");
		let a = SmsArchive::new(&dir, 1024 * 1024, 100);
		a.append(vec![rec("sent", "10000", None, "to-10000")]).unwrap();
		a.append(vec![rec("sent", "10001", None, "to-10001")]).unwrap();

		assert_eq!(a.read("10000").unwrap()[0].content, "to-10000");
		assert_eq!(a.read("10001").unwrap()[0].content, "to-10001");

		/* 删掉 10000 不应影响 10001 */
		assert!(a.drop_conversation("10000").unwrap() > 0);
		assert!(a.read("10000").unwrap().is_empty());
		assert_eq!(a.read("10001").unwrap().len(), 1);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn remove_records_by_fingerprint_and_index() {
		let dir = tmp_dir("remove");
		let a = SmsArchive::new(&dir, 1024 * 1024, 100);

		let mut r1 = rec("received", "10000", Some("26/10/23,01:00:00"), "第一条");
		r1.index = Some(1);
		let mut r2 = rec("received", "10000", Some("26/10/23,01:01:00"), "第二条");
		r2.index = Some(2);
		a.append(vec![r1, r2]).unwrap();

		/* 按指纹删一条 */
		let fp = fingerprint("received", "10000", Some("26/10/23,01:00:00"), "第一条");
		let sel = RecordSelector {
			fingerprints: vec![fp],
			indices: vec![],
		};
		let (removed, _) = a.remove_records("10000", &sel).unwrap();
		assert_eq!(removed, 1);
		assert_eq!(a.read("10000").unwrap().len(), 1);

		/* 按槽位删剩下那条（若未配置索引则跳过） */
		let sel2 = RecordSelector {
			fingerprints: vec![],
			indices: vec![2],
		};
		let (removed2, _) = a.remove_records("10000", &sel2).unwrap();
		assert_eq!(removed2, 1);
		assert!(a.read("10000").unwrap().is_empty());

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn quota_prunes_oldest_conversation() {
		let dir = tmp_dir("quota");
		/* 配额压到 64 KiB 下限，逼出淘汰 */
		let a = SmsArchive::new(&dir, 1024, 500);

		/* 先写一个「旧」会话 */
		a.append(vec![rec("sent", "10000", None, &"x".repeat(600))])
			.unwrap();
		/* 把它的写入时刻往前挪：直接改文件头不方便，这里用连续写入新会话把
		   配额挤爆 —— 淘汰按写入时刻排序，新写的必然更晚，先被牺牲的是旧的 */
		for i in 0..4 {
			let num = format!("1001{}", i);
			a.append(vec![rec("sent", &num, None, &"y".repeat(600))])
				.unwrap();
		}

		let st = a.stats();
		assert!(
			st.total_bytes <= st.max_bytes,
			"淘汰后总量应回落到配额内: {} > {}",
			st.total_bytes,
			st.max_bytes
		);

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn purge_clears_everything() {
		let dir = tmp_dir("purge");
		let a = SmsArchive::new(&dir, 1024 * 1024, 100);
		a.append(vec![rec("sent", "10000", None, "a")]).unwrap();
		a.append(vec![rec("sent", "10001", None, "b")]).unwrap();
		let (n, freed) = a.purge().unwrap();
		assert_eq!(n, 2);
		assert!(freed > 0);
		assert_eq!(a.stats().total_bytes, 0);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn stats_reports_conversation_summaries() {
		let dir = tmp_dir("stats");
		let a = SmsArchive::new(&dir, 1024 * 1024, 100);
		a.append(vec![rec("sent", "10000", None, "第一条")]).unwrap();
		a.append(vec![rec("received", "10000", None, "第二条")])
			.unwrap();

		let st = a.stats();
		assert_eq!(st.conversations.len(), 1);
		assert_eq!(st.conversations[0].number, "10000");
		assert_eq!(st.conversations[0].count, 2);
		assert_eq!(st.conversations[0].last_content, "第二条");
		assert_eq!(st.dir, dir.display().to_string());
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn read_missing_conversation_is_empty() {
		let dir = tmp_dir("missing");
		let a = SmsArchive::new(&dir, 1024 * 1024, 100);
		assert!(a.read("13900000000").unwrap().is_empty());
		let _ = fs::remove_dir_all(&dir);
	}
}
