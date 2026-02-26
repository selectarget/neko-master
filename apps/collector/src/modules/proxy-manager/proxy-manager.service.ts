import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, type ChildProcess, exec } from 'child_process';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { Readable } from 'stream';
import yaml from 'yaml';
import type { StatsDatabase } from '../db/db.js';

const MIHOMO_VERSION = 'v1.18.1';
const DATA_DIR = path.join(process.cwd(), 'data');
const BIN_DIR = path.join(DATA_DIR, 'bin');
const CONFIG_PATH = path.join(DATA_DIR, 'config.yaml');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const LOG_PATH = path.join(DATA_DIR, 'mihomo.log');

export interface ProxyStatus {
  running: boolean;
  version: string;
  systemProxy: boolean;
  tunMode: boolean;
  configPath: string;
  subscriptionUrl?: string;
  activeProfile?: string;
}

export interface ProxyProfile {
  name: string;
  url?: string;
  updatedAt: string;
}

export class ProxyManagerService {
  private process: ChildProcess | null = null;
  private db: StatsDatabase;
  private isSystemProxyEnabled = false;
  private subscriptionUrl: string | null = null;
  private activeProfile: string | null = null;
  private logStream: fs.WriteStream | null = null;

  constructor(db: StatsDatabase) {
    this.db = db;
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }
    if (!fs.existsSync(PROFILES_DIR)) {
      fs.mkdirSync(PROFILES_DIR, { recursive: true });
    }
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
        this.activeProfile = data.activeProfile || null;
      }
    } catch (e) {
      console.error('[ProxyManager] Failed to load state:', e);
    }
  }

  private saveState() {
    try {
      fs.writeFileSync(this.getStatePath(), JSON.stringify({
        subscriptionUrl: this.subscriptionUrl,
        systemProxy: this.isSystemProxyEnabled,
        activeProfile: this.activeProfile,
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
      const tempZip = path.join(BIN_DIR, 'temp.zip');
      const fileStream = fs.createWriteStream(tempZip);
      // @ts-expect-error - Readable.fromWeb matches pipeline requirements
      await pipeline(Readable.fromWeb(res.body), fileStream);

      console.info('[ProxyManager] Extracting zip...');
      await new Promise<void>((resolve, reject) => {
        const safeTempZip = tempZip.replace(/'/g, "''");
        const safeBinDir = BIN_DIR.replace(/'/g, "''");
        exec(`powershell -command "Expand-Archive -Path '${safeTempZip}' -DestinationPath '${safeBinDir}' -Force"`, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      fs.unlinkSync(tempZip);

      const files = fs.readdirSync(BIN_DIR);
      const exe = files.find(f => f.startsWith('mihomo') && f.endsWith('.exe'));
      if (exe && exe !== 'mihomo.exe') {
        fs.renameSync(path.join(BIN_DIR, exe), binPath);
      }
    } else {
      const fileStream = fs.createWriteStream(binPath);
      const gunzip = createGunzip();
      // @ts-expect-error - Readable.fromWeb matches pipeline requirements
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

  // Helper to sanitize profile name to prevent path traversal
  private validateProfileName(name: string): string {
    if (!name || typeof name !== 'string') {
        throw new Error('Invalid profile name');
    }
    // Allow alphanumeric, dash, underscore. Reject anything else including dots and slashes.
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error('Invalid profile name: only alphanumeric, dash, and underscore allowed');
    }
    return name;
  }

  // List all available profiles
  listProfiles(): ProxyProfile[] {
    try {
      if (!fs.existsSync(PROFILES_DIR)) return [];
      const files = fs.readdirSync(PROFILES_DIR).filter(f => f.endsWith('.yaml'));

      return files.map(file => {
        const filePath = path.join(PROFILES_DIR, file);
        const stats = fs.statSync(filePath);
        return {
          name: file.replace('.yaml', ''),
          updatedAt: stats.mtime.toISOString(),
        };
      });
    } catch (e) {
      console.error('[ProxyManager] Failed to list profiles:', e);
      return [];
    }
  }

  // Update existing profile or create new one from URL
  async updateConfig(subscriptionUrl: string, name?: string): Promise<void> {
    const profileName = name ? this.validateProfileName(name) : 'default';
    const filename = `${profileName}.yaml`;
    const profilePath = path.join(PROFILES_DIR, filename);

    console.info(`[ProxyManager] Updating profile '${profileName}' from ${subscriptionUrl}`);
    const res = await fetch(subscriptionUrl);
    if (!res.ok) throw new Error(`Failed to fetch subscription: ${res.statusText}`);

    const configContent = await res.text();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let configObj: any;
    try {
      configObj = yaml.parse(configContent);
    } catch (e) {
      console.warn('Failed to parse subscription YAML', e);
      // Even if parse fails, we might save it? But we need to inject controller
      // Let's assume valid YAML for now or do string replacement
    }

    if (configObj) {
      // Force external-controller to localhost
      configObj['external-controller'] = '127.0.0.1:9090';
      fs.writeFileSync(profilePath, yaml.stringify(configObj));
    } else {
      let finalConfig = configContent;
      if (!finalConfig.includes('external-controller:')) {
        finalConfig += '\nexternal-controller: 127.0.0.1:9090\n';
      } else {
         finalConfig = finalConfig.replace(/external-controller: .*/, 'external-controller: 127.0.0.1:9090');
      }
      fs.writeFileSync(profilePath, finalConfig);
    }

    // If this is the active profile, apply it immediately
    if (this.activeProfile === profileName) {
      await this.switchProfile(profileName);
    } else if (!this.activeProfile) {
      // If no active profile, make this one active
      await this.switchProfile(profileName);
    }
  }

  // Switch active profile
  async switchProfile(name: string): Promise<void> {
    const profileName = this.validateProfileName(name);
    const filename = `${profileName}.yaml`;
    const profilePath = path.join(PROFILES_DIR, filename);

    if (!fs.existsSync(profilePath)) {
      throw new Error(`Profile '${profileName}' not found`);
    }

    console.info(`[ProxyManager] Switching to profile '${profileName}'`);

    // Copy to config.yaml
    fs.copyFileSync(profilePath, CONFIG_PATH);

    this.activeProfile = profileName;
    this.saveState();

    if (this.process) {
      await this.restart();
    }
  }

  async deleteProfile(name: string): Promise<void> {
    const profileName = this.validateProfileName(name);
    const filename = `${profileName}.yaml`;
    const profilePath = path.join(PROFILES_DIR, filename);

    if (fs.existsSync(profilePath)) {
      fs.unlinkSync(profilePath);
    }

    if (this.activeProfile === profileName) {
      this.activeProfile = null;
      this.saveState();
      // Don't stop process, just leave it running with old config or stop it?
      // Maybe safer to not stop, user must pick another profile.
    }
  }

  async setTunMode(enabled: boolean): Promise<void> {
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error('Config file not found');
    }

    try {
      const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
      const config = yaml.parse(content) || {};

      if (enabled) {
        if (!config.tun) config.tun = {};
        config.tun.enable = true;
        if (!config.tun.stack) config.tun.stack = 'system';
        if (config.tun['auto-route'] === undefined) config.tun['auto-route'] = true;
        if (config.tun['auto-detect-interface'] === undefined) config.tun['auto-detect-interface'] = true;
        if (!config.tun['dns-hijack']) config.tun['dns-hijack'] = ['any:53'];
      } else {
        if (config.tun) {
          config.tun.enable = false;
        }
      }

      fs.writeFileSync(CONFIG_PATH, yaml.stringify(config));

      // Also update the active profile file if exists
      if (this.activeProfile) {
         try {
           const profileName = this.validateProfileName(this.activeProfile);
           const profilePath = path.join(PROFILES_DIR, `${profileName}.yaml`);
           if (fs.existsSync(profilePath)) {
              fs.writeFileSync(profilePath, yaml.stringify(config));
           }
         } catch (e) {
            console.error('[ProxyManager] Failed to update active profile file:', e);
         }
      }

      if (this.process) {
        await this.restart();
      }
    } catch (e) {
      console.error('[ProxyManager] Failed to toggle TUN mode:', e);
      throw new Error('Failed to update configuration');
    }
  }

  async enableSystemProxy(): Promise<void> {
    if (os.platform() === 'win32') {
      const port = 7890;
      console.info('[ProxyManager] Enabling system proxy (Windows)...');
      await this.execCommand(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f`);
      await this.execCommand(`reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "127.0.0.1:${port}" /f`);
    } else if (os.platform() === 'darwin') {
      const port = 7890;
      console.info('[ProxyManager] Enabling system proxy (macOS)...');
      const services = ['Wi-Fi', 'Ethernet'];
      for (const service of services) {
        try {
          await this.execCommand(`networksetup -setwebproxy "${service}" 127.0.0.1 ${port}`);
          await this.execCommand(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 ${port}`);
        } catch {
          // Ignore
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
        try {
          const config = yaml.parse(content);
          if (config?.tun?.enable) {
            tunMode = true;
          }
        } catch {
          // Fallback regex if parsing fails? Or just ignore
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
      subscriptionUrl: this.subscriptionUrl || undefined,
      activeProfile: this.activeProfile || undefined,
    };
  }

  getLogs(lines: number = 100): string[] {
    if (!fs.existsSync(LOG_PATH)) return [];
    try {
      const content = fs.readFileSync(LOG_PATH, 'utf-8');
      return content.split('\n').slice(-lines);
    } catch {
      return [];
    }
  }
}
