/**
 * Doc 04 risk measurements against a deployed Cairn Edge (staging).
 *
 *  Risk 1: Worker CPU accumulation on long-lived sockets (30s default / 5min max
 *          CPU per invocation). Hold a socket with light traffic past the 5-minute
 *          mark and confirm it survives; if it dies, the client's reconnect must hide it.
 *  Risk 2: Do link sockets count against the 10k subrequests-per-invocation cap?
 *          Send to 12 000 distinct destinations from ONE client connection (each first
 *          frame opens a link = 1 subrequest). If counted, the invocation dies at ~10k.
 *  Risk 3: Are client WebSocket pings answered without invoking the Worker?
 *  Risk 4: DO wake latency after hibernation: first-frame RTT after >65s idle vs warm.
 *
 * Usage: node scripts/measure-cf-risks.mjs wss://cairn-staging...workers.dev
 */

import { randomBytes } from "node:crypto";
import { createAuthBlob, decodeRelayFrame, ed25519PublicKey, encodeBase64Url } from "@cairn/core";
import WebSocket from "ws";

const url = process.argv[2];
if (url === undefined) {
  console.error("usage: node measure-cf-risks.mjs <wss-url>");
  process.exit(2);
}

function startSelfKeepalive(c, intervalMs = 25_000) {
  const timer = setInterval(() => {
    try {
      c.sendTo(c.endpointBytes, 0, Buffer.alloc(0)); // empty datagram to self (doc 01)
    } catch {
      // closing
    }
  }, intervalMs);
  const ws = c.ws;
  ws.on("close", () => clearInterval(timer));
  return timer;
}

function connect(seed) {
  return new Promise((resolve, reject) => {
    const endpointBytes = ed25519PublicKey(seed);
    const auth = encodeBase64Url(
      createAuthBlob({
        secretKey: seed,
        host: new URL(url).hostname,
        endpointBytes,
        timestampMs: BigInt(Date.now()),
        nonce: randomBytes(16),
      }),
    );
    const ws = new WebSocket(`${url}/v1/connect`, ["switchback.v1"], {
      headers: { "Switchback-Auth": auth },
    });
    const queue = [];
    const waiters = [];
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      const frame = decodeRelayFrame(new Uint8Array(data));
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(frame);
      } else {
        queue.push(frame);
      }
    });
    ws.on("open", () =>
      resolve({
        ws,
        endpointBytes,
        nextFrame: (timeoutMs = 15_000) => {
          const buffered = queue.shift();
          if (buffered !== undefined) return Promise.resolve(buffered);
          return new Promise((res, rej) => {
            const entry = (frame) => {
              clearTimeout(t);
              res(frame);
            };
            const t = setTimeout(() => {
              const i = waiters.indexOf(entry);
              if (i >= 0) waiters.splice(i, 1);
              rej(new Error("frame timeout"));
            }, timeoutMs);
            waiters.push(entry);
          });
        },
        sendTo: (dst, ecn, payload) => {
          const frame = Buffer.alloc(34 + payload.length);
          frame[0] = 0x02;
          Buffer.from(dst).copy(frame, 1);
          frame[33] = ecn;
          Buffer.from(payload).copy(frame, 34);
          ws.send(frame);
        },
        sendRaw: (bytes) => ws.send(Buffer.from(bytes)),
        ping: (payload) => ws.ping(payload),
        onPong: (handler) => ws.on("pong", handler),
        close: () => ws.close(1000),
      }),
    );
    ws.on("unexpected-response", (_req, res) => {
      reject(new Error(`upgrade rejected: ${res.statusCode}`));
    });
    ws.on("error", reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};

// ---------------------------------------------------------------------------
console.log("=== Risk 3: client pings answered without invoking the Worker ===");
{
  const seed = randomBytes(32);
  const c = await connect(seed);
  await c.nextFrame(); // ServerInfo
  await c.nextFrame(); // Status(0)
  let pongs = 0;
  c.onPong(() => {
    pongs += 1;
  });
  for (let i = 0; i < 5; i++) {
    c.ping(randomBytes(8));
    await sleep(1000);
  }
  results.risk3 = {
    pingsSent: 5,
    pongsReceived: pongs,
    answeredWithoutWorkerCode: pongs === 5,
  };
  console.log(JSON.stringify({ risk3: results.risk3 }));
  c.close();
}

// ---------------------------------------------------------------------------
console.log("=== Risk 4: DO wake latency (hibernated vs warm) ===");
{
  const a = await connect(randomBytes(32));
  const b = await connect(randomBytes(32));
  await a.nextFrame();
  await a.nextFrame();
  await b.nextFrame();
  await b.nextFrame();
  startSelfKeepalive(a);
  startSelfKeepalive(b);

  const measureRtt = async (label, payloadTag) => {
    const t0 = process.hrtime.bigint();
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(payloadTag, 0);
    a.sendTo(b.endpointBytes, 0, payload);
    // Skip keepalive noise: match the frame from A carrying our tag.
    const deadline = Date.now() + 10_000;
    for (;;) {
      let frame;
      try {
        frame = await b.nextFrame(Math.max(1, deadline - Date.now()));
      } catch (error) {
        console.log(`${label}: TIMEOUT (${error.message})`);
        return null;
      }
      if (
        frame.type === "recv" &&
        Buffer.from(frame.src).equals(Buffer.from(a.endpointBytes)) &&
        frame.datagram.length >= 4 &&
        Buffer.from(frame.datagram).readUInt32BE(0) === payloadTag
      ) {
        break;
      }
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    console.log(`${label}: ${ms.toFixed(1)}ms`);
    return ms;
  };

  await measureRtt("warm frame 1", 1);
  await measureRtt("warm frame 2", 2);
  console.log("idle 70s (hibernate the mailbox)...");
  await sleep(70_000);
  const cold = await measureRtt("cold frame (post-hibernation)", 3);
  const cold2 = await measureRtt("cold frame 2", 4);
  results.risk4 = { warmMs: "see lines above", firstAfterWakeMs: cold, secondAfterWakeMs: cold2 };
  a.close();
  b.close();
}

// ---------------------------------------------------------------------------
console.log("=== Risk 2: 12 000 links from one client connection (subrequest cap) ===");
{
  const sender = await connect(randomBytes(32));
  await sender.nextFrame();
  await sender.nextFrame();
  startSelfKeepalive(sender);
  const t0 = Date.now();
  const DESTINATIONS = 12_000;
  const BATCH = 500;
  let sent = 0;
  let alive = true;
  sender.ws.on("close", () => {
    alive = false;
  });
  for (let base = 0; base < DESTINATIONS; base += BATCH) {
    if (!alive) break;
    const batch = [];
    for (let i = 0; i < BATCH; i++) {
      // Valid Ed25519 destination keys (the relay validates dst, doc 01 §4.2); each
      // first send to a distinct destination opens a fresh link + mailbox.
      batch.push(Buffer.from(ed25519PublicKey(randomBytes(32))));
    }
    for (const dst of batch) {
      sender.sendTo(dst, 0, Buffer.alloc(4));
      sent += 1;
    }
    await sleep(150); // let links open; maxLinksPerIsolate (1024) recycles LRU
    if (base % 3000 === 0) {
      console.log(
        `  sent ${sent}/${DESTINATIONS} (${((Date.now() - t0) / 1000).toFixed(0)}s), alive=${alive}`,
      );
    }
  }
  await sleep(1000);
  results.risk2 = {
    destinations: sent,
    clientConnectionAliveAfter12k: alive,
    wallSeconds: (Date.now() - t0) / 1000,
    interpretation: alive
      ? "links do not kill the invocation past 10k (cap not hit, or not counted as subrequests)"
      : "client invocation died: link opens count against the subrequest cap (doc 04 risk 2 confirmed)",
  };
  console.log(JSON.stringify({ risk2: results.risk2 }));
  sender.close();
}

// ---------------------------------------------------------------------------
console.log("=== Risk 1: long-lived socket past the 5-minute CPU ceiling ===");
{
  const a = await connect(randomBytes(32));
  const b = await connect(randomBytes(32));
  await a.nextFrame();
  await a.nextFrame();
  await b.nextFrame();
  await b.nextFrame();
  startSelfKeepalive(a);
  startSelfKeepalive(b);
  const start = Date.now();
  let exchanges = 0;
  let died = false;
  a.ws.on("close", () => {
    died = true;
  });
  // Exchange a frame every 20s for 6.5 minutes (past the 5-minute CPU cap).
  while (Date.now() - start < 6.5 * 60_000) {
    const payload = Buffer.alloc(8);
    payload.writeUInt32BE(exchanges, 0);
    a.sendTo(b.endpointBytes, 0, payload);
    try {
      await b.nextFrame(20_000);
      exchanges += 1;
    } catch {
      // frame missed; count as observed stall
    }
    await sleep(20_000);
  }
  results.risk1 = {
    heldSeconds: (Date.now() - start) / 1000,
    survivedPast5Min: !died,
    exchanges,
    interpretation: !died
      ? "no CPU-time kill at the 5-minute mark: long-lived sockets are not CPU-capped as feared (or cap is higher)"
      : "socket died: CPU accumulation cap exists; client reconnect must hide it",
  };
  console.log(JSON.stringify({ risk1: results.risk1 }));
  a.close();
  b.close();
}

console.log("\n==== SUMMARY ====");
console.log(JSON.stringify(results, null, 2));
