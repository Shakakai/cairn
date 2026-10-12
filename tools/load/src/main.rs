//! Load and cost measurement client (docs/08 §5): spawns N lightweight protocol
//! clients (raw `switchback-proto` over WebSockets, not full endpoints) and reports
//! connection rates, frame rates, relay latency percentiles, and drop reasons.
//!
//! Patterns:
//!   idle   — connect and hold (keepalives only, plus the ADR-016 self-keepalive cadence)
//!   pairs  — `--new-peers-per-min` fresh destinations, `--burst` frames each
//!   stream — sustained relayed traffic between pairs
//!
//! Usage:
//!   cargo run -p load -- --cairn wss://host --clients 1000 --pattern idle --duration 300
//!   cargo run -p load -- --cairn wss://host --clients 200 --pattern pairs \
//!       --new-peers-per-min 5000 --burst 100 --duration 600 --csv out.csv

mod client;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Pattern {
    Idle,
    Pairs,
    Stream,
}

struct Opts {
    cairn: String,
    clients: usize,
    pattern: Pattern,
    duration: Duration,
    new_peers_per_min: u64,
    burst: usize,
    ramp: Duration,
    csv: Option<String>,
    admin_metrics: Option<String>,
    bind_source: bool,
}

fn parse_args() -> Opts {
    let mut o = Opts {
        cairn: "ws://127.0.0.1:8080".into(),
        clients: 1000,
        pattern: Pattern::Idle,
        duration: Duration::from_secs(300),
        new_peers_per_min: 0,
        burst: 100,
        ramp: Duration::from_secs(30),
        csv: None,
        admin_metrics: None,
        bind_source: false,
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut need = |name: &str| args.next().unwrap_or_else(|| panic!("missing value for {name}"));
        match a.as_str() {
            "--cairn" => o.cairn = need("--cairn"),
            "--clients" => o.clients = need("--clients").parse().expect("number"),
            "--pattern" => {
                o.pattern = match need("--pattern").as_str() {
                    "idle" => Pattern::Idle,
                    "pairs" => Pattern::Pairs,
                    "stream" => Pattern::Stream,
                    other => panic!("unknown pattern {other}"),
                }
            }
            "--duration" => o.duration = Duration::from_secs(need("--duration").parse().expect("seconds")),
            "--new-peers-per-min" => o.new_peers_per_min = need("--new-peers-per-min").parse().expect("number"),
            "--burst" => o.burst = need("--burst").parse().expect("number"),
            "--ramp" => o.ramp = Duration::from_secs(need("--ramp").parse().expect("seconds")),
            "--csv" => o.csv = Some(need("--csv")),
            "--admin-metrics" => o.admin_metrics = Some(need("--admin-metrics")),
            "--bind-source-ips" => o.bind_source = true,
            other => panic!("unknown argument {other}"),
        }
    }
    o
}

/// Latency samples in milliseconds (relay hop, timestamp in payload).
struct Samples {
    inner: parking_lot_like::Mutex<Vec<f64>>,
}

mod parking_lot_like {
    pub type Mutex<T> = std::sync::Mutex<T>;
}

impl Samples {
    fn record(&self, ms: f64) {
        let mut g = self.inner.lock().expect("samples");
        if g.len() < 2_000_000 {
            g.push(ms);
        }
    }

    fn percentiles(&self) -> (f64, f64, f64) {
        let mut v: Vec<f64> = self.inner.lock().expect("samples").clone();
        if v.is_empty() {
            return (0.0, 0.0, 0.0);
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let at = |p: f64| v[((v.len() - 1) as f64 * p) as usize];
        (at(0.5), at(0.99), v.len() as f64)
    }
}

#[derive(Default)]
struct Counters {
    connected: AtomicU64,
    rejected: AtomicU64,
    connect_errors: AtomicU64,
    disconnected_unexpected: AtomicU64,
    frames_sent: AtomicU64,
    frames_recv: AtomicU64,
    send_errors: AtomicU64,
    bytes_sent: AtomicU64,
}

#[tokio::main(flavor = "multi_thread", worker_threads = 8)]
async fn main() {
    // rustls provider selection: this crate's graph enables more than one provider
    // (feature unification differs from the endpoint crate); pick explicitly.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let opts = parse_args();
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::new("warn"))
        .try_init();

    let counters = Arc::new(Counters::default());
    let samples = Arc::new(Samples {
        inner: std::sync::Mutex::new(Vec::new()),
    });

    println!(
        "load: {} clients, pattern {:?}, duration {}s (ramp {}s) against {}",
        opts.clients,
        opts.pattern,
        opts.duration.as_secs(),
        opts.ramp.as_secs(),
        opts.cairn
    );

    let deadline = Instant::now() + opts.duration;
    let per_client_delay = opts.ramp / opts.clients.max(1) as u32;

    let mut handles = Vec::new();
    for i in 0..opts.clients {
        let cairn = opts.cairn.clone();
        let counters = counters.clone();
        let samples = samples.clone();
        let pattern = opts.pattern;
        let burst = opts.burst;
        let new_peers = if pattern == Pattern::Pairs { opts.new_peers_per_min } else { 0 };
        handles.push(tokio::spawn(async move {
            tokio::time::sleep(per_client_delay * i as u32).await;
            client::run_client(client::ClientArgs {
                cairn,
                id: i,
                deadline,
                pattern,
                burst,
                new_peers_per_min: new_peers,
                counters,
                samples,
                bind_source: opts.bind_source,
            })
            .await;
        }));
    }

    // Progress + metrics sampling loop.
    let mut csv_lines: Vec<String> = vec![
        "t,connected,rejected,disconnected,frames_sent,frames_recv,send_errors,bytes_sent".into(),
    ];
    let start = Instant::now();
    let g = |c: &Counters, f: fn(&Counters) -> &AtomicU64| f(c).load(Ordering::Relaxed);
    let snap = |c: &Counters| {
        (
            g(c, |x| &x.connected),
            g(c, |x| &x.rejected),
            g(c, |x| &x.connect_errors),
            g(c, |x| &x.disconnected_unexpected),
            g(c, |x| &x.frames_sent),
            g(c, |x| &x.frames_recv),
            g(c, |x| &x.send_errors),
            g(c, |x| &x.bytes_sent),
        )
    };
    let mut prev = snap(&counters);
    while Instant::now() < deadline {
        tokio::time::sleep(Duration::from_secs(10)).await;
        let now = snap(&counters);
        let (p50, p99, n) = samples.percentiles();
        let t = start.elapsed().as_secs();
        println!(
            "t={}s connected={} rejected={} conn_errors={} dropped={} | 10s: sent={} recv={} send_err={} | latency ms p50={:.1} p99={:.1} (n={})",
            t,
            now.0,
            now.1,
            now.2,
            now.3,
            now.4 - prev.4,
            now.5 - prev.5,
            now.6 - prev.6,
            p50,
            p99,
            n
        );
        csv_lines.push(format!(
            "{},{},{},{},{},{},{},{}",
            t, now.0, now.1, now.3, now.4, now.5, now.6, now.7
        ));
        prev = now;
    }

    for h in handles {
        match h.await {
            Ok(()) => {}
            Err(e) => {
                if e.is_panic() {
                    eprintln!("load client panicked: {e}");
                    counters.connect_errors.fetch_add(1, Ordering::Relaxed);
                }
            }
        }
    }

    let (p50, p99, n) = samples.percentiles();
    let g = |f: &AtomicU64| f.load(Ordering::Relaxed);
    println!("\n==== SUMMARY ====");
    println!("clients attempted:  {}", opts.clients);
    println!("connected:          {}", g(&counters.connected));
    println!("rejected:           {}", g(&counters.rejected));
    println!("connect errors:     {}", g(&counters.connect_errors));
    println!("unexpected drops:   {}", g(&counters.disconnected_unexpected));
    println!("frames sent/recv:   {} / {}", g(&counters.frames_sent), g(&counters.frames_recv));
    println!("send errors:        {}", g(&counters.send_errors));
    println!(
        "bytes sent:         {} MiB",
        g(&counters.bytes_sent) / 1_048_576
    );
    println!("latency ms p50={:.1} p99={:.1} (n={})", p50, p99, n);
    let wall = start.elapsed().as_secs_f64();
    println!("wall: {:.0}s; connection-minutes: {:.0}", wall, g(&counters.connected) as f64 * wall / 60.0);

    if let Some(path) = &opts.csv {
        std::fs::write(path, csv_lines.join("\n") + "\n").expect("write csv");
        println!("csv written: {path}");
    }
}
