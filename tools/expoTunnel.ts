import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";

function isPortListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(600);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function startCloudflaredTunnel(port: number): Promise<{
  url: string;
  proc: ChildProcess;
}> {
  console.log(
    `[Expo Tunnel] Starting Cloudflare HTTPS tunnel for http://localhost:${port}...`
  );
  const proc = spawn(
    "npx",
    ["cloudflared", "tunnel", "--url", `http://localhost:${port}`],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    }
  );

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error("Timed out waiting for cloudflared tunnel URL (25s).")
      );
    }, 25000);

    const checkChunk = (chunk: Buffer) => {
      const text = chunk.toString();
      const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timeout);
        resolve({ url: match[0], proc });
      }
    };

    proc.stdout?.on("data", checkChunk);
    proc.stderr?.on("data", checkChunk);
    proc.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function isExpoLoggedIn(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn("npx", ["expo", "whoami"], {
      stdio: ["ignore", "pipe", "ignore"],
      env: process.env,
    });
    let out = "";
    proc.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString();
    });
    proc.once("error", () => resolve(false));
    proc.once("exit", (code) => {
      resolve(code === 0 && !/not logged in/i.test(out));
    });
  });
}

async function main() {
  const children: ChildProcess[] = [];
  const cleanup = () => {
    for (const child of children) {
      try {
        child.kill();
      } catch {
        // Ignore
      }
    }
  };
  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });

  // 1. Ensure Backend (:3000) & Vite (:5173) are running
  const serverRunning = await isPortListening(3000);
  const viteRunning = await isPortListening(5173);

  if (!serverRunning) {
    console.log("[Expo Tunnel] Starting Backend Server on port 3000...");
    const srv = spawn("npm", ["run", "dev:server"], {
      stdio: "inherit",
      env: process.env,
    });
    children.push(srv);
  }

  if (!viteRunning) {
    console.log("[Expo Tunnel] Starting Vite UI Server on port 5173...");
    const web = spawn("npm", ["run", "dev:web"], {
      stdio: "inherit",
      env: process.env,
    });
    children.push(web);
  }

  // Wait until port 5173 is accepting connections
  for (let i = 0; i < 20; i++) {
    if (await isPortListening(5173)) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  // 2. Start Cloudflare HTTPS Tunnel to port 5173 so Expo Go WebView has HTTPS for Mic + AudioWorklet + API
  const { url: tunnelUrl, proc: tunnelProc } = await startCloudflaredTunnel(
    5173
  );
  children.push(tunnelProc);

  // Expo's own tunnel requires a signed-in Expo account; ngrok works anonymously
  const tunnelProvider = (await isExpoLoggedIn()) ? "expo" : "ngrok";

  console.log(`\n=============================================================`);
  console.log(`[Expo Tunnel] HTTPS App & API Tunnel Active: ${tunnelUrl}`);
  console.log(`[Expo Tunnel] Starting Expo Go with --tunnel ${tunnelProvider}...`);
  console.log(`=============================================================\n`);

  // 3. Launch `npx expo start --tunnel` with EXPO_PUBLIC_WEB_URL injected
  const expoProc = spawn(
    "npx",
    ["expo", "start", "--tunnel", tunnelProvider],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        EXPO_PUBLIC_WEB_URL: tunnelUrl,
      },
    }
  );
  children.push(expoProc);

  expoProc.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });
}

void main();
