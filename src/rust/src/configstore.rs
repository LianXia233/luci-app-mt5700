//! JSON 扁平键值配置存储（Debian 分支专用，替代 OpenWrt UCI）。
//!
//! - 配置文件路径：环境变量 `MT5700_CONFIG` 优先，默认 `/etc/mt5700/config.json`。
//! - 键名为扁平字符串键（如 `serial_port`、
//!   `schedule_night_lte_bands`），前端页面与后端读取逻辑无需感知迁移。
//! - 值一律为字符串，与 UCI 的文本语义保持一致，避免类型歧义。
//!
//! 并发安全：所有读改写都经过进程内互斥锁 + 「读文件 → 合并 → 写临时文件 →
//! 原子改名」序列，防止并发保存互相覆盖。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub type ConfigMap = BTreeMap<String, String>;

static LOCK: Mutex<()> = Mutex::new(());

/// 配置文件路径。测试与多实例场景可用 MT5700_CONFIG 覆盖。
pub fn config_path() -> PathBuf {
    if let Ok(p) = std::env::var("MT5700_CONFIG") {
        if !p.trim().is_empty() {
            return PathBuf::from(p);
        }
    }
    PathBuf::from("/etc/mt5700/config.json")
}

fn spawn_blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> tokio::task::JoinHandle<T> {
    tokio::task::spawn_blocking(f)
}

/// 读取整个配置映射。文件不存在视为空映射（全部走默认值），解析失败报错。
pub async fn read_map() -> Result<ConfigMap, String> {
    let path = config_path();
    spawn_blocking(move || {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        read_map_unlocked(&path)
    })
    .await
    .map_err(|e| format!("配置读取任务失败: {e}"))?
}

fn read_map_unlocked(path: &std::path::Path) -> Result<ConfigMap, String> {
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(ConfigMap::new()),
        Err(e) => return Err(format!("读取 {} 失败: {e}", path.display())),
    };
    let raw: serde_json::Map<String, serde_json::Value> =
        serde_json::from_slice(&data).map_err(|e| format!("解析 {} 失败: {e}", path.display()))?;
    let mut out = ConfigMap::new();
    for (k, v) in raw {
        let s = match v {
            serde_json::Value::String(s) => s,
            serde_json::Value::Null => continue,
            other => other.to_string(),
        };
        out.insert(k, s);
    }
    Ok(out)
}

/// 合并写入：patch 里的键覆盖，其余保留。空字符串值同样落盘（显式清空的语义）。
pub async fn update(patch: ConfigMap) -> Result<ConfigMap, String> {
    let path = config_path();
    spawn_blocking(move || {
        let _g = LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = read_map_unlocked(&path)?;
        for (k, v) in patch {
            map.insert(k, v);
        }
        write_map_unlocked(&path, &map)?;
        Ok(map)
    })
    .await
    .map_err(|e| format!("配置写入任务失败: {e}"))?
}

fn write_map_unlocked(path: &std::path::Path, map: &ConfigMap) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes()).map_err(|e| format!("写入 {} 失败: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("原子替换 {} 失败: {e}", path.display()))?;
    Ok(())
}

/// 便捷读取：取字符串键（缺失返回默认值）。
pub async fn get_str(key: &str, def: &str) -> String {
    match read_map().await {
        Ok(map) => map.get(key).cloned().unwrap_or_else(|| def.to_string()),
        Err(_) => def.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let dir = std::env::temp_dir().join(format!("mt5700-cfgtest-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("config.json");
        std::env::set_var("MT5700_CONFIG", &path);

        let mut patch = ConfigMap::new();
        patch.insert("serial_port".to_string(), "/dev/ttyUSB1".to_string());
        patch.insert("http_port".to_string(), "9000".to_string());
        let map = tokio::runtime::Runtime::new().unwrap().block_on(update(patch)).unwrap();
        assert_eq!(map.get("serial_port").unwrap(), "/dev/ttyUSB1");

        let map2 = tokio::runtime::Runtime::new().unwrap().block_on(read_map()).unwrap();
        assert_eq!(map2.get("http_port").unwrap(), "9000");
        assert!(!map2.contains_key("nope"));

        std::fs::remove_dir_all(&dir).ok();
        std::env::remove_var("MT5700_CONFIG");
    }
}
