//! at-webserver —— MT5700M 5G 模组 AT 服务（Rust 实现）。
//!
//! 完整业务逻辑迁移：
//! - AT 客户端（网络/串口/自动探测）
//! - LuCI RPC 服务（rpcd ucode 代理 → 本地 TCP newline-JSON）
//! - 定时锁频调度、小区扫频、短信/来电/信号通知、企业微信推送

mod async_runtime;
mod at_queue;
mod atclient;
mod config;
mod logger;
mod localtime;
mod monthly;
mod nettime;
mod notify;
mod pdu;
mod qqbind;
mod qqpush;
mod ringlog;
mod rpcserver;
mod schedconfig;
mod schedule;
// 串口模块仅 Linux 可用（termios/AsyncFd），非 Linux 平台条件编译掉，
// 便于在其它宿主上构建与跑单元测试。
#[cfg(target_os = "linux")]
mod serial_linux;
#[cfg(target_os = "linux")]
mod serialdetect;
mod signalgrade;
mod signalwatch;
mod sms;
mod sms_store;
mod state;
mod state_cfg;
mod timerpush;
mod transport;
mod urc;
mod usage;

use crate::config::Config;
use crate::notify::Notifier;
use crate::rpcserver::RpcServer;
use crate::schedule::Scheduler;
use crate::signalwatch::SignalWatcher;
use crate::timerpush::TimerPusher;
use crate::urc::{Broadcaster, Dispatcher};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

/// 版本号取自 Cargo 包元数据，构建时编译进二进制。
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "-version" || a == "--version") {
        println!("at-webserver {} (rustc {})", VERSION, rustc_version());
        return;
    }
    let verbose = args.iter().any(|a| a == "-verbose" || a == "--verbose");

    crate::logger::set_level(crate::logger::Level::Info);
    if verbose {
        crate::logger::set_level(crate::logger::Level::Debug);
    }

    if let Err(e) = run(verbose).await {
        log_error!("服务退出: {}", e);
        std::process::exit(1);
    }
}

fn rustc_version() -> &'static str {
    option_env!("RUSTC_VERSION").unwrap_or("stable")
}

async fn run(verbose: bool) -> Result<(), String> {
    log_info!("at-webserver {} 启动中 (pid {})", VERSION, std::process::id());
    // 时间源必须最早初始化：它会按系统时区设置（/etc/TZ → uci）确定本地偏移，
    // 并写回 TZ 环境变量，供后续 libc / 子进程一致使用。
    // 必须在任何会读时间/落日志的业务任务之前调用，故放在这里、而非各任务内部懒加载
    // （`#[tokio::main]` 已经建好运行时线程，靠的是启动顺序而非语言级保证）。
    crate::localtime::init();

    let cfg = config::load_config().await;
    if !cfg.enabled {
        log_warn!("服务在配置中被禁用，退出");
        return Ok(());
    }
    log_config(&cfg);
    log_info!(
        "当前时间: {}（来源 {}，时区 {}）",
        crate::nettime::now().format("%Y-%m-%d %H:%M:%S"),
        crate::nettime::source_name(),
        crate::localtime::describe()
    );

    // 关闭信号：SIGINT / SIGTERM 触发优雅退出。
    let (ctx_tx, ctx_rx) = watch::channel(false);

    // AT 客户端 + 主动上报通道。
    let (urc_tx, urc_rx) = tokio::sync::mpsc::channel(256);
    let client = atclient::AtClient::new(cfg.at.clone(), urc_tx);

    let (notifier, notif_rx) = Notifier::new(cfg.notification.clone());
    let notifier = Arc::new(notifier);
    let scheduler = Scheduler::new(cfg.schedule.clone(), client.clone(), notifier.clone(), ctx_rx.clone());

    // 异步状态缓存：后台按各指令刷新周期预热只读状态查询，
    // RPC 走缓存毫秒级返回，避免前端每次刷新都发一串会排队的 AT。
    let cache = crate::state::StateCache::new(client.clone(), ctx_rx.clone());
    let tasks = crate::async_runtime::TaskManager::with_cap(32);
    // 使用量后台统计：常驻周期采样，与前端是否打开无关。
    let usage = crate::usage::UsageTracker::new(cfg.usage_reset_day);
    // 短信业务：与 AT 客户端共用同一条通道，短信操作享有最高优先级。
    let sms = crate::sms::SmsService::new(client.clone(), ctx_rx.clone(), client.sms_mode());
    // 短信本地归档：发送成功与收到新短信时由后端落盘，
    // 与模组格位的生命周期解耦（见 sms_store 模块头）。
    let sms_archive = std::sync::Arc::new(crate::sms_store::SmsArchive::at_default_dir());
    sms.set_archive(sms_archive.clone());
    let mut rpc = RpcServer::new(
        client.clone(),
        cfg.websocket.auth_key.clone(),
        scheduler.clone(),
        ctx_rx.clone(),
        cache.clone(),
        tasks.clone(),
        notifier.clone(),
        usage.clone(),
        sms.clone(),
    );
    // QQ 绑定进度：bind 模式下由绑定任务更新，LuCI 经 qq_bind_status 轮询展示倒计时
    let qq_bind_status = std::sync::Arc::new(crate::qqbind::BindStatus::default());
    rpc.set_bind_status(qq_bind_status.clone());
    rpc.set_scan_timeout(cfg.websocket.scan_timeout);
    // 归档句柄注入 RPC：让短信中心页能读统计、看归档、删归档。
    rpc.set_archive(sms_archive.clone());
    let rpc = Arc::new(rpc);

    // 上报分发：Broadcast 走事件总线，前端轮询 events(since) 拉取。
    let hub = rpc.hub();
    let broadcaster: Broadcaster = Arc::new(move |v: serde_json::Value| hub.broadcast(&v));

    log_info!("启动完成，LuCI RPC 127.0.0.1:{}（经 rpcd/ucode 代理，不对外暴露）", cfg.websocket.port);
    if !verbose {
        // 稳态只留警告和错误，避免刷满 procd 日志。
        crate::logger::set_level(crate::logger::Level::Warn);
    }

    // 后台任务
    let client_task = tokio::spawn({
        let client = client.clone();
        let ctx = ctx_rx.clone();
        async move { client.run(ctx).await }
    });
    let notify_task = tokio::spawn({
        let notifier = notifier.clone();
        let ctx = ctx_rx.clone();
        async move { notifier.run(notif_rx, ctx).await }
    });

    // QQ 机器人「绑定模式」：目标类型为 bind 时，后台连网关等用户发消息，
    // 拿到 openid 写回 UCI 并热替换推送通道（无需重启）。
    if cfg.notification.qq.target_type == "bind" {
        let q = cfg.notification.qq.clone();
        if !q.enabled {
            log_warn!("QQ 推送开关未开启（qq_enabled=0），跳过绑定");
        } else if q.app_id.is_empty() || q.app_secret.is_empty() {
            log_error!("QQ 绑定模式缺少 AppID/AppSecret，跳过绑定");
        } else {
            if q.bind_qq.trim().is_empty() {
                log_warn!("QQ 绑定模式未填写 qq_bind_qq（QQ 号标签），仍可继续绑定");
            }
            let notifier2 = notifier.clone();
            let ctx2 = ctx_rx.clone();
            let status2 = qq_bind_status.clone();
            tokio::spawn(async move { run_qq_bind(notifier2, status2, q, ctx2).await });
        }
    }

    // QQ 自定义菜单：启用时启动后自动配置一次（失败仅记日志，不影响推送）。
    // 绑定模式的通道要等绑定成功才就绪，那条路径在 run_qq_bind 里另行处理。
    if cfg.notification.qq.menu_enabled && cfg.notification.qq.target_type != "bind" {
        let notifier_menu = notifier.clone();
        tokio::spawn(async move { notifier_menu.apply_qq_menu_auto().await });
    }

    let dispatch_task = tokio::spawn({
        let mut dispatcher = Dispatcher::new(client.clone(), notifier.clone(), broadcaster, ctx_rx.clone());
        dispatcher.set_archive(sms_archive.clone());
        async move { dispatcher.run(urc_rx).await }
    });
    let sched_task = tokio::spawn({
        let scheduler = scheduler.clone();
        async move { scheduler.run().await }
    });
    // 定时轮询推送：本模组不会主动上报 ^HCSQ / ^CERSSI，「信号变化通知」开关
    // 只能靠后端在用户指定时段内主动查询才会生效（时段外不发任何 AT）。
    let signalwatch_task = tokio::spawn({
        let watcher = SignalWatcher::new(
            client.clone(),
            notifier.clone(),
            cfg.notification.poll.clone(),
        );
        let ctx = ctx_rx.clone();
        async move { watcher.run(ctx).await }
    });
    // 定时推送：按 notify_timer_interval（分钟）周期性推送「当前实际情况」
    // （信号读数 + 存储用量）。与上面的巡检是两条独立周期线：巡检按「变化阈值」
    // 决定推不推，这里是到点就推当前状态。
    let timerpush_task = tokio::spawn({
        let pusher = TimerPusher::new(
            client.clone(),
            notifier.clone(),
            cfg.notification.timer_interval,
        );
        let ctx = ctx_rx.clone();
        async move { pusher.run(ctx).await }
    });
    let cache_task = tokio::spawn({
        let cache = cache.clone();
        let ctx = ctx_rx.clone();
        async move { cache.run(ctx).await }
    });
    // 后台对时：NTP 优先（三个服务器依次尝试），失败回退设备时钟。
    // 提前于使用量任务启动：按月清零靠日历判定，时钟不准会错月清零。
    let nettime_task = tokio::spawn({
        let ctx = ctx_rx.clone();
        async move { crate::nettime::run(ctx).await }
    });
    // 使用量后台统计：1 秒一采，前端关闭/刷新都不影响累计。
    let usage_task = tokio::spawn({
        let usage = usage.clone();
        let ctx = ctx_rx.clone();
        async move { usage.run(ctx).await }
    });
    // 默认存储区兜底：UCI sms_storage（默认 ME）。等 AT 通道就绪后读一次实际
    // 容量，与配置不符才下发（换卡 / 模组复位回 SM 时拉回配置值）。
    let sms_storage_task = {
        let sms = sms.clone();
        let client = client.clone();
        let want = cfg.sms_storage.clone();
        let mut ctx = ctx_rx.clone();
        tokio::spawn(async move {
            let mut waited = Duration::ZERO;
            while !client.connected() {
                if waited >= SMS_STORAGE_WAIT_MAX {
                    log_warn!(
                        "AT 通道 {}s 未就绪，跳过默认存储区应用（{}）",
                        SMS_STORAGE_WAIT_MAX.as_secs(),
                        want
                    );
                    return;
                }
                tokio::select! {
                    _ = ctx.changed() => return,
                    _ = tokio::time::sleep(Duration::from_secs(3)) => {}
                }
                waited += Duration::from_secs(3);
            }
            match sms.apply_default_storage(&want).await {
                Ok(true) => log_info!("默认存储区已应用：{}", want),
                Ok(false) => log_debug!("存储区已是 {}，无需切换", want),
                Err(e) => log_warn!("默认存储区应用失败（{}）：{}", want, e),
            }
        })
    };

    // 后台任务生命周期兜底：定期淘汰已结束的旧任务，避免无界增长。
    let task_cleanup_task = {
        let tasks = tasks.clone();
        let mut ctx = ctx_rx.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = ctx.changed() => break,
                    _ = tokio::time::sleep(Duration::from_secs(60)) => {}
                }
                let _ = tasks.cleanup(Duration::from_secs(3600)).await;
            }
        })
    };
    let serve_task = tokio::spawn({
        let rpc = rpc.clone();
        let port = cfg.websocket.port;
        let bind = cfg.websocket.bind.clone();
        async move { rpc.serve(port, &bind).await }
    });

    // 等待退出信号或服务异常。
    let mut serve_handle = serve_task;
    let serve_result = tokio::select! {
        _ = shutdown_signal() => None,
        r = &mut serve_handle => Some(r),
    };

    // 触发优雅关闭。
    let _ = ctx_tx.send(true);

    if let Some(Ok(Err(e))) = serve_result {
        log_error!("LuCI RPC 服务异常退出: {}", e);
    }

    // 给后台任务一点时间优雅收尾。
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        let _ = client_task.await;
        let _ = notify_task.await;
        let _ = dispatch_task.await;
        let _ = sched_task.await;
        let _ = signalwatch_task.await;
        let _ = timerpush_task.await;
        let _ = cache_task.await;
        let _ = usage_task.await;
        let _ = nettime_task.await;
        let _ = task_cleanup_task.await;
        let _ = sms_storage_task.await;
        let _ = serve_handle.await;
    })
    .await;

    crate::logger::set_level(crate::logger::Level::Info);
    log_info!("服务已停止");
    Ok(())
}

/// 默认存储区兜底任务等 AT 通道就绪的上限（弱信号 / 模组慢启动时别干等）。
const SMS_STORAGE_WAIT_MAX: Duration = Duration::from_secs(180);

/// QQ 绑定模式任务：监听 → 写 UCI → 热替换通道。
async fn run_qq_bind(
    notifier: Arc<Notifier>,
    status: std::sync::Arc<crate::qqbind::BindStatus>,
    q: crate::config::QqNotifyConfig,
    ctx: watch::Receiver<bool>,
) {
    log_info!("QQ 绑定模式启动（QQ 号标签: {}），等待用户给机器人发消息…", q.bind_qq);
    match qqbind::run_bind_tracked(status, &q.app_id, &q.app_secret, ctx).await {
        Ok(target) => {
            log_info!("QQ 绑定成功: type={} id={}", target.target_type, target.target_id);
            if let Err(e) = qqbind::persist_uci(&target).await {
                // 写不进 UCI 也要热替换，保证本次运行内可用
                log_error!("QQ 绑定结果写回 UCI 失败（本次运行内仍热生效）: {}", e);
            } else {
                log_info!("QQ 绑定结果已写回 UCI（qq_target_type/qq_target_id）");
            }
            let bind_tag = q.bind_qq.clone();
            let sender = crate::qqpush::QqSender::from_config(&crate::config::QqNotifyConfig {
                enabled: q.enabled,
                app_id: q.app_id,
                app_secret: q.app_secret,
                target_type: target.target_type,
                target_id: target.target_id,
                bind_qq: q.bind_qq,
                msg_format: q.msg_format,
                keyboard_enabled: q.keyboard_enabled,
                keyboard_url: q.keyboard_url,
                menu_enabled: q.menu_enabled,
            });
            if let Some(sender) = sender {
                // 绑定成功后立即回一条确认消息，让用户知道后续通知会发到这里。
                // 主动推送不依赖 WS 会话（run_bind 返回后 WS 已断开），失败仅记日志。
                let tag = if bind_tag.is_empty() {
                    String::new()
                } else {
                    format!("（QQ 号标签: {}）", bind_tag)
                };
                // 绑定确认消息同样不携带插件名字样，保持与业务通知一致的观感
                let content = format!("绑定成功{}：后续通知将推送到本会话", tag);
                match sender.send(sender.build_message(&content, "")).await {
                    Ok(()) => log_info!("QQ 绑定确认消息已发送"),
                    Err(e) => log_error!("QQ 绑定确认消息发送失败（不影响绑定生效）: {}", e),
                }
                // 菜单启用时，绑定成功后立即配置一次（启动时通道尚未就绪，配置不了）
                sender.apply_default_menu().await;
                notifier.set_qq(Some(sender));
            } else {
                // from_config 正常不会返回 None（凭据已校验），兜底防御
                log_error!("QQ 绑定后构造发送器失败，跳过热替换");
            }
        }
        Err(e) => log_error!("QQ 绑定失败: {}（下次服务重启会自动重试）", e),
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .expect("注册 SIGTERM 失败");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = sigterm.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

fn log_config(cfg: &Config) {
    if cfg.at.type_ == "SERIAL" {
        if cfg.at.serial.port == config::AUTO_SERIAL_PORT {
            log_info!("AT 通道: 串口自动探测 @ {}", cfg.at.serial.baudrate);
        } else {
            log_info!("AT 通道: 串口 {} @ {}", cfg.at.serial.port, cfg.at.serial.baudrate);
        }
    } else {
        log_info!("AT 通道: 网络 {}:{}", cfg.at.network.host, cfg.at.network.port);
    }

    log_info!(
        "LuCI RPC: {}:{}，密钥: {}",
        cfg.websocket.bind,
        cfg.websocket.port,
        if cfg.websocket.auth_key.is_empty() { "未设置" } else { "已设置" }
    );
    if cfg.websocket.bind != "127.0.0.1" {
        log_warn!(
            "RPC 对外监听 {}:{} —— 请确保防火墙已限制访问，并设置 websocket_auth_key",
            cfg.websocket.bind,
            cfg.websocket.port
        );
    }

    log_info!(
        "自动推送: {}",
        if cfg.notification.enabled {
            "已开启（短信/来电/信号/存储满均实时直发，另有定时推送按间隔推送当前状态）"
        } else {
            "已关闭（事件只写本地通知日志，不再外发）"
        }
    );
    log_info!(
        "推送开关: 短信={} 来电={} 存储满={} 信号={}",
        on_off(cfg.notification.types.sms),
        on_off(cfg.notification.types.call),
        on_off(cfg.notification.types.memory_full),
        on_off(cfg.notification.types.signal)
    );
    {
        let p = &cfg.notification.poll;
        if p.enabled {
            let strategy = if p.always {
                "每次轮询都推送".to_string()
            } else {
                format!("仅变化 ≥{:.0} dB 时推送", p.delta)
            };
            log_info!(
                "信号轮询推送: {}~{} 每 {} 秒一次，{}",
                p.start,
                p.end,
                p.interval.as_secs(),
                strategy
            );
        } else {
            log_info!("信号轮询推送: 未启用");
        }
    }
    log_info!("定时锁频: {}", if cfg.schedule.enabled { "启用" } else { "禁用" });
    log_info!(
        "使用量统计: 后台常驻采样（1s），自动清零 {}（时间源 {}）",
        crate::monthly::describe(cfg.usage_reset_day),
        crate::nettime::source_name()
    );
}

fn on_off(b: bool) -> &'static str {
    if b { "开" } else { "关" }
}
