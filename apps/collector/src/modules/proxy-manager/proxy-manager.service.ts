import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, type ChildProcess, exec } from 'child_process';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';
import type { StatsDatabase } from '../db/db.js';

const MIHOMO_VERSION = 'v1.18.1';
const DATA_DIR = path.join(process.cwd(), 'data');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
const LOG_PATH = path.join(DATA_DIR, 'mihomo.log');

export interface ProxyStatus {
  running: boolean;
  version: string;
  systemProxy: boolean;
  tunMode: boolean;
  configPath: string;
  subscriptionUrl?: string;
}

export class ProxyManagerService {
  private process: ChildProcess | null = null;
  private db: StatsDatabase;
  private isSystemProxyEnabled = false;
  private subscriptionUrl: string | null = null;
  private logStream: fs.WriteStream | null = null;

  constructor(db: StatsDatabase) {
    this.db = db;
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }
    // Load persisted state if any (could be in DB or a separate json file)
    // For now, we'll just check if process is running on start or rely on manual start
    this.loadState();
    this.ensureBackend();
  }

  private getStatePath() {
    return path.join(DATA_DIR, 'proxy-state.json');
  }

  private loadState() {
    try {
      if (fs.existsSync(this.getStatePath())) {
        const data = JSON.parse(fs.readFileSync(this.getStatePath(), 'utf-8'));
        this.subscriptionUrl = data.subscriptionUrl;
        this.isSystemProxyEnabled = data.systemProxy || false;
      }
    } catch (e) {
      console.error('[ProxyManager] Failed to load state:', e);
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(this.getStatePath(), JSON.stringify({
        subscriptionUrl: this.subscriptionUrl,
        systemProxy: this.isSystemProxyEnabled
      }, null, 2));
    } catch (e) {
      console.error('[ProxyManager] Failed to save state:', e);
    }
  }

  private getBinaryPath(): string {
    const platform = os.platform();
    const ext = platform === 'win32' ? '.exe' : '';
    return path.join(BIN_DIR, `mihomo${ext}`);
  }

  async ensureCore(): Promise<void> {
    const binPath = this.getBinaryPath();
    if (fs.existsSync(binPath)) {
      return;
    }

    console.info('[ProxyManager] Downloading mihomo core...');
    const platform = os.platform();
    const arch = os.arch();
    let url = '';
    let isZip = false;

    if (platform === 'win32') {
      url = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-windows-amd64-${MIHOMO_VERSION}.zip`;
      isZip = true;
    } else if (platform === 'darwin') {
      url = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-darwin-${arch === 'arm64' ? 'arm64' : 'amd64'}-${MIHOMO_VERSION}.gz`;
    } else if (platform === 'linux') {
      url = `https://github.com/MetaCubeX/mihomo/releases/download/${MIHOMO_VERSION}/mihomo-linux-${arch === 'arm64' ? 'arm64' : 'amd64'}-${MIHOMO_VERSION}.gz`;
    } else {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    console.info(`[ProxyManager] Downloading from ${url}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to download core: ${res.statusText}`);

    if (isZip) {
      // For Windows zip, we download to a temp file and extract
      const tempZip = path.join(BIN_DIR, 'temp.zip');
      const fileStream = fs.createWriteStream(tempZip);
      // @ts-expect-error - Readable.fromWeb matches pipeline requirements in newer Node but types might lag
      await pipeline(Readable.fromWeb(res.body), fileStream);

      // Extract zip (using powershell for simplicity on Windows)
      console.info('[ProxyManager] Extracting zip...');
      await new Promise<void>((resolve, reject) => {
        exec(`powershell -command "Expand-Archive -Path '${tempZip}' -DestinationPath '${BIN_DIR}' -Force"`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      fs.unlinkSync(tempZip);

      // Rename extracted file to standard name if needed
      // The zip usually contains a file named like 'mihomo-windows-amd64.exe'
      const files = fs.readdirSync(BIN_DIR);
      const exe = files.find(f => f.startsWith('mihomo') && f.endsWith('.exe'));
      if (exe && exe !== 'mihomo.exe') {
        fs.renameSync(path.join(BIN_DIR, exe), binPath);
      }
    } else {
      // For gz, we decompress directly
      const fileStream = fs.createWriteStream(binPath);
      const gunzip = createGunzip();
      // @ts-expect-error - Readable.fromWeb matches pipeline requirements in newer Node but types might lag
      await pipeline(Readable.fromWeb(res.body), gunzip, fileStream);
    }

    if (platform !== 'win32') {
      fs.chmodSync(binPath, 0o755);
    }
    console.info('[ProxyManager] Core downloaded successfully.');
  }

  async start(): Promise<void> {
    if (this.process) {
      console.info('[ProxyManager] Process already running.');
      return;
    }

    await this.ensureCore();

    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error('Config file not found. Please update subscription first.');
    }

    console.info('[ProxyManager] Starting mihomo...');
    const binPath = this.getBinaryPath();

    // Ensure log file exists
    this.logStream = fs.createWriteStream(LOG_PATH, { flags: 'a' });

    this.process = spawn(binPath, ['-d', DATA_DIR, '-f', CONFIG_PATH], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process.stdout?.pipe(this.logStream);
    this.process.stderr?.pipe(this.logStream);

    this.process.on('error', (err) => {
      console.error('[ProxyManager] Process error:', err);
      this.process = null;
    });

    this.process.on('exit', (code) => {
      console.info(`[ProxyManager] Process exited with code ${code}`);
      this.process = null;
      if (this.isSystemProxyEnabled) {
        this.disableSystemProxy().catch(console.error);
      }
    });

    // Wait a bit to ensure it started
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (this.isSystemProxyEnabled) {
      await this.enableSystemProxy();
    }

    this.ensureBackend();
  }

  private ensureBackend() {
    try {
      const backends = this.db.getAllBackends();
      const localUrl = 'http://127.0.0.1:9090';
      const exists = backends.find(b => b.url.includes('127.0.0.1:9090') || b.url.includes('localhost:9090'));

      if (!exists) {
        console.info('[ProxyManager] Creating local backend...');
        this.db.createBackend({
          name: 'Local Client',
          url: localUrl,
          type: 'clash',
          token: ''
        });
      } else {
        // Ensure it is enabled
        if (!exists.enabled || !exists.listening) {
          console.info('[ProxyManager] Enabling local backend...');
          this.db.updateBackend(exists.id, { enabled: true, listening: true });
        }
      }
    } catch (e) {
      console.error('[ProxyManager] Failed to ensure backend:', e);
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      console.info('[ProxyManager] Stopping process...');
      this.process.kill();
      this.process = null;
    }
    await this.disableSystemProxy();
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async updateConfig(subscriptionUrl: string, _userRules: string = ''): Promise<void> {
    console.info(`[ProxyManager] Updating config from ${subscriptionUrl}`);
    const res = await fetch(subscriptionUrl);
    if (!res.ok) throw new Error(`Failed to fetch subscription: ${res.statusText}`);

    const configContent = await res.text();

    // Simple merge: append user rules if needed
    // In a real app, we might want to parse YAML and merge properly
    // For now, we just save the subscription content as config.yaml
    // We force external-controller to 9090 to ensure we can connect

    let finalConfig = configContent;

    // Force external-controller
    if (!finalConfig.includes('external-controller:')) {
      finalConfig += '\nexternal-controller: 0.0.0.0:9090\n';
    } else {
       // Replace existing port if needed, or just warn user
       // Regex replace to ensure it's 9090?
       finalConfig = finalConfig.replace(/external-controller: .*/, 'external-controller: 0.0.0.0:9090');
    }

    // Force external-ui? Not needed as we use Neko Master

    // Save
    fs.writeFileSync(CONFIG_PATH, finalConfig);
    this.subscriptionUrl = subscriptionUrl;
    this.saveState();

    // If running, restart to apply
    if (this.process) {
      await this.restart();
    }
  }

  async enableSystemProxy(): Promise<void> {
    if (os.platform() === 'win32') {
      // Enable system proxy on Windows
      // Using registry or netsh. Registry is more common for per-user.
      // Set ProxyEnable = 1, ProxyServer = 127.0.0.1:7890
      const port = 7890; // Default mixed port
      console.info('[ProxyManager] Enabling system proxy (Windows)...');
      await this.execCommand(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`);
      await this.execCommand(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
    } else if (os.platform() === 'darwin') {
      // Enable system proxy on macOS
      // networksetup -setwebproxy "Wi-Fi" 127.0.0.1 7890
      // networksetup -setsecurewebproxy "Wi-Fi" 127.0.0.1 7890
      const port = 7890;
      console.info('[ProxyManager] Enabling system proxy (macOS)...');
      // We need to detect the active network service. Defaulting to Wi-Fi for now.
      // A robust solution would iterate services.
      const services = ['Wi-Fi', 'Ethernet'];
      for (const service of services) {
        try {
          await this.execCommand(`networksetup -setwebproxy "${service}" 127.0.0.1 ${port}`);
          await this.execCommand(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${port}`);
        } catch {
          // Ignore if service not found
        }
      }
    }
    this.isSystemProxyEnabled = true;
    this.saveState();
  }

  async disableSystemProxy(): Promise<void> {
    if (os.platform() === 'win32') {
      console.info('[ProxyManager] Disabling system proxy (Windows)...');
      await this.execCommand(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f`);
    } else if (os.platform() === 'darwin') {
      console.info('[ProxyManager] Disabling system proxy (macOS)...');
      const services = ['Wi-Fi', 'Ethernet'];
      for (const service of services) {
        try {
          await this.execCommand(`networksetup -setwebproxystate "${service}" off`);
          await this.execCommand(`networksetup -setsecurewebproxystate "${service}" off`);
        } catch {
            // Ignore
        }
      }
    }
    this.isSystemProxyEnabled = false;
    this.saveState();
  }

  private execCommand(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, _stderr) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  getStatus(): ProxyStatus {
    let tunMode = false;
    try {
      if (fs.existsSync(CONFIG_PATH)) {
        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        // Simple check for tun enable
        if (content.includes('tun:') && content.includes('enable: true')) {
          tunMode = true;
        }
      }
    } catch {
      // Ignore
    }

    return {
      running: !!this.process,
      version: MIHOMO_VERSION,
      systemProxy: this.isSystemProxyEnabled,
      tunMode,
      configPath: CONFIG_PATH,
      subscriptionUrl: this.subscriptionUrl || undefined
    };
  }

  getLogs(lines: number = 100): string[] {
    if (!fs.existsSync(LOG_PATH)) return [];
    // Simple implementation: read whole file and take last N lines
    // For production, use a proper log rotator or stream reader
    try {
      const content = fs.readFileSync(LOG_PATH, 'utf-8');
      return content.split('\n').slice(-lines);
    } catch {
      return [];
    }
  }
}
