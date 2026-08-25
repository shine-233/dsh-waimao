// ~/.waimao/config.json — the one file every entry point shares (tools, web
// pages, CLI-less setup). Atomic writes, key masking for the browser, and a
// deep-merged default so a partial config file never crashes a run.
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const WAIMAO_DIR = join(homedir(), '.waimao');
export const CONFIG_PATH = join(WAIMAO_DIR, 'config.json');
export const DATA_DIR = join(WAIMAO_DIR, 'data');
export const EXPORT_DIR = join(DATA_DIR, 'exports');

export const DEFAULT_CONFIG = {
  serp: {
    // 'ddg' = DuckDuckGo HTML, keyless. 'serpapi' = SerpAPI, needs a key.
    engine: 'ddg',
    serpapiKey: '',
    perLayer: 10,
    // 大陆网络必填：本地代理地址（Clash 默认 http://127.0.0.1:7890）。
    // 留空则依次尝试环境变量 HTTPS_PROXY/HTTP_PROXY，再不行就直连。
    proxy: '',
  },
  evolution: {
    baseURL: 'http://127.0.0.1:8080',
    apiKey: '',
    instance: '',
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
  },
  // Shared secret the Evolution webhook must present (?token=... or
  // x-webhook-token). Empty means the webhook route refuses everything.
  webhookToken: '',
};

export function ensureDirs() {
  mkdirSync(WAIMAO_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(EXPORT_DIR, { recursive: true, mode: 0o700 });
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? deepMerge(base[key], value)
      : value;
  }
  return out;
}

export function readConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ...DEFAULT_CONFIG };
    }
    throw new Error(`cannot read ${CONFIG_PATH}: ${error?.message ?? error}`);
  }
  let parsed;
  try {
    // Windows 记事本/PowerShell 写出的 UTF-8 常带 BOM，容忍它。
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${error?.message ?? error}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`${CONFIG_PATH} does not hold a JSON object`);
  }
  return deepMerge(DEFAULT_CONFIG, parsed);
}

export function writeConfig(patch) {
  ensureDirs();
  const config = deepMerge(readConfig(), patch);
  try {
    if (lstatSync(CONFIG_PATH).isSymbolicLink()) {
      throw new Error(`${CONFIG_PATH} is a symlink; edit the file it points at instead`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const tmp = join(WAIMAO_DIR, `.config.${unique}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(tmp, CONFIG_PATH);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // the rename failure is the error worth reporting
    }
    throw error;
  }
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // best effort on platforms without POSIX modes
  }
  return config;
}

export function hasKey(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function resolveProxyForSummary(config) {
  const raw = config.serp.proxy ?? '';
  return hasKey(raw) ? String(raw) : '';
}

/** What the browser / agent may know. Never a raw key. */
export function configSummary() {
  const config = readConfig();
  return {
    configFile: CONFIG_PATH,
    serp: {
      engine: config.serp.engine,
      hasSerpapiKey: hasKey(config.serp.serpapiKey),
      perLayer: config.serp.perLayer,
      proxy: resolveProxyForSummary(config),
    },
    evolution: {
      baseURL: config.evolution.baseURL,
      instance: config.evolution.instance,
      ready: hasKey(config.evolution.apiKey) && hasKey(config.evolution.instance),
    },
    deepseek: {
      baseURL: config.deepseek.baseURL,
      model: config.deepseek.model,
      ready: hasKey(config.deepseek.apiKey),
    },
    webhookTokenSet: hasKey(config.webhookToken),
  };
}
