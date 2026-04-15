/**
 * RESERVED FOR SENTRY ANONYMIZATION.
 *
 * This module reads disk volume UUID and motherboard serial. These values
 * MUST NOT be read from outside this file for any other purpose. A future
 * feature that reads them silently breaks the anonymization contract
 * described in internal-reference
 *
 * Do not import this module outside src/main/sentry.ts.
 * Any new call site requires security-reviewer approval.
 */

import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

function execFileAsync(
  cmd: string,
  args: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(cmd, args) as Promise<{ stdout: string; stderr: string }>;
}

export type ClientIdResult = { kind: 'stable'; id: string } | { kind: 'fallback'; id: string };

const MIN_LEN = 6;
const MAX_LEN = 256;

/** Returns true if a retrieved hardware value should be treated as failure. */
export function isSentinelValue(value: string): boolean {
  if (typeof value !== 'string') return true;
  if (value.length < MIN_LEN || value.length > MAX_LEN) return true;
  if (/^0+$/.test(value)) return true;
  if (/^VMware-/i.test(value)) return true;
  if (/^QEMU/i.test(value)) return true;
  return false;
}

/** Compute the stable 32-hex-char client ID from validated inputs. */
export function hashInputs(userUUID: string, diskUUID: string, motherboardSerial: string): string {
  return createHash('sha256')
    .update(userUUID + diskUUID + motherboardSerial)
    .digest('hex')
    .slice(0, 32);
}

/** Produce a per-launch random fallback ID. Never mixes hardware derivative. */
export function makeFallbackId(): string {
  return 'random-' + randomBytes(16).toString('hex');
}

export type Retriever = () => Promise<string>;

async function safeRetrieve(fn: Retriever): Promise<string | null> {
  try {
    const value = await fn();
    if (isSentinelValue(value)) return null;
    return value;
  } catch {
    return null;
  }
}

/**
 * Compute a ClientIdResult for the current session.
 *
 * All-or-nothing semantic: if either retriever throws or returns a sentinel
 * value, we fall back to a per-launch random ID. The fallback is fresh CSPRNG
 * output with no hardware derivative whatsoever.
 */
export async function computeClientId(
  userUUID: string,
  diskRetriever: Retriever,
  moboRetriever: Retriever
): Promise<ClientIdResult> {
  const [disk, mobo] = await Promise.all([
    safeRetrieve(diskRetriever),
    safeRetrieve(moboRetriever),
  ]);
  if (disk === null || mobo === null) {
    return { kind: 'fallback', id: makeFallbackId() };
  }
  return { kind: 'stable', id: hashInputs(userUUID, disk, mobo) };
}

/**
 * Retrieve macOS root volume UUID via `diskutil info /`.
 */
export async function getDiskUUIDMacOS(): Promise<string> {
  const { stdout } = await execFileAsync('/usr/sbin/diskutil', ['info', '/']);
  const re = /Volume UUID:\s+([A-F0-9-]+)/i;
  const match = re.exec(stdout);
  if (!match) throw new Error('Volume UUID not found in diskutil output');
  return match[1];
}

/**
 * Retrieve macOS motherboard serial via `system_profiler SPHardwareDataType`.
 */
export async function getMotherboardSerialMacOS(): Promise<string> {
  const { stdout } = await execFileAsync('/usr/sbin/system_profiler', ['SPHardwareDataType']);
  const re = /Serial Number[^:]*:\s*(\S+)/i;
  const match = re.exec(stdout);
  if (!match) throw new Error('Serial Number not found in system_profiler output');
  return match[1];
}

/**
 * Retrieve Linux root filesystem UUID via findmnt + blkid.
 */
export async function getDiskUUIDLinux(): Promise<string> {
  const { stdout: mntOut } = await execFileAsync('/bin/findmnt', ['-n', '-o', 'SOURCE', '/']);
  const device = mntOut.trim();
  if (!device) throw new Error('findmnt returned empty source for /');
  const { stdout } = await execFileAsync('/sbin/blkid', ['-s', 'UUID', '-o', 'value', device]);
  const uuid = stdout.trim();
  if (!uuid) throw new Error('blkid returned empty UUID');
  return uuid;
}

/**
 * Read the motherboard serial from /sys/class/dmi/id/board_serial.
 * Root-read-only on most distros — unprivileged processes EACCES, which
 * routes to the fallback path in computeClientId.
 */
export async function getMotherboardSerialLinux(): Promise<string> {
  const data = await readFile('/sys/class/dmi/id/board_serial', 'utf8');
  const trimmed = data.trim();
  if (!trimmed) throw new Error('board_serial is empty');
  return trimmed;
}

function parseWmicSerial(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const value = lines.find((l) => l.toLowerCase() !== 'serialnumber');
  if (!value) throw new Error('WMIC output contained no serial value');
  return value;
}

/** Retrieve Windows C: volume serial via WMIC. */
export async function getDiskUUIDWindows(): Promise<string> {
  const { stdout } = await execFileAsync('wmic', [
    'path',
    'Win32_Volume',
    'where',
    "DriveLetter='C:'",
    'get',
    'SerialNumber',
  ]);
  return parseWmicSerial(stdout);
}

/** Retrieve Windows motherboard serial via WMIC BaseBoard. */
export async function getMotherboardSerialWindows(): Promise<string> {
  const { stdout } = await execFileAsync('wmic', ['baseboard', 'get', 'SerialNumber']);
  return parseWmicSerial(stdout);
}

/** Return the pair of platform-appropriate retrievers. */
export function getPlatformRetrievers(platform: NodeJS.Platform | string): {
  disk: Retriever;
  mobo: Retriever;
} {
  switch (platform) {
    case 'darwin':
      return { disk: getDiskUUIDMacOS, mobo: getMotherboardSerialMacOS };
    case 'linux':
      return { disk: getDiskUUIDLinux, mobo: getMotherboardSerialLinux };
    case 'win32':
      return { disk: getDiskUUIDWindows, mobo: getMotherboardSerialWindows };
    default:
      throw new Error(`unsupported platform: ${platform}`);
  }
}
